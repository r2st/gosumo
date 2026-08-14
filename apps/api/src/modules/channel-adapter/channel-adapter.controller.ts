import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Headers,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ChannelType, RawRequest } from '@gosumo/shared';
import { ChannelAdapterService } from './channel-adapter.service';
import { WhatsAppAdapter, isStatusUpdateOnly } from './adapters/whatsapp.adapter';
import { InstagramAdapter, isNonMessageEventOnly } from './adapters/instagram.adapter';
import { WhatsAppVerifyQueryDto } from './dto/webhook.dto';
import { Public } from '../../common/decorators/public.decorator';
import { secretsMatch } from '../../common/utils/webhook-verification.util';

/**
 * Webhook endpoints for all channel adapters.
 *
 * All webhook routes respond immediately with HTTP 200 — Meta and most
 * other channel providers require a sub-5-second response or they retry.
 * Actual processing (event emission, conversation update, AI pipeline)
 * happens asynchronously via the event bus.
 *
 * Routes:
 *   GET  /webhooks/whatsapp          — Meta webhook verification challenge
 *   POST /webhooks/whatsapp          — WhatsApp inbound message webhook
 *   POST /webhooks/:channel          — Generic webhook for other channels
 */
@ApiTags('webhooks')
@Public()
@Controller('webhooks')
export class ChannelAdapterController {
  private readonly logger = new Logger(ChannelAdapterController.name);

