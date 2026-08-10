import {
  Controller, Get, Post, Delete,
  Body, Param, Query, Logger, HttpCode, HttpStatus, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/services/prisma.service';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { randomBytes, createHash } from 'crypto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

/** Bounds on `?limit=`; anything unparseable falls back to the default. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * Clamp a client-supplied `limit` into range.
 *
 * `parseInt` yields NaN for absent or non-numeric input and silently truncates
 * a trailing suffix ("50abc" → 50); both are treated as the default rather than
 * reaching Prisma, where NaN would surface as an opaque query error.
 */
function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  private readonly logger = new Logger(ApiKeysController.name);
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List API keys' })
  async list(@TenantId() tenantId: string, @Query('limit') limit?: string) {
    const take = parseLimit(limit);

    const [keys, total] = await Promise.all([
      this.prisma.api_keys.findMany({
        where: { business_id: tenantId },
        orderBy: { created_at: 'desc' },
        take,
      }),
      this.prisma.api_keys.count({ where: { business_id: tenantId } }),
    ]);

    return {
      data: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        last4: k.last4,
        scopes: k.scopes,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
        expiresAt: k.expires_at,
      })),
      pagination: {
        total,
        limit: take,
        page: 1,
        totalPages: Math.max(1, Math.ceil(total / take)),
      },
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new API key' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateApiKeyDto,
  ) {
    const raw = `gs_${randomBytes(32).toString('hex')}`;
    const prefix = raw.slice(0, 10);
    const last4 = raw.slice(-4);
    const hash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 86400000)
      : null;

    const created = await this.prisma.api_keys.create({
      data: {
        business_id: tenantId,
        name: dto.name,
        prefix,
        last4,
        key_hash: hash,
        scopes: dto.scopes ?? [],
        created_by: user.sub,
        expires_at: expiresAt,
      },
    });

    this.logger.log(`Issued API key ${prefix}… for tenant ${tenantId}`);

    return {
      id: created.id,
      name: created.name,
      prefix,
      last4,
      scopes: created.scopes,
      secret: raw,
      /** @deprecated Use `secret`; kept for callers written against the old shape. */
      key: raw,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      message: 'Copy this key now — it won\'t be shown again.',
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  async revoke(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    // Hard delete: a revoked credential must stop authenticating immediately,
    // so the soft-delete rule that governs business data does not apply here.
    // deleteMany (not delete) keeps business_id in the WHERE clause — deleting
    // by id alone would let one tenant revoke another tenant's key.
    const { count } = await this.prisma.api_keys.deleteMany({
      where: { id, business_id: tenantId },
    });

    if (count === 0) {
      throw new NotFoundException(`API key ${id} not found`);
    }

    this.logger.log(`Revoked API key ${id} for tenant ${tenantId}`);
  }
}
