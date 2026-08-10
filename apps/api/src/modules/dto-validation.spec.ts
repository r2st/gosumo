/**
 * Request-DTO validation tests.
 *
 * These exercise the DTOs through the *same* ValidationPipe configuration
 * main.ts installs globally (whitelist + forbidNonWhitelisted + transform
 * with implicit conversion), so what passes here is what the running API
 * accepts. Testing the decorators in isolation would not catch pipe-level
 * behaviour such as implicit string→number coercion.
 *
 * Focus is on the boundaries that carry real consequence:
 *  - Money is paise, integer (root rule #4). A float or a rupee-scaled value
 *    reaching the gateway means charging the wrong amount.
 *  - Unknown properties are rejected, not silently accepted.
 *  - Identifier fields are UUIDs, so they cannot smuggle other shapes.
 */

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import {
  CreatePaymentLinkDto,
  InitiateRefundDto,
  CreateInvoiceDto,
  ConfirmCODDto,
} from './payment/dto';
import { CreateCategoryDto, CreateVariantDto } from './catalog/dto';
import { UpdateContactDto } from './contact/dto';
import { CreateOrderDto } from './order/dto';
import { SnoozeConversationDto, AssignConversationDto } from './conversation/dto';
import { CreateLeadDto } from './realty-leads/dto';
import { DispatchNotificationDto } from './notification/dto';
import { CreateBookingDto } from './booking/dto';

/** The exact pipe configuration from main.ts. */
function productionPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
}

function meta(metatype: unknown): ArgumentMetadata {
  return { type: 'body', metatype: metatype as ArgumentMetadata['metatype'] };
}

/** Run a payload through the pipe; resolves with the transformed DTO. */
async function validate<T>(metatype: unknown, payload: unknown): Promise<T> {
  return (await productionPipe().transform(payload, meta(metatype))) as T;
}

/** Assert the pipe rejects a payload, returning the messages for inspection. */
async function expectRejected(metatype: unknown, payload: unknown): Promise<string[]> {
  try {
    await productionPipe().transform(payload, meta(metatype));
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as {
      message: string | string[];
    };
    return Array.isArray(response.message) ? response.message : [response.message];
  }
  throw new Error('Expected the payload to be rejected, but it passed validation');
}

const CLIENT_ID = '00000000-0000-4000-a000-000000000001';
const ORDER_ID = '00000000-0000-4000-a000-000000000002';
const TXN_ID = '00000000-0000-4000-a000-000000000003';

// ─────────────────────────────────────────────
// Money — paise, integer, positive
// ─────────────────────────────────────────────

describe('Money DTOs enforce integer paise', () => {
  const base = { clientId: CLIENT_ID, orderId: ORDER_ID };

  it('accepts a valid integer paise amount', async () => {
    const dto = await validate<CreatePaymentLinkDto>(CreatePaymentLinkDto, {
      ...base,
      amountPaise: 100050,
    });
    expect(dto.amountPaise).toBe(100050);
  });

  it('rejects a fractional amount — paise is the smallest unit', async () => {
    // 499.99 here almost certainly means someone passed rupees.
    const messages = await expectRejected(CreatePaymentLinkDto, {
      ...base,
      amountPaise: 499.99,
    });
    expect(messages.join(' ')).toMatch(/amountPaise/);
  });

  it('rejects a negative amount', async () => {
    await expectRejected(CreatePaymentLinkDto, { ...base, amountPaise: -5000 });
  });

  it('rejects zero and sub-rupee amounts below the ₹1 floor', async () => {
    await expectRejected(CreatePaymentLinkDto, { ...base, amountPaise: 0 });
    await expectRejected(CreatePaymentLinkDto, { ...base, amountPaise: 99 });
  });

  it('rejects a non-numeric amount', async () => {
    await expectRejected(CreatePaymentLinkDto, { ...base, amountPaise: 'lots' });
  });

  it('rejects a missing amount rather than defaulting it', async () => {
    await expectRejected(CreatePaymentLinkDto, { ...base });
  });

  it('rejects a fractional refund amount', async () => {
    await expectRejected(InitiateRefundDto, {
      transactionId: TXN_ID,
      amountPaise: 250.5,
      reason: 'Customer changed their mind',
    });
  });

  it('rejects a fractional COD collected amount', async () => {
    await expectRejected(ConfirmCODDto, {
      orderId: ORDER_ID,
      amountPaise: 1999.99,
    });
  });

  it('rejects a fractional invoice line unit price', async () => {
    await expectRejected(CreateInvoiceDto, {
      clientId: CLIENT_ID,
      lineItems: [{ description: 'Consulting', quantity: 1, unitAmountPaise: 499.5 }],
    });
  });

  it('accepts a large amount without overflowing to a float', async () => {
    // ₹10,00,000 — well within a business's realistic invoice range.
    const dto = await validate<CreatePaymentLinkDto>(CreatePaymentLinkDto, {
      ...base,
      amountPaise: 100000000,
    });
    expect(Number.isInteger(dto.amountPaise)).toBe(true);
    expect(dto.amountPaise).toBe(100000000);
  });
});

