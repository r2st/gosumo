import { Injectable, Logger } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import { ComplianceRepository } from './compliance.repository';
import { buildFirstContactNotice, withFirstContactNotice } from './dpdpa.util';

/** Provenance marker recorded on the consent ledger once the notice is delivered. */
const NOTICE_SOURCE = 'first_contact_notice';

/**
 * ComplianceNoticeService — injects the DPDPA first-contact data-processing notice
 * into the first AI message sent to a buyer (business plan §21). Idempotent: the
 * notice is prepended exactly once per phone, tracked by a `first_contact_notice`
 * marker on the append-mostly consent ledger. Wired into the realty AI loop as an
 * optional dependency, so it is a no-op in unit contexts that don't provide it.
 */
@Injectable()
export class ComplianceNoticeService {
  private readonly logger = new Logger(ComplianceNoticeService.name);

  constructor(private readonly repository: ComplianceRepository) {}

  /**
   * Decorate an outbound message with the first-contact notice when it is the
   * first message to this phone. Returns the (possibly prefixed) message and
   * records the notice marker. On any failure it returns the original message so
   * compliance never blocks a reply.
   */
  async decorateFirstContact(
    businessId: string,
    phone: string,
    message: string | null,
    messageId?: string | null,
  ): Promise<string | null> {
    if (message == null) return message;
    try {
      const alreadySent = Boolean(
        await this.repository.findConsentBySource(businessId, phone, NOTICE_SOURCE),
      );
      if (alreadySent) return message;

      const businessName = (await this.repository.getBusinessName(businessId)) ?? 'this brokerage';
      const decorated = withFirstContactNotice(message, businessName, false);

      await this.repository.createConsent({
        businessId,
        phone,
        consentType: ConsentType.PROCESSING,
        channel: 'WHATSAPP',
        messageId: messageId ?? null,
        source: NOTICE_SOURCE,
        granted: true,
      });
      this.logger.debug(`Prepended first-contact notice for ${phone} (business ${businessId})`);
      return decorated;
    } catch (err) {
      this.logger.error(
        `Failed to decorate first-contact notice for ${phone}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return message;
    }
  }

  /** The notice text for a business (used by callers that compose their own send). */
  async noticeFor(businessId: string): Promise<string> {
    const name = (await this.repository.getBusinessName(businessId)) ?? 'this brokerage';
    return buildFirstContactNotice(name);
  }
}
