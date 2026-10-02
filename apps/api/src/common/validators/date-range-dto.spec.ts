import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaymentStatsQueryDto } from '../../modules/payment/dto';
import { CalendarQueryDto } from '../../modules/booking/dto';
import { NotificationStatsQueryDto } from '../../modules/notification/dto';

async function errors(DtoClass: new () => object, plain: Record<string, unknown>) {
  const instance = plainToInstance(DtoClass, plain);
  return validate(instance);
}

describe.each([
  ['PaymentStatsQueryDto', PaymentStatsQueryDto],
  ['CalendarQueryDto', CalendarQueryDto],
  ['NotificationStatsQueryDto', NotificationStatsQueryDto],
])('%s date range validation', (_name, DtoClass) => {
  it('accepts empty input (all optional)', async () => {
    expect(await errors(DtoClass, {})).toHaveLength(0);
  });

  it('accepts valid ISO-8601 calendar dates', async () => {
    expect(await errors(DtoClass, { from: '2026-01-01', to: '2026-12-31' })).toHaveLength(0);
  });

  it('rejects an invalid date like Feb 31', async () => {
    const errs = await errors(DtoClass, { from: '2026-02-31' });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a non-date string', async () => {
    const errs = await errors(DtoClass, { from: 'not-a-date' });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a SQL injection attempt', async () => {
    const errs = await errors(DtoClass, { from: "' OR 1=1--" });
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('CalendarQueryDto staffMemberId', () => {
  it('accepts a valid UUID', async () => {
    expect(
      await errors(CalendarQueryDto, { staffMemberId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }),
    ).toHaveLength(0);
  });

  it('rejects an invalid UUID', async () => {
    const errs = await errors(CalendarQueryDto, { staffMemberId: 'not-a-uuid' });
    expect(errs.length).toBeGreaterThan(0);
  });
});
