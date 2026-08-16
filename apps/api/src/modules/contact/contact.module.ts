import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { ContactRepository } from './contact.repository';
import { SegmentRoutingService } from './segment-routing.service';
import { ContactMergeService } from './merge/contact-merge.service';
import { ContactMergeRepository } from './merge/contact-merge.repository';
import { AuditLogService } from '../../common/services/audit-log.service';

/**
 * ContactModule — contact management, segmentation, and duplicate merging.
 *
 * Wraps the existing `clients` table with tagging and adds saved dynamic
 * segments (`segments` table) for grouping contacts by filter criteria.
 *
 * `SegmentRoutingService` is exported on its own, separate from
 * `ContactService`: `ai-engine` needs the routing decision on the inbound path
 * of every message and nothing else this module offers, and importing the whole
 * contact service into the pipeline would make the AI's hot path depend on
 * every endpoint the contacts screen happens to grow.
 *
 * `ContactMergeRepository` is the one place in the codebase that writes across
 * thirteen other modules' tables. It is here rather than in each owning module
 * because a merge has to be one transaction — a merge half-applied leaves
 * conversations pointing at a retired contact while orders still point at the
 * live one, which is a state no screen renders and no sweep repairs. See that
 * file's header.
 *
 * `AuditLogService` is provided locally, as `conversation` and `tenant` do: it
 * is a stateless writer over the globally-provided `PrismaService`.
 */
@Module({
  controllers: [ContactController],
  providers: [
    ContactService,
    ContactRepository,
    SegmentRoutingService,
    ContactMergeService,
    ContactMergeRepository,
    AuditLogService,
  ],
  exports: [ContactService, SegmentRoutingService, ContactMergeService],
})
export class ContactModule {}