// ─────────────────────────────────────────────
// Unknown properties
// ─────────────────────────────────────────────

describe('DTOs reject unknown properties', () => {
  it('rejects an injected businessId on a payment link', async () => {
    // The tenant comes from the JWT via @TenantId(); a body-supplied one
    // must never be accepted, even to be ignored.
    const messages = await expectRejected(CreatePaymentLinkDto, {
      clientId: CLIENT_ID,
      amountPaise: 10000,
      businessId: '00000000-0000-4000-a000-0000000000ff',
    });
    expect(messages.join(' ')).toMatch(/businessId/);
  });

  it('rejects an injected status field on a contact update', async () => {
    await expectRejected(UpdateContactDto, {
      name: 'Priya',
      deleted_at: null,
    });
  });

  it('strips a __proto__ key arriving as parsed JSON without polluting anything', async () => {
    // An object literal's `__proto__:` sets the prototype rather than an own
    // key, so this must be built the way a real request body is — through
    // JSON.parse, which does create an own "__proto__" property.
    //
    // Note the contract: the pipe does NOT raise forbidNonWhitelisted for
    // this key, it silently drops it. That is safe, but it means the
    // rejection path is not what protects us here — the stripping is. Pinning
    // both halves so a future transformer change cannot quietly start
    // carrying the key through.
    const payload = JSON.parse('{"name":"Sarees","__proto__":{"polluted":"yes"}}') as unknown;

    const dto = await validate<CreateCategoryDto>(CreateCategoryDto, payload);

    expect(dto).toBeInstanceOf(CreateCategoryDto);
    expect(dto.name).toBe('Sarees');
    expect(JSON.parse(JSON.stringify(dto))).toEqual({ name: 'Sarees' });
    expect((dto as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Identifiers and string bounds
// ─────────────────────────────────────────────

describe('DTOs constrain identifiers and string lengths', () => {
  it('rejects a non-UUID client id', async () => {
    const messages = await expectRejected(CreatePaymentLinkDto, {
      clientId: 'not-a-uuid',
      amountPaise: 10000,
    });
    expect(messages.join(' ')).toMatch(/clientId/);
  });

  it('rejects a SQL-ish string in a UUID field', async () => {
    await expectRejected(CreatePaymentLinkDto, {
      clientId: "' OR 1=1 --",
      amountPaise: 10000,
    });
  });

  it('rejects a category name past its max length', async () => {
    await expectRejected(CreateCategoryDto, { name: 'x'.repeat(256) });
  });

  it('accepts a category name at exactly the max length', async () => {
    const dto = await validate<CreateCategoryDto>(CreateCategoryDto, {
      name: 'x'.repeat(255),
    });
    expect(dto.name).toHaveLength(255);
  });

  it('rejects an empty required name', async () => {
    await expectRejected(CreateCategoryDto, { name: '' });
  });

  it('rejects a description past the 500-char payment limit', async () => {
    await expectRejected(CreatePaymentLinkDto, {
      clientId: CLIENT_ID,
      amountPaise: 10000,
      description: 'x'.repeat(501),
    });
  });

  it('keeps optional fields optional', async () => {
    const dto = await validate<CreatePaymentLinkDto>(CreatePaymentLinkDto, {
      clientId: CLIENT_ID,
      amountPaise: 10000,
    });
    expect(dto.description).toBeUndefined();
    expect(dto.orderId).toBeUndefined();
  });

  it('rejects a negative variant stock quantity', async () => {
    await expectRejected(CreateVariantDto, {
      name: 'Large',
      pricePaise: 49900,
      stockQuantity: -1,
    });
  });
});

// ─────────────────────────────────────────────
// Nested arrays — validation must recurse
// ─────────────────────────────────────────────

describe('Nested line-item validation recurses into the array', () => {
  const base = { clientId: CLIENT_ID, paymentMethod: 'COD' };

  it('accepts a well-formed order', async () => {
    const dto = await validate<CreateOrderDto>(CreateOrderDto, {
      ...base,
      items: [{ itemId: ORDER_ID, quantity: 2 }],
    });
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0]).toBeInstanceOf(Object);
    expect(dto.items[0]?.quantity).toBe(2);
  });

  it('rejects an empty item list', async () => {
    // An order with no lines would total zero and still reach the gateway.
    await expectRejected(CreateOrderDto, { ...base, items: [] });
  });

  it('rejects a bad nested item even when the outer shape is valid', async () => {
    const messages = await expectRejected(CreateOrderDto, {
      ...base,
      items: [{ itemId: 'not-a-uuid', quantity: 1 }],
    });
    expect(messages.join(' ')).toMatch(/itemId/);
  });

  it('rejects a zero or negative nested quantity', async () => {
    await expectRejected(CreateOrderDto, { ...base, items: [{ itemId: ORDER_ID, quantity: 0 }] });
    await expectRejected(CreateOrderDto, { ...base, items: [{ itemId: ORDER_ID, quantity: -3 }] });
  });

  it('rejects a fractional nested quantity', async () => {
    await expectRejected(CreateOrderDto, { ...base, items: [{ itemId: ORDER_ID, quantity: 1.5 }] });
  });

  it('rejects an unknown key inside a nested item', async () => {
    await expectRejected(CreateOrderDto, {
      ...base,
      items: [{ itemId: ORDER_ID, quantity: 1, unitPrice: 1 }],
    });
  });

  it('rejects a non-array items value', async () => {
    await expectRejected(CreateOrderDto, { ...base, items: { itemId: ORDER_ID, quantity: 1 } });
  });
});

// ─────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────

describe('Enum fields reject values outside the enum', () => {
  it('rejects an unknown payment method', async () => {
    const messages = await expectRejected(CreateOrderDto, {
      clientId: CLIENT_ID,
      items: [{ itemId: ORDER_ID, quantity: 1 }],
      paymentMethod: 'FREE',
    });
    expect(messages.join(' ')).toMatch(/paymentMethod/);
  });

  it('rejects a lowercase variant of a valid enum member', async () => {
    // Enum comparison is exact; a case-insensitive match would let
    // unintended values through.
    await expectRejected(CreateOrderDto, {
      clientId: CLIENT_ID,
      items: [{ itemId: ORDER_ID, quantity: 1 }],
      paymentMethod: 'cod',
    });
  });

  it('rejects a missing required enum', async () => {
    await expectRejected(DispatchNotificationDto, { clientId: CLIENT_ID });
  });

  it('rejects an unknown notification channel', async () => {
    await expectRejected(DispatchNotificationDto, {
      clientId: CLIENT_ID,
      channel: 'CARRIER_PIGEON',
    });
  });

  it('rejects an unknown lead source', async () => {
    await expectRejected(CreateLeadDto, {
      whatsappPhone: '+919876543210',
      source: 'TELEPATHY',
    });
  });
});

// ─────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────

describe('Date fields require a parseable ISO-8601 instant', () => {
  it('accepts an ISO-8601 UTC instant', async () => {
    const dto = await validate<SnoozeConversationDto>(SnoozeConversationDto, {
      snoozeUntil: '2026-09-01T10:30:00.000Z',
    });
    expect(dto.snoozeUntil).toBe('2026-09-01T10:30:00.000Z');
  });

  it('rejects a free-text date', async () => {
    // "tomorrow" would become an Invalid Date and schedule a wake that never
    // fires, silently stranding the conversation.
    await expectRejected(SnoozeConversationDto, { snoozeUntil: 'tomorrow' });
  });

  it('lets an impossible calendar date through, which JS rolls forward', async () => {
    // Documenting a real gap rather than asserting a fix: @IsDateString()
    // checks ISO-8601 *format*, not calendar validity, so 31 February is
    // accepted and `new Date()` rolls it to 3 March. Callers that build a
    // Date from this field get a silently different day. Closing it would
    // need a custom calendar-aware validator applied across every date
    // field; pinned here so the behaviour is at least known and a future
    // fix has a test to flip.
    const dto = await validate<SnoozeConversationDto>(SnoozeConversationDto, {
      snoozeUntil: '2026-02-31T00:00:00Z',
    });
    expect(dto.snoozeUntil).toBe('2026-02-31T00:00:00Z');
    expect(new Date(dto.snoozeUntil).getUTCMonth()).toBe(2); // March, not February
  });

  it('rejects a numeric epoch in a date-string field', async () => {
    await expectRejected(SnoozeConversationDto, { snoozeUntil: 1788200000000 });
  });

  it('rejects a booking start that is not a date', async () => {
    await expectRejected(CreateBookingDto, {
      clientId: CLIENT_ID,
      startAt: 'next tuesday',
      durationMinutes: 30,
    });
  });
});

// ─────────────────────────────────────────────
// Numeric bounds on scheduling input
// ─────────────────────────────────────────────

describe('Booking duration stays within its declared bounds', () => {
  const base = { clientId: CLIENT_ID, startAt: '2026-09-01T10:30:00.000Z' };

  it('accepts a duration inside the range', async () => {
    const dto = await validate<CreateBookingDto>(CreateBookingDto, {
      ...base,
      durationMinutes: 30,
    });
    expect(dto.durationMinutes).toBe(30);
  });

  it('rejects a duration below the 5-minute floor', async () => {
    await expectRejected(CreateBookingDto, { ...base, durationMinutes: 1 });
  });

  it('rejects a duration beyond a single day', async () => {
    await expectRejected(CreateBookingDto, { ...base, durationMinutes: 1441 });
  });

  it('rejects a fractional duration', async () => {
    await expectRejected(CreateBookingDto, { ...base, durationMinutes: 30.5 });
  });

  it('accepts the exact boundary values', async () => {
    await expect(validate(CreateBookingDto, { ...base, durationMinutes: 5 })).resolves.toBeDefined();
    await expect(
      validate(CreateBookingDto, { ...base, durationMinutes: 1440 }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────
// Identity fields on the realty lead path
// ─────────────────────────────────────────────

describe('Lead identity fields', () => {
  const valid = { whatsappPhone: '+919876543210', source: 'WHATSAPP' };

  it('rejects an empty phone — it is the lead identity', async () => {
    await expectRejected(CreateLeadDto, { ...valid, whatsappPhone: '' });
  });

  it('rejects a phone past the column width', async () => {
    await expectRejected(CreateLeadDto, { ...valid, whatsappPhone: '+9198765432101234567890' });
  });

  it('rejects a malformed email', async () => {
    await expectRejected(CreateLeadDto, { ...valid, email: 'priya@@example' });
  });

  it('rejects a non-UUID assigned agent', async () => {
    await expectRejected(CreateLeadDto, { ...valid, assignedAgentId: 'agent-7' });
  });

  it('rejects an injected businessId on a lead', async () => {
    await expectRejected(CreateLeadDto, { ...valid, businessId: CLIENT_ID });
  });
});

describe('Conversation assignment', () => {
  it('rejects a non-UUID assignee', async () => {
    await expectRejected(AssignConversationDto, { assigneeId: 'me' });
  });
});
