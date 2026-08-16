import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { RealtyEoiStatus } from '@prisma/client';
import { EoiService } from './eoi.service';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { webhookRawBody } from '../../../common/utils/webhook-verification.util';
import { UuidValidationPipe } from '../../../common/pipes/uuid-validation.pipe';
import { RequestEoiDto, ApproveEoiDto, RejectEoiDto } from '../dto';

/** Express request carrying the raw body (needed for webhook signature checks). */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * RealtyEoiController — the broker console + payment endpoints for EOI (टोकन)
 * tokens. Request → broker approve/reject → link sent → paid. The Razorpay
 * webhook is @Public (verifies its own HMAC signature).
 */
@ApiTags('realty-integrations')
@Controller('realty/integrations/eoi')
export class RealtyEoiController {
  constructor(private readonly eoi: EoiService) {}

  @Post()
  @ApiOperation({ summary: 'Request an EOI (टोकन) token for a qualified lead' })
  @ApiResponse({ status: 201, description: 'Token requested — pending broker approval' })
  async request(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: RequestEoiDto,
  ) {
    return this.eoi.requestEoi(tenantId, dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List EOI token requests' })
  @ApiResponse({ status: 200, description: 'Paginated eoi list for this business' })
  @ApiQuery({ name: 'leadId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: RealtyEoiStatus })
  async list(
    @TenantId() tenantId: string,
    @Query('leadId') leadId?: string,
    @Query('status') status?: RealtyEoiStatus,
  ) {
    return this.eoi.listEoi(tenantId, { leadId, status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an EOI token request' })
  @ApiResponse({ status: 200, description: 'The requested eoi' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'EOI UUID' })
  async get(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.eoi.getEoi(tenantId, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Broker approves the token → generates + sends the payment link' })
  @ApiResponse({ status: 200, description: 'Result of the approve action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'EOI UUID' })
  async approve(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ApproveEoiDto,
  ) {
    return this.eoi.approveEoi(tenantId, id, userId, dto.expiryMinutes);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Broker rejects the token request' })
  @ApiResponse({ status: 200, description: 'Result of the reject action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'EOI UUID' })
  async reject(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RejectEoiDto,
  ) {
    return this.eoi.rejectEoi(tenantId, id, userId, dto.reason);
  }

  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Poll Razorpay and settle the EOI if the link was paid' })
  @ApiResponse({ status: 200, description: 'Result of the reconcile action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'EOI UUID' })
  async reconcile(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.eoi.reconcileEoi(tenantId, id);
  }

  @Public()
  @Post('webhook/razorpay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay payment_link.paid webhook (HMAC-verified)' })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged; the EOI is reconciled' })
  async webhook(
    @Req() req: RawBodyRequest,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing x-razorpay-signature header');
    }
    // No `JSON.stringify(req.body)` fallback — those are not the bytes
    // Razorpay signed. See webhookRawBody().
    const rawBody = webhookRawBody(req);
    if (!rawBody) {
      throw new InternalServerErrorException(
        'Webhook cannot be verified: the raw request body is unavailable',
      );
    }
    return this.eoi.handleRazorpayWebhook(rawBody, signature);
  }
}
