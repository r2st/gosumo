/**
 * RealtyAuditInterceptor unit tests — Phase 7 automatic audit.
 *
 * Covers the self-gating (only mutating realty routes are audited), actor/
 * resource derivation, resource-id resolution (path uuid vs body.id), and the
 * best-effort contract (audit runs on the response tap, never blocks it).
 */

import { firstValueFrom, of } from 'rxjs';
import { AuditAction } from '@gosumo/database';
import { RealtyAuditInterceptor } from './realty-audit.interceptor';

const BIZ = '00000000-0000-4000-a000-000000000001';
const LEAD = '00000000-0000-4000-a000-000000000010';
const USER = '00000000-0000-4000-a000-000000000070';

function makeContext(req: Record<string, unknown>) {
  const res = { setHeader: jest.fn() };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as never;
}

function makeHandler(body: unknown = { id: LEAD }) {
  return { handle: () => of(body) } as never;
}

describe('RealtyAuditInterceptor', () => {
  let audit: { record: jest.Mock };
  let interceptor: RealtyAuditInterceptor;

  beforeEach(() => {
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new RealtyAuditInterceptor(audit as never);
  });

  it('audits a mutating realty route with mapped fields', async () => {
    const req = {
      method: 'PATCH',
      path: `/v1/realty/leads/${LEAD}`,
      tenantId: BIZ,
      user: { sub: USER, email: 'a@b.in' },
      headers: { 'user-agent': 'jest', 'x-correlation-id': 'corr-9' },
      ip: '9.9.9.9',
    };
    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      businessId: BIZ,
      actorType: 'TEAM_MEMBER',
      actorId: USER,
      actorEmail: 'a@b.in',
      action: AuditAction.UPDATE,
      resourceType: 'realty_lead',
      resourceId: LEAD,
      requestId: 'corr-9',
      ipAddress: '9.9.9.9',
      userAgent: 'jest',
    });
  });

  it('does not audit GET (read) requests', async () => {
    const req = { method: 'GET', path: '/v1/realty/leads', tenantId: BIZ, headers: {} };
    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not audit non-realty routes', async () => {
    const req = { method: 'POST', path: '/v1/catalog/items', tenantId: BIZ, headers: {} };
    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips auditing when no tenant context is present', async () => {
    const req = { method: 'POST', path: '/v1/realty/leads', headers: {} };
    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler()));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('derives resource_id from the response body on a create (no path id)', async () => {
    const req = {
      method: 'POST',
      path: '/v1/realty/leads',
      tenantId: BIZ,
      user: { sub: USER },
      headers: {},
    };
    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler({ id: LEAD })));
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: AuditAction.CREATE,
      resourceId: LEAD,
    });
  });

  it('classifies a subject-less request as an API actor', async () => {
    const req = {
      method: 'DELETE',
      path: `/v1/realty/leads/${LEAD}`,
      tenantId: BIZ,
      headers: {},
    };
    await firstValueFrom(interceptor.intercept(makeContext(req), makeHandler(null)));
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      actorType: 'API',
      action: AuditAction.DELETE,
    });
  });
});
