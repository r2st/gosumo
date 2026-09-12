import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Logger,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from "@nestjs/swagger";
import { ChannelType } from "@gosumo/shared";
import { Public } from "../../common/decorators/public.decorator";
import { TenantId } from "../../common/decorators/tenant-id.decorator";
import { CurrentUser, AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ChannelsService } from "./channels.service";
import type { ChannelResponse } from "./channels.service";

/** Cursor-shaped envelope returned by the channel list endpoint. */
interface ChannelListResponse {
  data: ChannelResponse[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
}
import { ConnectChannelDto } from "./dto";
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthThrottle } from '../auth/auth-throttle.decorator';
import { TeamMemberRole } from '@gosumo/database';

/**
 * ChannelsController — connect, inspect and disconnect a business's messaging
 * channels.
 *
 * All routes sit behind the global JwtAuthGuard and are tenant-scoped via
 * `@TenantId()`, except the web-chat embed lookup, which external sites fetch
 * anonymously by widget id.
 */
@ApiTags("channels")
@Controller("channels")
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);

  constructor(private readonly channelsService: ChannelsService) {}

  @Get()
  @ApiOperation({
    summary: "List the connected channels for the authenticated business",
  })
  @ApiResponse({
    status: 200,
    description:
      "Cursor envelope of channel accounts. Credential values are masked to a set flag and last4.",
  })
  async listChannels(@TenantId() businessId: string): Promise<ChannelListResponse> {
    return this.channelsService.listChannels(businessId);
  }

  @Post(":channelType/connect")
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: "Connect a channel, or re-connect an existing one" })
  @ApiParam({
    name: "channelType",
    description:
      "Channel to connect. Case-insensitive, hyphens accepted (e.g. `web-chat`).",
    enum: Object.values(ChannelType),
  })
  @ApiResponse({ status: 201, description: "The connected channel account" })
  @ApiResponse({ status: 400, description: "Unrecognised channel type" })
  async connectChannel(
    @TenantId() businessId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param("channelType") channelTypeParam: string,
    @Body() body: ConnectChannelDto,
  ): Promise<ChannelResponse> {
    const channelType = channelTypeParam.toUpperCase().replace(/-/g, "_") as ChannelType;

    if (!Object.values(ChannelType).includes(channelType)) {
      throw new BadRequestException(
        `Invalid channel type: "${channelTypeParam}". Valid values: ${Object.values(ChannelType).join(", ")}`,
      );
    }

    return this.channelsService.connectChannel(businessId, channelType, body, {
      id: user.sub,
      email: user.email ?? null,
    });
  }

  @Delete(":channelId")
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({
    summary: "Disconnect a channel",
    description: "Soft delete — the channel row is retained with `deleted_at` set.",
  })
  @ApiParam({ name: "channelId", description: "Channel account UUID" })
  @ApiResponse({ status: 200, description: "Disconnection result" })
  @ApiResponse({ status: 404, description: "Not found, or not visible to this business" })
  async disconnectChannel(
    @TenantId() businessId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param("channelId") channelId: string,
  ) {
    return this.channelsService.disconnectChannel(businessId, channelId, {
      id: user.sub,
      email: user.email ?? null,
    });
  }

  @Post(":channelId/test")
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({
    summary: "Probe a connected channel's stored credentials",
    description:
      "Performs a live call against the provider and reports reachability and round-trip latency.",
  })
  @ApiParam({ name: "channelId", description: "Channel account UUID" })
  @ApiResponse({
    status: 201,
    description: "Probe result, including reachability failures",
  })
  @ApiResponse({ status: 404, description: "Not found, or not visible to this business" })
  async testConnection(
    @TenantId() businessId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.channelsService.testConnection(businessId, channelId);
  }

  @Public()
  // Reachable by anyone, takes a caller-supplied id, and hits the database on
  // every call. Without a ceiling this is an anonymous handle on a Postgres
  // that is shared with another service — a token bounds every other read path
  // in this API, and this route had nothing in its place.
  @AuthThrottle('webchat-embed')
  @Get("webchat/embed/:channelId")
  @ApiOperation({
    summary: "Get the web-chat widget embed snippet",
    description:
      "Public — external sites fetch this by widget id. Returns only the widget config and script tag, never credentials. Rate-limited per caller IP.",
  })
  @ApiParam({ name: "channelId", description: "Web-chat channel account UUID" })
  @ApiResponse({ status: 200, description: "Widget id, config and embed snippet" })
  @ApiResponse({ status: 404, description: "Not found, or not visible to this business" })
  @ApiResponse({ status: 429, description: "Too many requests from this address" })
  async getWebChatEmbed(@Param("channelId") channelId: string) {
    // Public endpoint — external websites load the embed script.
    // Pass empty businessId; service will look up by channelId alone.
    return this.channelsService.getWebChatEmbed("", channelId);
  }
}
