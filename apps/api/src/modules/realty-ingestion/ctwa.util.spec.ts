/**
 * CTWA referral parsing unit tests.
 *
 * `parseCtwaReferral` is the first thing that runs when a buyer taps a
 * WhatsApp ad, so its attribution fallbacks decide what campaign a lead is
 * credited to for the rest of its life. Each rung of the two fallback chains
 * is exercised here — Meta populates the `referral` block inconsistently
 * across ad formats, so the lower rungs are the normal case, not the edge one.
 */

import { LeadSource } from '@gosumo/shared';
import { parseCtwaReferral, type WhatsAppReferral } from './ctwa.util';

const PHONE = '+919876543210';

describe('parseCtwaReferral', () => {
  it('returns null without a phone — there is nothing to key a lead on', () => {
    expect(parseCtwaReferral({ phone: '' })).toBeNull();
  });

  describe('sub_source fallback chain (headline → source_id → source_type)', () => {
    it('prefers the ad headline when Meta sends one', () => {
      const referral: WhatsAppReferral = {
        headline: '3BHK in Whitefield from ₹1.2Cr',
        source_id: '120210000000000',
        source_type: 'ad',
      };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.subSource).toBe(
        '3BHK in Whitefield from ₹1.2Cr',
      );
    });

    it('falls back to source_id when the headline is absent', () => {
      const referral: WhatsAppReferral = {
        source_id: '120210000000000',
        source_type: 'ad',
      };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.subSource).toBe(
        '120210000000000',
      );
    });

    it('falls back to source_type when both headline and source_id are absent', () => {
      const referral: WhatsAppReferral = { source_type: 'post' };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.subSource).toBe('post');
    });

    it('leaves sub_source undefined when the referral carries no identifiers', () => {
      const referral: WhatsAppReferral = { body: 'Tap to chat with us' };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.subSource).toBeUndefined();
    });

    it('skips empty-string rungs rather than crediting a blank campaign', () => {
      const referral: WhatsAppReferral = {
        headline: '',
        source_id: '',
        source_type: 'ad',
      };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.subSource).toBe('ad');
    });
  });

  describe('listing_ref fallback chain (source_url → ctwa_clid)', () => {
    it('prefers the ad landing URL', () => {
      const referral: WhatsAppReferral = {
        source_url: 'https://builder.example/projects/skyline',
        ctwa_clid: 'clid_abc123',
      };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.listingRef).toBe(
        'https://builder.example/projects/skyline',
      );
    });

    it('falls back to the click id when there is no landing URL', () => {
      const referral: WhatsAppReferral = { ctwa_clid: 'clid_abc123' };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.listingRef).toBe(
        'clid_abc123',
      );
    });

    it('leaves listing_ref undefined when neither is present', () => {
      const referral: WhatsAppReferral = { headline: 'Just an ad' };

      expect(parseCtwaReferral({ phone: PHONE, referral })?.listingRef).toBeUndefined();
    });
  });

  it('still produces a CTWA candidate for a plain click-to-chat (no referral)', () => {
    const candidate = parseCtwaReferral({
      phone: PHONE,
      name: 'Rahul',
      conversationId: 'conv-1',
      clientId: 'client-1',
    });

    expect(candidate).toEqual({
      whatsappPhone: PHONE,
      source: LeadSource.CTWA,
      subSource: undefined,
      listingRef: undefined,
      name: 'Rahul',
      conversationId: 'conv-1',
      clientId: 'client-1',
      // No referral means no raw payload to retain — not an empty object.
      raw: undefined,
    });
  });

  it('retains the raw referral payload when one is present', () => {
    const referral: WhatsAppReferral = {
      source_url: 'https://builder.example/skyline',
      media_type: 'image',
      body: 'Book a site visit today',
    };

    expect(parseCtwaReferral({ phone: PHONE, referral })?.raw).toEqual({ referral });
  });
});
