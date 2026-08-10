import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { RealtyExchangeService } from './realty-exchange.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateSyndicationDto,
  CloseSyndicationDto,
  DisputeSyndicationDto,
  RateSyndicationDto,
  ListSyndicationsQueryDto,
  MatchLeadQueryDto,
  CreateResaleListingDto,
  UpdateResaleListingDto,
  ListResaleListingsQueryDto,
} from './dto';

/**
 * RealtyExchangeController — the L2 co-broking exchange (blueprint §19).
 * JWT-guarded; @TenantId() supplies the acting businessId. No business logic —
 * validation + delegation only.
 */
@ApiTags('realty-exchange')
@Controller('realty/exchange')
export class RealtyExchangeController {
  constructor(private readonly exchange: RealtyExchangeService) {}

  // ── Syndications ──
  @Post('syndications')
  @ApiOperation({ summary: 'Offer a lead into the exchange (buyer-consent gated)' })
  @ApiResponse({ status: 201, description: 'Syndication OFFERED' })
  async createSyndication(@TenantId() tenantId: string, @Body() dto: CreateSyndicationDto) {
    return this.exchange.createSyndication(tenantId, dto);
  }

  @Get('syndications')
  @ApiOperation({ summary: 'List syndications the tenant is party to' })
  async listSyndications(@TenantId() tenantId: string, @Query() query: ListSyndicationsQueryDto) {
    return this.exchange.listSyndications(tenantId, { state: query.state, role: query.role });
  }

  @Get('syndications/:id')
  @ApiOperation({ summary: 'Get a syndication' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getSyndication(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.exchange.getSyndication(tenantId, id);
  }

  @Post('syndications/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an offered syndication (→ ACCEPTED)' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  async acceptSyndication(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.exchange.acceptSyndication(tenantId, id);
  }

  @Post('syndications/:id/visit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record that the buyer visited (→ VISIT)' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  async recordVisit(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.exchange.recordVisit(tenantId, id);
  }

  @Post('syndications/:id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a syndicated deal; books pool + platform fee (→ CLOSED)' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  async closeSyndication(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CloseSyndicationDto,
  ) {
    return this.exchange.closeSyndication(tenantId, id, dto);
  }

  @Post('syndications/:id/expire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Expire a lapsed syndication (→ EXPIRED)' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  async expireSyndication(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.exchange.expireSyndication(tenantId, id);
  }

  @Post('syndications/:id/dispute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dispute a syndication (→ DISPUTED, unwinds settlement)' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  async disputeSyndication(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: DisputeSyndicationDto,
  ) {
    return this.exchange.disputeSyndication(tenantId, id, dto.reason);
  }

  @Post('syndications/:id/rate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rate the counterparty post-deal; recomputes their reliability' })
  @ApiParam({ name: 'id', description: 'Syndication UUID' })
  async rateSyndication(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RateSyndicationDto,
  ) {
    return this.exchange.rateSyndication(id, tenantId, dto);
  }

  // ── Matching ──
  @Get('leads/:leadId/match')
  @ApiOperation({ summary: 'Match a lead against network supply (fit × reliability)' })
  @ApiParam({ name: 'leadId', description: 'Lead UUID' })
  async matchLead(
    @TenantId() tenantId: string,
    @Param('leadId', UuidValidationPipe) leadId: string,
    @Query() query: MatchLeadQueryDto,
  ) {
    return this.exchange.matchLeadToExchange(tenantId, leadId, {
      limit: query.limit,
      aiRationale: query.aiRationale,
    });
  }

  // ── Reliability ──
  @Get('reliability')
  @ApiOperation({ summary: 'List reliability scores the tenant holds for counterparties' })
  async listReliability(@TenantId() tenantId: string) {
    return this.exchange.listReliabilityScores(tenantId);
  }

  @Post('reliability/:targetBusinessId/recompute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Recompute a member's composite reliability score" })
  @ApiParam({ name: 'targetBusinessId', description: 'Member business UUID to score' })
  async recomputeReliability(
    @Param('targetBusinessId', UuidValidationPipe) targetBusinessId: string,
  ) {
    return this.exchange.calculateReliabilityScore(targetBusinessId);
  }

  // ── Resale listings ──
  @Post('resale-listings')
  @ApiOperation({ summary: 'Create a resale listing (exchange supply)' })
  async createResale(@TenantId() tenantId: string, @Body() dto: CreateResaleListingDto) {
    return this.exchange.createResaleListing(tenantId, dto);
  }

  @Get('resale-listings')
  @ApiOperation({ summary: "List the tenant's resale listings" })
  async listResale(@TenantId() tenantId: string, @Query() query: ListResaleListingsQueryDto) {
    return this.exchange.listResaleListings(tenantId, {
      status: query.status,
      locality: query.locality,
    });
  }

  @Get('resale-listings/:id')
  @ApiOperation({ summary: 'Get a resale listing' })
  @ApiParam({ name: 'id', description: 'Resale listing UUID' })
  async getResale(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.exchange.getResaleListing(tenantId, id);
  }

  @Patch('resale-listings/:id')
  @ApiOperation({ summary: 'Update a resale listing' })
  @ApiParam({ name: 'id', description: 'Resale listing UUID' })
  async updateResale(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateResaleListingDto,
  ) {
    return this.exchange.updateResaleListing(tenantId, id, dto);
  }

  @Delete('resale-listings/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a resale listing' })
  @ApiParam({ name: 'id', description: 'Resale listing UUID' })
  async deleteResale(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.exchange.deleteResaleListing(tenantId, id);
  }
}
