import {
  Controller, Get, Post, Delete,
  Body, Param, Query, Logger, HttpCode, HttpStatus, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/services/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { randomBytes, createHash } from 'crypto';
import { AuditAction, TeamMemberRole } from '@gosumo/database';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import {
  ListApiKeysQueryDto,
  DEFAULT_API_KEY_PAGE_SIZE,
} from './dto/list-api-keys-query.dto';

/** `audit_logs.resource_type` for API-key issuance and revocation. */
export const API_KEY_RESOURCE = 'api_key';

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  private readonly logger = new Logger(ApiKeysController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List API keys' })
  @ApiResponse({ status: 200, description: 'Paginated api key list for this business' })
  async list(@TenantId() tenantId: string, @Query() query: ListApiKeysQueryDto) {
    const take = query.limit ?? DEFAULT_API_KEY_PAGE_SIZE;

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

  // Issuing a key is issuing a credential, so it is gated the same way team
  // membership is. The listing above stays open: it returns prefixes and
  // last-4s, never a secret, and the settings page has to render for whoever
  // opens it.
  @Post()
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiResponse({ status: 201, description: 'The created api key' })
  @ApiResponse({ status: 403, description: 'Only OWNER or MANAGER may issue API keys' })
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

    // A key is a standing credential for the whole tenant, so issuing one is
    // the same class of act as inviting a member — and the row records
    // `created_by` but not the scopes it was asked for at the time, nor
    // anything once it is revoked. Recorded after the insert commits; the
    // secret itself is never written anywhere but the caller's response.
    await this.audit.record({
      businessId: tenantId,
      actorType: 'TEAM_MEMBER',
      actorId: user.sub,
      actorEmail: user.email ?? null,
      action: AuditAction.CREATE,
      resourceType: API_KEY_RESOURCE,
      resourceId: created.id,
      after: {
        name: created.name,
        prefix,
        last4,
        scopes: created.scopes,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
      description: `Issued API key ${prefix}… (${created.name})`,
    });

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
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 204, description: 'Deleted; no content returned' })
  @ApiResponse({ status: 403, description: 'Only OWNER or MANAGER may revoke API keys' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Record UUID' })
  async revoke(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    // Hard delete: a revoked credential must stop authenticating immediately,
    // so the soft-delete rule that governs business data does not apply here.
    // That also means the row is the only record the key ever existed, so it
    // is read (tenant-scoped) before it goes, and the snapshot lands on
    // audit_logs — otherwise "who revoked the CI key, and when" has no answer.
    const existing = await this.prisma.api_keys.findFirst({
      where: { id, business_id: tenantId },
    });
    if (!existing) {
      throw new NotFoundException(`API key ${id} not found`);
    }

    // deleteMany (not delete) keeps business_id in the WHERE clause — deleting
    // by id alone would let one tenant revoke another tenant's key. The count
    // check also covers a concurrent revoke of the same key.
    const { count } = await this.prisma.api_keys.deleteMany({
      where: { id, business_id: tenantId },
    });

    if (count === 0) {
      throw new NotFoundException(`API key ${id} not found`);
    }

    await this.audit.record({
      businessId: tenantId,
      actorType: 'TEAM_MEMBER',
      actorId: user.sub,
      actorEmail: user.email ?? null,
      action: AuditAction.DELETE,
      resourceType: API_KEY_RESOURCE,
      resourceId: id,
      before: {
        name: existing.name,
        prefix: existing.prefix,
        last4: existing.last4,
        scopes: existing.scopes,
        createdBy: existing.created_by,
        expiresAt: existing.expires_at ? existing.expires_at.toISOString() : null,
        lastUsedAt: existing.last_used_at ? existing.last_used_at.toISOString() : null,
      },
      description: `Revoked API key ${existing.prefix}… (${existing.name})`,
    });

    this.logger.log(`Revoked API key ${id} for tenant ${tenantId}`);
  }
}
