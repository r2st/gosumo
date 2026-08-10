import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConsentType } from '@prisma/client';
import type { consent_logs } from '@prisma/client';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import type { RealtyConsentRecordedEvent } from '@gosumo/shared';
import { ComplianceRepository } from './compliance.repository';

export interface RecordConsentInput {
  phone: string;
  consentType: ConsentType;
  channel?: string;
  messageId?: string | null;
  source?: string | null;
}

/**
 * ConsentService — the DPDPA consent ledger (business plan §21). Records consent
 * grants and revocations to the append-mostly `consent_logs` table, one row per
 * event. Consent is captured at first interaction (PROCESSING), exchange opt-in
 * (EXCHANGE), and marketing/cadence enrolment (MARKETING).
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly repository: ComplianceRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Grant consent of `consentType` for a phone. Idempotent per (phone, type):
   * when an active consent already exists it is returned untouched (no duplicate
   * ledger row).
   */
  async recordConsent(
    businessId: string,
    input: RecordConsentInput,
  ): Promise<consent_logs> {
    const existing = await this.repository.findActiveConsent(
      businessId,
      input.phone,
      input.consentType,
    );
    if (existing) return existing;

    const entry = await this.repository.createConsent({
      businessId,
      phone: input.phone,
      consentType: input.consentType,
      channel: input.channel ?? 'SYSTEM',
      messageId: input.messageId ?? null,
      source: input.source ?? null,
      granted: true,
    });

    this.emitRecorded(businessId, input.phone, input.consentType, true, entry.channel);
    this.logger.log(
      `Consent ${input.consentType} granted for ${input.phone} (business ${businessId})`,
    );
    return entry;
  }

  /**
   * Revoke consent for a phone. Stamps every matching active consent as revoked
   * (all types when `consentType` is omitted). Returns the number revoked.
   */
  async revokeConsent(
    businessId: string,
    phone: string,
    consentType?: ConsentType,
    channel = 'SYSTEM',
  ): Promise<number> {
    const revoked = await this.repository.revokeAllConsents(businessId, phone, consentType);
    if (revoked > 0) {
      this.emitRecorded(businessId, phone, consentType ?? null, false, channel);
      this.logger.log(
        `Revoked ${revoked} consent(s)${consentType ? ` (${consentType})` : ''} for ${phone}`,
      );
    }
    return revoked;
  }

  /** Full consent history for a phone (newest first). */
  async getHistory(businessId: string, phone: string): Promise<consent_logs[]> {
    return this.repository.listConsents(businessId, phone);
  }

  private emitRecorded(
    businessId: string,
    phone: string,
    consentType: ConsentType | null,
    granted: boolean,
    channel: string,
  ): void {
    const event: RealtyConsentRecordedEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      type: 'realty.consent.recorded',
      phone,
      consentType: consentType ?? 'ALL',
      granted,
      channel,
    };
    this.eventEmitter.emit('realty.consent.recorded', event);
  }
}
