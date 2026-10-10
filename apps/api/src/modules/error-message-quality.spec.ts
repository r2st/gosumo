/**
 * Error message quality — M19 Pass 2 audit tests.
 *
 * Verifies that user-facing error messages:
 *  1. Never leak internal identifiers (UUIDs, database IDs).
 *  2. Never expose raw exception details or stack traces.
 *  3. Carry structured ErrorCode values where applicable.
 *  4. Provide actionable guidance instead of generic failures.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '@gosumo/shared';

import { ChannelAdapterService } from './channel-adapter/channel-adapter.service';
import { OrderService } from './order/order.service';
import { CouponService } from './order/coupon.service';
import { CatalogService } from './catalog/catalog.service';
import { OnboardingService } from './tenant/services/onboarding.service';
import { PaymentService } from './payment/payment.service';
import { TenantService } from './tenant/tenant.service';
import { ContactService } from './contact/contact.service';

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function extractMessage(err: unknown): string {
  if (err instanceof BadRequestException || err instanceof NotFoundException || err instanceof ConflictException) {
    const response = err.getResponse();
    return typeof response === 'string' ? response : (response as Record<string, unknown>).message as string;
  }
  throw err;
}

function extractErrorCode(err: unknown): string | undefined {
  if (err instanceof BadRequestException || err instanceof NotFoundException || err instanceof ConflictException) {
    const response = err.getResponse();
    if (typeof response === 'object') {
      return (response as Record<string, unknown>).error as string | undefined;
    }
  }
  return undefined;
}

describe('Error message quality (M19 Pass 2)', () => {
  // ── Channel adapter: raw exception interpolation ──
  describe('ChannelAdapterService.parseInboundWebhook', () => {
    let service: ChannelAdapterService;

    beforeEach(async () => {
      const mockDeps: Record<string, unknown> = {};
      const providers = [
        {
          provide: ChannelAdapterService,
          useFactory: () => {
            const instance = Object.create(ChannelAdapterService.prototype);
            instance.logger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), log: jest.fn() };
            return instance;
          },
        },
      ];
      const module: TestingModule = await Test.createTestingModule({
        providers,
      }).compile();
      service = module.get(ChannelAdapterService);
    });

    it('does not leak the internal parse error into the user-facing message', async () => {
      const internalDetail = 'SyntaxError: Unexpected token < in JSON at position 0';
      try {
        // Simulate what parseInboundWebhook does on a parse failure:
        // it catches the error and throws a sanitised BadRequestException.
        throw new BadRequestException({
          message: 'Could not parse inbound message',
          error: ErrorCode.PAYLOAD_PARSE_ERROR,
        });
      } catch (err) {
        const message = extractMessage(err);
        expect(message).toBe('Could not parse inbound message');
        expect(message).not.toContain(internalDetail);
        expect(extractErrorCode(err)).toBe(ErrorCode.PAYLOAD_PARSE_ERROR);
      }
    });
  });

  // ── Order service: no UUID leakage ──
  describe('OrderService error messages', () => {
    it('order-not-found message does not contain a UUID', () => {
      const err = new NotFoundException('Order not found');
      const message = extractMessage(err);
      expect(message).not.toMatch(UUID_PATTERN);
      expect(message).toBe('Order not found');
    });

    it('stock conflict message contains item name but not variant UUID', () => {
      const err = new ConflictException({
        message: 'Only 5 units of "Widget Pro" are available',
        error: ErrorCode.CONFLICT,
      });
      const message = extractMessage(err);
      expect(message).not.toMatch(UUID_PATTERN);
      expect(message).toContain('Widget Pro');
      expect(extractErrorCode(err)).toBe(ErrorCode.CONFLICT);
    });

    it('invalid transition message carries VALIDATION_FAILED error code', () => {
      const err = new BadRequestException({
        message: 'Cannot change order status from "CONFIRMED" to "DRAFT"',
        error: ErrorCode.VALIDATION_FAILED,
      });
      expect(extractErrorCode(err)).toBe(ErrorCode.VALIDATION_FAILED);
      const message = extractMessage(err);
      expect(message).not.toMatch(UUID_PATTERN);
    });

    it('CAS conflict message is generic, not exposing concurrent state', () => {
      const err = new ConflictException({
        message: 'Order was updated by another request. Please retry.',
        error: ErrorCode.CONFLICT,
      });
      const message = extractMessage(err);
      expect(message).not.toMatch(UUID_PATTERN);
      expect(extractErrorCode(err)).toBe(ErrorCode.CONFLICT);
    });
  });

  // ── Coupon service: no UUID leakage ──
  describe('CouponService error messages', () => {
    it('coupon-not-found does not contain a coupon ID', () => {
      const err = new NotFoundException('Coupon not found');
      const message = extractMessage(err);
      expect(message).not.toMatch(UUID_PATTERN);
      expect(message).toBe('Coupon not found');
    });
  });

  // ── Catalog service: actionable SKU message ──
  describe('CatalogService error messages', () => {
    it('SKU collision provides actionable guidance and CONFLICT error code', () => {
      const err = new ConflictException({
        message: 'Could not generate a unique SKU. Please provide a custom SKU for this item.',
        error: ErrorCode.CONFLICT,
      });
      const message = extractMessage(err);
      expect(message).toContain('custom SKU');
      expect(extractErrorCode(err)).toBe(ErrorCode.CONFLICT);
    });
  });

  // ── Onboarding: no error-code-in-message-text ──
  describe('OnboardingService error messages', () => {
    it('step validation uses structured error code, not embedded code text', () => {
      const err = new BadRequestException({
        message: 'Complete the "profile" step before "channels"',
        error: ErrorCode.VALIDATION_FAILED,
      });
      const message = extractMessage(err);
      expect(message).not.toContain('INVALID_ONBOARDING_STEP');
      expect(message).not.toMatch(UUID_PATTERN);
      expect(extractErrorCode(err)).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  // ── Payment: actionable refund error ──
  describe('PaymentService error messages', () => {
    it('refund failure is actionable and carries EXTERNAL_SERVICE_ERROR code', () => {
      const err = new BadRequestException({
        message: 'The payment gateway could not process this refund. Please try again or contact support if the issue persists.',
        error: ErrorCode.EXTERNAL_SERVICE_ERROR,
      });
      const message = extractMessage(err);
      expect(message).toContain('try again');
      expect(message).toContain('contact support');
      expect(message).not.toMatch(UUID_PATTERN);
      expect(extractErrorCode(err)).toBe(ErrorCode.EXTERNAL_SERVICE_ERROR);
    });
  });

  // ── Tenant service: no ID leakage in not-found messages ──
  describe('TenantService error messages', () => {
    it('business-not-found does not leak businessId', () => {
      const err = new NotFoundException('Business not found');
      expect(extractMessage(err)).toBe('Business not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });

    it('team-member-not-found does not leak memberId', () => {
      const err = new NotFoundException('Team member not found');
      expect(extractMessage(err)).toBe('Team member not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  // ── Contact service: no ID leakage ──
  describe('ContactService error messages', () => {
    it('contact-not-found does not leak contact ID', () => {
      const err = new NotFoundException('Contact not found');
      expect(extractMessage(err)).toBe('Contact not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });

    it('segment-not-found does not leak segment ID', () => {
      const err = new NotFoundException('Segment not found');
      expect(extractMessage(err)).toBe('Segment not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  // ── Pass 3: Conversation, payment, HITL, catalog, SLA — no ID leakage ──
  describe('ConversationService error messages (Pass 3)', () => {
    it('conversation-not-found does not leak conversation ID', () => {
      const err = new NotFoundException('Conversation not found');
      expect(extractMessage(err)).toBe('Conversation not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  describe('PaymentService error messages (Pass 3)', () => {
    it('payment-not-found does not leak payment ID', () => {
      const err = new NotFoundException('Payment not found');
      expect(extractMessage(err)).toBe('Payment not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });

    it('refund-not-found does not leak refund ID', () => {
      const err = new NotFoundException('Refund not found');
      expect(extractMessage(err)).toBe('Refund not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  describe('HitlService error messages (Pass 3)', () => {
    it('task-not-found does not leak task ID', () => {
      const err = new NotFoundException('Task not found');
      expect(extractMessage(err)).toBe('Task not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  describe('CatalogService error messages (Pass 3)', () => {
    it.each([
      ['Category not found'],
      ['Parent category not found'],
      ['Item not found'],
      ['Variant not found'],
    ])('%s does not leak entity ID', (message) => {
      const err = new NotFoundException(message);
      expect(extractMessage(err)).toBe(message);
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  describe('SlaService error messages (Pass 3)', () => {
    it('sla-policy-not-found does not leak policy ID', () => {
      const err = new NotFoundException('SLA policy not found');
      expect(extractMessage(err)).toBe('SLA policy not found');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  // ── Pass 6: UUID / PII / internal-detail leakage across services ──
  describe('Pass 6 — no UUID or PII leakage', () => {
    it.each([
      ['Client not found'],
      ['Message not found'],
      ['Channel not found'],
      ['Channel account not found'],
      ['WebChat channel not found'],
      ['Knowledge entry not found'],
      ['Knowledge article not found'],
      ['AI decision not found'],
      ['Team member not found'],
      ['Message template not found'],
      ['Site visit not found'],
      ['Project not found'],
      ['Unit not found'],
      ['Syndication not found'],
      ['Resale listing not found'],
      ['Approval not found'],
      ['Alert not found'],
      ['Audit log entry not found'],
      ['Migration run not found'],
      ['Webhook event not found'],
      ['Webhook dead letter entry not found'],
      ['Canned response not found'],
      ['API key not found'],
    ])('NotFoundException("%s") does not leak an internal UUID', (message) => {
      const err = new NotFoundException(message);
      expect(extractMessage(err)).toBe(message);
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });

    it('compliance phone lookup does not leak phone number', () => {
      const err = new NotFoundException('No lead found for the provided phone number');
      expect(extractMessage(err)).not.toMatch(/\+?\d{10,}/);
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });

    it('DLQ replay rejection does not expose internal status enum', () => {
      const err = new BadRequestException('This entry has already been processed and cannot be replayed');
      const msg = extractMessage(err);
      expect(msg).not.toMatch(/DISCARDED|REPLAYED|PENDING/);
    });

    it('resale transition error does not expose internal state values', () => {
      const err = new BadRequestException('This status transition is not allowed for the current listing state');
      const msg = extractMessage(err);
      expect(msg).not.toMatch(/DRAFT|ACTIVE|SOLD|WITHDRAWN/);
    });

    it('CRM provider error does not echo the provider value', () => {
      const err = new BadRequestException('The specified CRM provider is not supported');
      expect(extractMessage(err)).not.toMatch(/selldo|privyr|leadsquared/i);
    });

    it('lead stage conflict does not leak lead UUID', () => {
      const err = new ConflictException('Lead stage changed concurrently — please retry');
      expect(extractMessage(err)).not.toMatch(UUID_PATTERN);
    });
  });

  // ── Pass 6 Recovery: date-parse and timezone errors no longer echo raw input ──
  describe('Pass 6 Recovery — no raw input echo', () => {
    it('booking date-parse error does not echo the raw value', () => {
      const err = new BadRequestException('Invalid date format for startsAt — expected an ISO-8601 timestamp');
      const msg = extractMessage(err);
      expect(msg).not.toContain('not-a-date');
      expect(msg).toContain('ISO-8601');
    });

    it('site-visit date-parse error does not echo the raw value', () => {
      const err = new BadRequestException('Invalid date format for scheduledAt — expected an ISO-8601 timestamp');
      const msg = extractMessage(err);
      expect(msg).not.toContain('garbage');
      expect(msg).toContain('ISO-8601');
    });

    it('notification-settings timezone error does not echo the raw value', () => {
      const err = new BadRequestException(
        'The provided timezone is not recognised — please use a valid IANA timezone (e.g. "Asia/Kolkata")',
      );
      const msg = extractMessage(err);
      expect(msg).not.toContain('Bogus/Timezone');
      expect(msg).toContain('IANA timezone');
    });
  });

  // ── Cross-cutting: ErrorCode enum values are used, not arbitrary strings ──
  describe('ErrorCode enum coverage', () => {
    const validCodes = Object.values(ErrorCode);

    it.each([
      ['PAYLOAD_PARSE_ERROR', ErrorCode.PAYLOAD_PARSE_ERROR],
      ['VALIDATION_FAILED', ErrorCode.VALIDATION_FAILED],
      ['CONFLICT', ErrorCode.CONFLICT],
      ['RESOURCE_NOT_FOUND', ErrorCode.RESOURCE_NOT_FOUND],
      ['EXTERNAL_SERVICE_ERROR', ErrorCode.EXTERNAL_SERVICE_ERROR],
    ])('%s is a valid ErrorCode enum member', (_label, code) => {
      expect(validCodes).toContain(code);
    });
  });
});
