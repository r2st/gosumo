import { Module } from "@nestjs/common";
import { AuditLogService } from "../../common/services/audit-log.service";
import { ConfigModule } from "@nestjs/config";
import { ChannelsService } from "./channels.service";
import { ChannelsController } from "./channels.controller";

@Module({
  imports: [ConfigModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, AuditLogService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
