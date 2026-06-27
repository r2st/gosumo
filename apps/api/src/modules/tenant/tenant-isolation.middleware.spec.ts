import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import {
  TenantIsolationMiddleware,
  TenantScopedRequest,
} from './tenant-isolation.middleware';

const BUSINESS_A = '11111111-1111-1111-1111-111111111111';
const BUSINESS_B = '22222222-2222-2222-2222-222222222222';

/** Build a minimal JWT with the given payload (header.payload.signature). */
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

function makeReq(overrides: Partial<TenantScopedRequest> = {}): TenantScopedRequest {
  return {
    originalUrl: '/v1/tenant/profile',
    headers: {},
    body: {},
    query: {},
    params: {},
    ...overrides,
  } as TenantScopedRequest;
}

describe('TenantIsolationMiddleware', () => {
  let middleware: TenantIsolationMiddleware;
  let next: jest.Mock;
  const res = {} as never;

  beforeEach(() => {
    middleware = new TenantIsolationMiddleware();
    next = jest.fn();
  });

  it('attaches tenant context from request.user and calls next', () => {
    const req = makeReq({ user: { businessId: BUSINESS_A } });

    middleware.use(req, res, next);

    expect(req.tenantId).toBe(BUSINESS_A);
    expect(req.tenantContext).toEqual({ businessId: BUSINESS_A });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to decoding the bearer token payload', () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${makeJwt({ businessId: BUSINESS_A, sub: 'u1' })}` },
    });

    middleware.use(req, res, next);

    expect(req.tenantId).toBe(BUSINESS_A);
    expect(next).toHaveBeenCalled();
  });

  it('throws UnauthorizedException when no tenant can be resolved', () => {
    const req = makeReq();
    expect(() => middleware.use(req, res, next)).toThrow(UnauthorizedException);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks a forged cross-tenant businessId in the body', () => {
    const req = makeReq({
      user: { businessId: BUSINESS_A },
      body: { businessId: BUSINESS_B, foo: 'bar' },
    });

    expect(() => middleware.use(req, res, next)).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks a forged cross-tenant businessId in the query', () => {
    const req = makeReq({
      user: { businessId: BUSINESS_A },
      query: { businessId: BUSINESS_B },
    });

    expect(() => middleware.use(req, res, next)).toThrow(ForbiddenException);
  });

  it('allows a matching businessId in the body', () => {
    const req = makeReq({
      user: { businessId: BUSINESS_A },
      body: { businessId: BUSINESS_A },
    });

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it.each([
    '/v1/webhooks/whatsapp',
    '/v1/auth/login',
    '/v1/health',
    '/v1/docs',
  ])('skips enforcement for exempt path %s', (originalUrl) => {
    const req = makeReq({ originalUrl });
    middleware.use(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBeUndefined();
  });

  it('does not treat a path that merely starts with an exempt word as exempt', () => {
    const req = makeReq({ originalUrl: '/v1/authorizations' });
    expect(() => middleware.use(req, res, next)).toThrow(UnauthorizedException);
  });

  it('ignores a malformed bearer token and reports missing tenant', () => {
    const req = makeReq({ headers: { authorization: 'Bearer not-a-jwt' } });
    expect(() => middleware.use(req, res, next)).toThrow(UnauthorizedException);
  });
});
