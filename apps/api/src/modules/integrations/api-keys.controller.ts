import {
  Controller, Get, Post, Delete,
  Body, Param, Query, Logger, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/services/prisma.service';
import { randomBytes, createHash } from 'crypto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  private readonly logger = new Logger(ApiKeysController.name);
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List API keys' })
  async list(@TenantId() tenantId: string, @Query('limit') limit?: string) {
    // Check if api_keys table exists, otherwise return empty
    try {
      const keys = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT id, name, prefix, created_at, last_used_at, expires_at
         FROM api_keys WHERE business_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        tenantId,
        parseInt(limit ?? '100', 10),
      );
      return {
        data: keys.map((k: any) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          createdAt: k.created_at,
          lastUsedAt: k.last_used_at,
          expiresAt: k.expires_at,
        })),
        pagination: { total: keys.length, limit: parseInt(limit ?? '100', 10), page: 1, totalPages: 1 },
      };
    } catch {
      // Table may not exist yet
      return { data: [], pagination: { total: 0, limit: 100, page: 1, totalPages: 1 } };
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create a new API key' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateApiKeyDto,
  ) {
    const raw = `gs_${randomBytes(32).toString('hex')}`;
    const prefix = raw.slice(0, 10) + '…';
    const hash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 86400000).toISOString()
      : null;

    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO api_keys (id, business_id, name, prefix, key_hash, created_by, expires_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6::timestamptz)`,
        tenantId, dto.name, prefix, hash, user.sub, expiresAt,
      );
    } catch (e: any) {
      // Table may not exist — create it
      if (e.code === '42P01') {
        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS api_keys (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            business_id UUID NOT NULL,
            name VARCHAR(255) NOT NULL,
            prefix VARCHAR(20) NOT NULL,
            key_hash VARCHAR(64) NOT NULL,
            created_by UUID,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_used_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ
          )
        `);
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO api_keys (id, business_id, name, prefix, key_hash, created_by, expires_at)
           VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6::timestamptz)`,
          tenantId, dto.name, prefix, hash, user.sub, expiresAt,
        );
      } else {
        throw e;
      }
    }

    return {
      name: dto.name,
      prefix,
      key: raw,
      expiresAt,
      message: 'Copy this key now — it won\'t be shown again.',
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  async revoke(@TenantId() tenantId: string, @Param('id') id: string) {
    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM api_keys WHERE id = $1::uuid AND business_id = $2`,
        id, tenantId,
      );
    } catch {
      // Table may not exist — that's fine
    }
  }
}
