/**
 * ComplianceNoticeService unit tests — the DPDPA §5 first-contact notice.
 *
 * Covers: prepend-once semantics (tracked by the `first_contact_notice` marker),
 * the marker write, the business-name fallback, null-message passthrough, the
 * fail-open guarantee (compliance never blocks a reply), and tenant scoping.
 */

import { ConsentType } from '@prisma/client';
import { ComplianceNoticeService } from './compliance-notice.service';
import { buildFirstContactNotice } from './dpdpa.util';

const BIZ = '00000000-0000-4000-a000-000000000001';
const PHONE = '+919876543210';

type RepoMock = {
  findConsentBySource: jest.Mock;
  getBusinessName: jest.Mock;
  createConsent: jest.Mock;
};

describe('ComplianceNoticeService', () => {
  let repo: RepoMock;
  let service: ComplianceNoticeService;

  beforeEach(() => {
    repo = {
      findConsentBySource: jest.fn().mockResolvedValue(null),
      getBusinessName: jest.fn().mockResolvedValue('Acme Realty'),
      createConsent: jest.fn().mockResolvedValue({ id: 'consent-1' }),
    };
    service = new ComplianceNoticeService(repo as never);
  });

  describe('decorateFirstContact', () => {
    it('prepends the notice and records the marker on first contact', async () => {
      const out = await service.decorateFirstContact(BIZ, PHONE, 'Hello!', 'msg-1');

      expect(out).toBe(`${buildFirstContactNotice('Acme Realty')}\n\nHello!`);
      expect(repo.findConsentBySource).toHaveBeenCalledWith(BIZ, PHONE, 'first_contact_notice');
      expect(repo.createConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BIZ,
          phone: PHONE,
          consentType: ConsentType.PROCESSING,
          channel: 'WHATSAPP',
          messageId: 'msg-1',
          source: 'first_contact_notice',
          granted: true,
        }),
      );
    });

    it('is idempotent — a second contact is returned unchanged, no new marker', async () => {
      repo.findConsentBySource.mockResolvedValueOnce({ id: 'existing-marker' });

      const out = await service.decorateFirstContact(BIZ, PHONE, 'Hello again!');

      expect(out).toBe('Hello again!');
      expect(repo.createConsent).not.toHaveBeenCalled();
    });

    it('passes a null message straight through (never fabricates a notice)', async () => {
      const out = await service.decorateFirstContact(BIZ, PHONE, null);
      expect(out).toBeNull();
      expect(repo.findConsentBySource).not.toHaveBeenCalled();
      expect(repo.createConsent).not.toHaveBeenCalled();
    });

    it('falls back to "this brokerage" when the business has no name', async () => {
      repo.getBusinessName.mockResolvedValueOnce(null);
      const out = await service.decorateFirstContact(BIZ, PHONE, 'Hello!');
      expect(out).toContain('this brokerage');
    });

    it('defaults messageId to null when not supplied', async () => {
      await service.decorateFirstContact(BIZ, PHONE, 'Hello!');
      expect(repo.createConsent).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: null }),
      );
    });

    it('fails open — a lookup failure returns the original message (never blocks a reply)', async () => {
      repo.findConsentBySource.mockRejectedValueOnce(new Error('db down'));
      const out = await service.decorateFirstContact(BIZ, PHONE, 'Hello!');
      expect(out).toBe('Hello!');
      expect(repo.createConsent).not.toHaveBeenCalled();
    });

    it('fails open — a marker-write failure still returns the original message', async () => {
      repo.createConsent.mockRejectedValueOnce(new Error('write failed'));
      const out = await service.decorateFirstContact(BIZ, PHONE, 'Hello!');
      expect(out).toBe('Hello!');
    });

    it('scopes the marker lookup + write to the calling business', async () => {
      const other = '00000000-0000-4000-a000-000000000002';
      await service.decorateFirstContact(other, PHONE, 'Hello!');
      expect(repo.findConsentBySource).toHaveBeenCalledWith(other, PHONE, 'first_contact_notice');
      expect(repo.createConsent).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: other }),
      );
    });
  });

  describe('noticeFor', () => {
    it('returns the notice text for the business name', async () => {
      expect(await service.noticeFor(BIZ)).toBe(buildFirstContactNotice('Acme Realty'));
    });

    it('falls back to the generic name when unknown', async () => {
      repo.getBusinessName.mockResolvedValueOnce(null);
      expect(await service.noticeFor(BIZ)).toBe(buildFirstContactNotice('this brokerage'));
    });
  });
});
