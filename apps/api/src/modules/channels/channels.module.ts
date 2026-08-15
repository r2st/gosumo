import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ChannelsService } from "./channels.service";
import { ChannelsController } from "./channels.controller";

@Module({
  imports: [ConfigModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