  constructor(
    private readonly channelAdapterService: ChannelAdapterService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    private readonly instagramAdapter: InstagramAdapter,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // WhatsApp — verification challenge (GET)
  // ─────────────────────────────────────────────

  /**
   * Meta webhook verification endpoint.
   *
   * When you configure a webhook URL in the Meta Developer Console, Meta
   * sends a GET request with hub.mode, hub.verify_token, and hub.challenge.
   * This handler validates the verify token and echoes back the challenge.
   *
   * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#configure-webhooks-product
   */
  @Get('whatsapp')
  @ApiOperation({
    summary: 'WhatsApp webhook verification',
    description:
      "Handles Meta's GET verification challenge. Returns hub.challenge if hub.verify_token matches WHATSAPP_VERIFY_TOKEN env var.",
  })
  @ApiQuery({ name: 'hub.mode', required: true })
  @ApiQuery({ name: 'hub.challenge', required: true })
  @ApiQuery({ name: 'hub.verify_token', required: false })
  @ApiResponse({ status: 200, description: 'Challenge accepted — echoes back hub.challenge' })
  @ApiResponse({ status: 403, description: 'Verify token mismatch' })
  handleWhatsAppVerification(
    @Query() query: WhatsAppVerifyQueryDto,
    @Res() res: Response,
  ): void {
    const mode = query['hub.mode'];
    const challenge = query['hub.challenge'];
    const verifyToken = query['hub.verify_token'];

    const expectedToken = this.configService.get<string>('whatsapp.verifyToken', '');

    // secretsMatch, not `===`: with the token unconfigured, `expectedToken` is
    // '' and a caller who simply omits hub.verify_token compares equal, passing
    // Meta's ownership challenge against an endpoint they do not own.
    const tokenMatch = secretsMatch(verifyToken, expectedToken);

    if (mode === 'subscribe' && tokenMatch) {
      this.logger.log('WhatsApp webhook verification successful');
      res.status(HttpStatus.OK).send(challenge);
      return;
    }

    this.logger.warn(
      `WhatsApp webhook verification failed: mode=${mode}, tokenMatch=${tokenMatch}`,
    );
    res.status(HttpStatus.FORBIDDEN).json({ message: 'Webhook verification failed' });
  }

  // ─────────────────────────────────────────────
  // WhatsApp — inbound webhook (POST)
  // ─────────────────────────────────────────────

  /**
   * WhatsApp inbound message webhook.
   *
   * Meta delivers message events, status updates, and error notifications
   * via this endpoint. We must always respond 200 immediately to prevent
   * Meta from retrying the request.
   *
   * The X-Hub-Signature-256 header is validated before any processing.
   * Status-only payloads (no inbound messages) are acknowledged and
   * discarded — status updates are handled separately by the message module.
   *
   * businessId is resolved from the phone_number_id in the payload by
   * looking up the registered channel account. For now we derive it from
   * the header x-business-id set by the API gateway — this is replaced by
   * a proper lookup once the tenant/channel-account modules are wired up.
   */
  @Post('whatsapp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'WhatsApp inbound webhook',
    description: 'Receives WhatsApp Business API message and status events from Meta.',
  })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleWhatsAppWebhook(
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    // Status-only payloads (e.g. delivered/read receipts) don't need parsing
    if (isStatusUpdateOnly(body)) {
      this.logger.debug('WhatsApp status-update webhook received — acknowledged');
      return { status: 'ok' };
    }

    const rawReq = this.buildRawRequest(req, headers, body);

    // businessId lookup: in production this comes from matching the
    // phone_number_id in the payload to a channel_account record.
    // The x-business-id header is set by the API gateway during routing.
    const businessId = (headers['x-business-id'] as string | undefined) ?? 'unknown';

    try {
      // Batch form: Meta packs several messages into one POST whenever a
      // customer sends them in quick succession or a backlog is redelivered.
      const handled = await this.channelAdapterService.handleInboundWebhookBatch(
        ChannelType.WHATSAPP,
        rawReq,
        businessId,
      );

      this.logger.log(
        `Processed ${handled.length} WhatsApp message(s): ` +
          handled.map((m) => `${m.externalId} from ${m.sender.externalId}`).join(', '),
      );
    } catch (err) {
      // Log the error but still return 200 — we don't want Meta to retry
      this.logger.error(
        `Error processing WhatsApp webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // Instagram — verification challenge (GET)
  // ─────────────────────────────────────────────

  /**
   * Meta webhook verification endpoint for Instagram.
   *
   * Mirrors the WhatsApp handshake but delegates the token check to the
   * Instagram adapter (which owns the configured INSTAGRAM_VERIFY_TOKEN).
   */
  @Get('instagram')
  @ApiOperation({
    summary: 'Instagram webhook verification',
    description:
      "Handles Meta's GET verification challenge. Returns hub.challenge if hub.verify_token matches INSTAGRAM_VERIFY_TOKEN env var.",
  })
  @ApiQuery({ name: 'hub.mode', required: true })
  @ApiQuery({ name: 'hub.challenge', required: true })
  @ApiQuery({ name: 'hub.verify_token', required: false })
  @ApiResponse({ status: 200, description: 'Challenge accepted — echoes back hub.challenge' })
  @ApiResponse({ status: 403, description: 'Verify token mismatch' })
  handleInstagramVerification(
    @Query() query: WhatsAppVerifyQueryDto,
    @Res() res: Response,
  ): void {
    const challenge = this.instagramAdapter.verifyChallenge(
      query['hub.mode'],
      query['hub.verify_token'],
      query['hub.challenge'],
    );

    if (challenge !== null) {
      res.status(HttpStatus.OK).send(challenge);
      return;
    }

    res.status(HttpStatus.FORBIDDEN).json({ message: 'Webhook verification failed' });
  }

  // ─────────────────────────────────────────────
  // Instagram — inbound webhook (POST)
  // ─────────────────────────────────────────────

  /**
   * Instagram inbound message webhook.
   *
   * Meta delivers DM events, postbacks, reactions, message echoes, and read
   * receipts here. We always respond 200 immediately to avoid retries. Echo
   * and read-receipt-only payloads are acknowledged and discarded.
   *
   * The X-Hub-Signature-256 header is validated before any processing.
   */
  @Post('instagram')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Instagram inbound webhook',
    description: 'Receives Instagram Messaging API message and read events from Meta.',
  })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleInstagramWebhook(
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    // Echo / read-receipt-only payloads don't need parsing
    if (isNonMessageEventOnly(body)) {
      this.logger.debug('Instagram non-message webhook received — acknowledged');
      return { status: 'ok' };
    }

    const rawReq = this.buildRawRequest(req, headers, body);
    const businessId = (headers['x-business-id'] as string | undefined) ?? 'unknown';

    try {
      // Same batching as WhatsApp — one Meta POST, many messaging events.
      const handled = await this.channelAdapterService.handleInboundWebhookBatch(
        ChannelType.INSTAGRAM,
        rawReq,
        businessId,
      );

      this.logger.log(
        `Processed ${handled.length} Instagram message(s): ` +
          handled.map((m) => `${m.externalId} from ${m.sender.externalId}`).join(', '),
      );
    } catch (err) {
      // Log the error but still return 200 — we don't want Meta to retry
      this.logger.error(
        `Error processing Instagram webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // Generic channel webhook (POST)
  // ─────────────────────────────────────────────

  /**
   * Generic webhook endpoint for any registered channel.
   *
   * The :channel path parameter must be a valid ChannelType enum value
   * (e.g. INSTAGRAM, SMS, WEB_CHAT, EMAIL). The registered adapter for
   * that channel handles signature validation and parsing.
   *
   * This allows new channels to be added without adding a new route —
   * just register the adapter in the module and the routing works automatically.
   */
  @Post(':channel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generic channel webhook',
    description:
      'Inbound webhook for any registered channel adapter. Channel must be a valid ChannelType.',
  })
  @ApiParam({
    name: 'channel',
    enum: ChannelType,
    description: 'Target channel type (e.g. INSTAGRAM, SMS)',
  })
  @ApiResponse({ status: 200, description: 'Webhook acknowledged' })
  @ApiResponse({ status: 400, description: 'Unknown channel type' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  async handleGenericWebhook(
    @Param('channel') channelParam: string,
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const channelType = channelParam.toUpperCase() as ChannelType;

    if (!Object.values(ChannelType).includes(channelType)) {
      throw new BadRequestException(
        `Unknown channel type: "${channelParam}". ` +
          `Valid values: ${Object.values(ChannelType).join(', ')}`,
      );
    }

    const rawReq = this.buildRawRequest(req, headers, body);
    const businessId = (headers['x-business-id'] as string | undefined) ?? 'unknown';

    try {
      const normalized = await this.channelAdapterService.handleInboundWebhook(
        channelType,
        rawReq,
        businessId,
      );

      this.logger.log(
        `Processed ${channelType} message ${normalized.externalId} ` +
          `from ${normalized.sender.externalId}`,
      );
    } catch (err) {
      this.logger.error(
        `Error processing ${channelType} webhook: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Build a RawRequest from an Express Request, normalizing headers to
   * lowercase strings and attaching the raw body buffer if present.
   *
   * NestJS sets `req.rawBody` when `bodyParser.raw()` or the rawBody option
   * is configured. We fall back to undefined if it's not available.
   */
  private buildRawRequest(
    req: Request,
    headers: Record<string, string>,
    body: unknown,
  ): RawRequest {
    // Express header values can be string | string[] — normalize to string
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }

    // rawBody is set by NestJS when rawBody: true in NestFactory.create()
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    return {
      headers: normalizedHeaders,
      body,
      rawBody,
      query: req.query as Record<string, string>,
    };
  }
}
