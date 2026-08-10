import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { ContactRepository } from './contact.repository';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * ContactModule — contact management and segmentation.
 *
 * Wraps the existing `clients` table with tagging and adds saved dynamic
 * segments (`segments` table) for grouping contacts by filter criteria.
 */
@Module({
  controllers: [ContactController],
  providers: [ContactService, ContactRepository, PrismaService],
  exports: [ContactService],
})
export class ContactModule {}
