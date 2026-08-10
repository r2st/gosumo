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
