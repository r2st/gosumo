/**
 * ComplianceController unit tests — the DPDPA REST surface (business plan §21).
 *
 * The controller holds no business logic; these tests pin the contract that
 * matters for tenant safety: the @TenantId()-supplied businessId (never a body
 * field) is what reaches each service, and the right service method is called.
 */

import { ComplianceController } from './compliance.controller';

const TENANT = '00000000-0000-4000-a000-00000000000a';
const PHONE = '+919876543210';

describe('ComplianceController', () => {
  let compliance: {
    dataRequest: jest.Mock;
    correction: jest.Mock;
    erasure: jest.Mock;
    getSettings: jest.Mock;
    updateSettings: jest.Mock;
    complianceReport: jest.Mock;
  };
  let consent: { getHistory: jest.Mock };
  let retention: { runForBusiness: jest.Mock };
  let controller: ComplianceController;

  beforeEach(() => {
    compliance = {
      dataRequest: jest.fn().mockResolvedValue({ found: true }),
      correction: jest.fn().mockResolvedValue({ id: 'lead-1' }),
      erasure: jest.fn().mockResolvedValue({ erased: true }),
      getSettings: jest.fn().mockResolvedValue({ retentionMonths: 24 }),
      updateSettings: jest.fn().mockResolvedValue({ retentionMonths: 12 }),
      complianceReport: jest.fn().mockResolvedValue({ businessId: TENANT }),
    };
    consent = { getHistory: jest.fn().mockResolvedValue([{ id: 'c-1' }]) };
    retention = { runForBusiness: jest.fn().mockResolvedValue({ leadsAnonymized: 0 }) };
    controller = new ComplianceController(compliance as never, consent as never, retention as never);
  });

  it('dataRequest forwards the tenant + phone', async () => {
    await controller.dataRequest(TENANT, PHONE);
    expect(compliance.dataRequest).toHaveBeenCalledWith(TENANT, PHONE);
  });

  it('correction forwards the tenant + dto', async () => {
    const dto = { phone: PHONE, name: 'Ravi' };
    await controller.correction(TENANT, dto as never);
    expect(compliance.correction).toHaveBeenCalledWith(TENANT, dto);
  });

  it('erasure passes the REQUEST reason (system-initiated retention uses its own path)', async () => {
    await controller.erasure(TENANT, { phone: PHONE } as never);
    expect(compliance.erasure).toHaveBeenCalledWith(TENANT, PHONE, 'REQUEST');
  });

  it('consentHistory returns { phone, consents } scoped to the tenant', async () => {
    const res = await controller.consentHistory(TENANT, PHONE);
    expect(consent.getHistory).toHaveBeenCalledWith(TENANT, PHONE);
    expect(res).toEqual({ phone: PHONE, consents: [{ id: 'c-1' }] });
  });

  it('getSettings forwards the tenant', async () => {
    await controller.getSettings(TENANT);
    expect(compliance.getSettings).toHaveBeenCalledWith(TENANT);
  });

  it('updateSettings forwards the tenant + dto', async () => {
    const dto = { retentionMonths: 12 };
    await controller.updateSettings(TENANT, dto as never);
    expect(compliance.updateSettings).toHaveBeenCalledWith(TENANT, dto);
  });

  it('report forwards the tenant', async () => {
    await controller.report(TENANT);
    expect(compliance.complianceReport).toHaveBeenCalledWith(TENANT);
  });

  it('runRetention runs the sweep for the calling tenant only', async () => {
    await controller.runRetention(TENANT);
    expect(retention.runForBusiness).toHaveBeenCalledWith(TENANT);
  });
});
