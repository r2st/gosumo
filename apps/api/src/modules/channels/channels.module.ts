import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ChannelsService } from "./channels.service";
import { ChannelsController } from "./channels.controller";
import { PrismaService } from "../../common/services/prisma.service";

@Module({
  imports: [ConfigModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, PrismaService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
