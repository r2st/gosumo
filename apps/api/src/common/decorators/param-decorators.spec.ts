import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentUser, AuthenticatedUser } from './current-user.decorator';
import { TenantId } from './tenant-id.decorator';

/**
 * `@CurrentUser()` and `@TenantId()` are the only sanctioned way a controller
 * learns who is calling and which tenant they belong to — reading either from
 * the request body would let a client forge it. Both must fail closed, so the
 * tests cover the missing-context paths as carefully as the happy ones.
 *
 * `createParamDecorator` hides the factory behind decorator metadata; applying
 * the decorator to a throwaway class is the only way to get at it.
 */
type ParamFactory = (data: unknown, ctx: ExecutionContext) => unknown;

function factoryOf(decorator: (...args: never[]) => ParameterDecorator): ParamFactory {
  class Probe {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    handler(@decorator() _value: unknown): void {}
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
    string,
    { factory: ParamFactory }
  >;
  const [first] = Object.values(args);
  if (!first) throw new Error('decorator registered no param metadata');
  return first.factory;
}

const contextWith = (request: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as ExecutionContext;

const user: AuthenticatedUser = {
  sub: 'user-1',
  businessId: 'biz-1',
  email: 'op@example.com',
  role: 'MANAGER',
  sessionId: 'sess-1',
};

describe('@CurrentUser()', () => {
  const currentUser = factoryOf(CurrentUser as (...args: never[]) => ParameterDecorator);

  it('returns the whole user when no field is named', () => {
    expect(currentUser(undefined, contextWith({ user }))).toEqual(user);
  });

  it('returns just the named field', () => {
    expect(currentUser('email', contextWith({ user }))).toBe('op@example.com');
    expect(currentUser('role', contextWith({ user }))).toBe('MANAGER');
    expect(currentUser('businessId', contextWith({ user }))).toBe('biz-1');
  });

  it('returns undefined for a field the token did not carry', () => {
    const partial = { sub: 'user-1', businessId: 'biz-1', role: 'STAFF' };
    expect(currentUser('sessionId', contextWith({ user: partial }))).toBeUndefined();
  });

  it('rejects a request with no authenticated user', () => {
    expect(() => currentUser(undefined, contextWith({}))).toThrow(UnauthorizedException);
  });

  it('rejects rather than returning undefined when a field is asked for', () => {
    // Returning undefined here would let a controller run untenanted.
    expect(() => currentUser('businessId', contextWith({}))).toThrow(
      'No authenticated user found on request',
    );
  });
});

describe('@TenantId()', () => {
  const tenantId = factoryOf(TenantId as (...args: never[]) => ParameterDecorator);

  it('prefers the tenant the isolation middleware resolved', () => {
    expect(
      tenantId(undefined, contextWith({ tenantId: 'biz-1', user: { businessId: 'biz-2' } })),
    ).toBe('biz-1');
  });

  it('falls back to the JWT claim on middleware-exempt routes', () => {
    expect(tenantId(undefined, contextWith({ user: { businessId: 'biz-2' } }))).toBe(
      'biz-2',
    );
  });

  it('rejects a request carrying no tenant at all', () => {
    expect(() => tenantId(undefined, contextWith({}))).toThrow(UnauthorizedException);
  });

  it('rejects when the user object exists but has no businessId', () => {
    expect(() => tenantId(undefined, contextWith({ user: { sub: 'user-1' } }))).toThrow(
      'Tenant context is missing from request',
    );
  });

  it('rejects an empty-string tenant rather than scoping a query to ""', () => {
    expect(() => tenantId(undefined, contextWith({ tenantId: '' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('ignores its data argument — the decorator takes no options', () => {
    expect(tenantId('anything', contextWith({ tenantId: 'biz-1' }))).toBe('biz-1');
  });
});
