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
import { ChannelType } from "@gosumo/shared";
import { Public } from "../../common/decorators/public.decorator";
import { TenantId } from "../../common/decorators/tenant-id.decorator";
import { ChannelsService } from "./channels.service";
import { ConnectChannelDto } from "./dto";

@Controller("channels")
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);

  constructor(private readonly channelsService: ChannelsService) {}

  @Get()
  async listChannels(@TenantId() businessId: string): Promise<any> {
    return this.channelsService.listChannels(businessId);
  }

  @Post(":channelType/connect")
  async connectChannel(
    @TenantId() businessId: string,
    @Param("channelType") channelTypeParam: string,
    @Body() body: ConnectChannelDto,
  ): Promise<any> {
    const channelType = channelTypeParam.toUpperCase().replace(/-/g, "_") as ChannelType;

    if (!Object.values(ChannelType).includes(channelType)) {
      throw new BadRequestException(
        `Invalid channel type: "${channelTypeParam}". Valid values: ${Object.values(ChannelType).join(", ")}`,
      );
    }

    return this.channelsService.connectChannel(businessId, channelType, body);
  }

  @Delete(":channelId")
  async disconnectChannel(
    @TenantId() businessId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.channelsService.disconnectChannel(businessId, channelId);
  }

  @Post(":channelId/test")
  async testConnection(
    @TenantId() businessId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.channelsService.testConnection(businessId, channelId);
  }

  @Public()
  @Get("webchat/embed/:channelId")
  async getWebChatEmbed(@Param("channelId") channelId: string) {
    // Public endpoint — external websites load the embed script.
    // Pass empty businessId; service will look up by channelId alone.
    return this.channelsService.getWebChatEmbed("", channelId);
  }
}
