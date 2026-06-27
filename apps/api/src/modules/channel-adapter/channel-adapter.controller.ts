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
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { ChannelType, RawRequest } from "@gosumo/shared";
import { ChannelAdapterService } from "./channel-adapter.service";
import { WhatsAppAdapter, isStatusUpdateOnly } from "./adapters/whatsapp.adapter";
import { isInstagramStatusOnly } from "./adapters/instagram.adapter";
import { WhatsAppVerifyQueryDto } from "./dto/webhook.dto";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("webhooks")
@Public()
@Controller("webhooks")
export class ChannelAdapterController {
  private readonly logger = new Logger(ChannelAdapterController.name);

  constructor(
    private readonly channelAdapterService: ChannelAdapterService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // WhatsApp — verification challenge (GET)
  // ─────────────────────────────────────────────

  @Get("whatsapp")
  @ApiOperation({
    summary: "WhatsApp webhook verification",
    description:
      "Handles Meta's GET verification challenge. Returns hub.challenge if hub.verify_token matches WHATSAPP_VERIFY_TOKEN env var.",
  })
  @ApiQuery({ name: "hub.mode", required: true })
  @ApiQuery({ name: "hub.challenge", required: true })
  @ApiQuery({ name: "hub.verify_token", required: false })
  @ApiResponse({ status: 200, description: "Challenge accepted" })
  @ApiResponse({ status: 403, description: "Verify token mismatch" })
  handleWhatsAppVerification(
    @Query() query: WhatsAppVerifyQueryDto,
    @Res() res: Response,
  ): void {
    const mode = query["hub.mode"];
    const challenge = query["hub.challenge"];
    const verifyToken = query["hub.verify_token"];

    const expectedToken = this.configService.get<string>("whatsapp.verifyToken", "");

    if (mode === "subscribe" && verifyToken === expectedToken) {
      this.logger.log("WhatsApp webhook verification successful");
      res.status(HttpStatus.OK).send(challenge);
      return;
    }

    this.logger.warn(
      "WhatsApp webhook verification failed: mode=" + mode +
      ", tokenMatch=" + (verifyToken === expectedToken),
    );
    res.status(HttpStatus.FORBIDDEN).json({ message: "Webhook verification failed" });
  }

  // ─────────────────────────────────────────────
  // Instagram — verification challenge (GET)
  // ─────────────────────────────────────────────

  @Get("instagram")
  @ApiOperation({
    summary: "Instagram webhook verification",
    description:
      "Handles Meta's GET verification challenge for Instagram. Same pattern as WhatsApp.",
  })
  @ApiQuery({ name: "hub.mode", required: true })
  @ApiQuery({ name: "hub.challenge", required: true })
  @ApiQuery({ name: "hub.verify_token", required: false })
  @ApiResponse({ status: 200, description: "Challenge accepted" })
  @ApiResponse({ status: 403, description: "Verify token mismatch" })
  handleInstagramVerification(
    @Query() query: WhatsAppVerifyQueryDto,
    @Res() res: Response,
  ): void {
    const mode = query["hub.mode"];
    const challenge = query["hub.challenge"];
    const verifyToken = query["hub.verify_token"];

    // Instagram uses the same or separate verify token
    const expectedToken =
      this.configService.get<string>("instagram.verifyToken", "") ||
      this.configService.get<string>("whatsapp.verifyToken", "");

    if (mode === "subscribe" && verifyToken === expectedToken) {
      this.logger.log("Instagram webhook verification successful");
      res.status(HttpStatus.OK).send(challenge);
      return;
    }

    this.logger.warn(
      "Instagram webhook verification failed: mode=" + mode +
      ", tokenMatch=" + (verifyToken === expectedToken),
    );
    res.status(HttpStatus.FORBIDDEN).json({ message: "Webhook verification failed" });
  }

  // ─────────────────────────────────────────────
  // WhatsApp — inbound webhook (POST)
  // ─────────────────────────────────────────────

  @Post("whatsapp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "WhatsApp inbound webhook",
    description: "Receives WhatsApp Business API message and status events from Meta.",
  })
  @ApiResponse({ status: 200, description: "Webhook acknowledged" })
  @ApiResponse({ status: 401, description: "Invalid signature" })
  async handleWhatsAppWebhook(
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    if (isStatusUpdateOnly(body)) {
      this.logger.debug("WhatsApp status-update webhook received — acknowledged");
      return { status: "ok" };
    }

    const rawReq = this.buildRawRequest(req, headers, body);
    const businessId = (headers["x-business-id"] as string | undefined) ?? "unknown";

    try {
      const normalized = await this.channelAdapterService.handleInboundWebhook(
        ChannelType.WHATSAPP,
        rawReq,
        businessId,
      );

      this.logger.log(
        "Processed WhatsApp message " + normalized.externalId +
        " from " + normalized.sender.externalId,
      );
    } catch (err) {
      this.logger.error(
        "Error processing WhatsApp webhook: " +
        (err instanceof Error ? err.message : String(err)),
      );
    }

    return { status: "ok" };
  }

  // ─────────────────────────────────────────────
  // Generic channel webhook (POST)
  // ─────────────────────────────────────────────

  @Post(":channel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Generic channel webhook",
    description:
      "Inbound webhook for any registered channel adapter. Channel must be a valid ChannelType.",
  })
  @ApiParam({
    name: "channel",
    enum: ChannelType,
    description: "Target channel type (e.g. INSTAGRAM, SMS)",
  })
  @ApiResponse({ status: 200, description: "Webhook acknowledged" })
  @ApiResponse({ status: 400, description: "Unknown channel type" })
  @ApiResponse({ status: 401, description: "Invalid signature" })
  async handleGenericWebhook(
    @Param("channel") channelParam: string,
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const channelType = channelParam.toUpperCase() as ChannelType;

    if (!Object.values(ChannelType).includes(channelType)) {
      throw new BadRequestException(
        'Unknown channel type: "' + channelParam + '". ' +
        "Valid values: " + Object.values(ChannelType).join(", "),
      );
    }

    // Skip status-only updates for Instagram
    if (channelType === ChannelType.INSTAGRAM && isInstagramStatusOnly(body)) {
      this.logger.debug("Instagram status-update webhook received — acknowledged");
      return { status: "ok" };
    }

    const rawReq = this.buildRawRequest(req, headers, body);
    const businessId = (headers["x-business-id"] as string | undefined) ?? "unknown";

    try {
      const normalized = await this.channelAdapterService.handleInboundWebhook(
        channelType,
        rawReq,
        businessId,
      );

      this.logger.log(
        "Processed " + channelType + " message " + normalized.externalId +
        " from " + normalized.sender.externalId,
      );
    } catch (err) {
      this.logger.error(
        "Error processing " + channelType + " webhook: " +
        (err instanceof Error ? err.message : String(err)),
      );
    }

    return { status: "ok" };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private buildRawRequest(
    req: Request,
    headers: Record<string, string>,
    body: unknown,
  ): RawRequest {
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    return {
      headers: normalizedHeaders,
      body,
      rawBody,
      query: req.query as Record<string, string>,
    };
  }
}
