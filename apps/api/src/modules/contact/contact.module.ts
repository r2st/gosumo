import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { ContactRepository } from './contact.repository';
import { SegmentRoutingService } from './segment-routing.service';

/**
 * ContactModule — contact management and segmentation.
 *
 * Wraps the existing `clients` table with tagging and adds saved dynamic
 * segments (`segments` table) for grouping contacts by filter criteria.
 *
 * `SegmentRoutingService` is exported on its own, separate from
 * `ContactService`: `ai-engine` needs the routing decision on the inbound path
 * of every message and nothing else this module offers, and importing the whole
 * contact service into the pipeline would make the AI's hot path depend on
 * every endpoint the contacts screen happens to grow.
 */
@Module({
  controllers: [ContactController],
  providers: [ContactService, ContactRepository, SegmentRoutingService],
  exports: [ContactService, SegmentRoutingService],
})
export class ContactModule {}
