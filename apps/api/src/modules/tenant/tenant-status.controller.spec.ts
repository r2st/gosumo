/**
 * TenantController — suspend / activate.
 *
 * Both routes are OWNER-gated and now write to audit_logs (G002). The service
 * attributes the row to whoever it is handed; the controller is the only place
 * that knows who that is, so what is pinned here is that the JWT subject and
 * email reach the service rather than being dropped on the way through.
 */

import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';

const OWNER: AuthenticatedUser = {
  sub: OWNER_ID,
  businessId: BUSINESS_ID,
  role: 'OWNER',
  email: 'owner@example.com',
};

describe('TenantController suspend/activate', () => {
  let controller: TenantController;
  let tenantService: { suspendBusiness: jest.Mock; activateBusiness: jest.Mock };

  beforeEach(() => {
    tenantService = {
      suspendBusiness: jest.fn().mockResolvedValue({ is_active: false }),
      activateBusiness: jest.fn().mockResolvedValue({ is_active: true }),
    };
    controller = new TenantController(
      tenantService as unknown as TenantService,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('hands the acting owner to suspendBusiness', async () => {
    await controller.suspend(BUSINESS_ID, OWNER, { reason: 'non-payment' });

    expect(tenantService.suspendBusiness).toHaveBeenCalledWith(
      BUSINESS_ID,
      { reason: 'non-payment' },
      { id: OWNER_ID, email: 'owner@example.com' },
    );
  });

  it('hands the acting owner to activateBusiness', async () => {
    await controller.activate(BUSINESS_ID, OWNER);

    expect(tenantService.activateBusiness).toHaveBeenCalledWith(BUSINESS_ID, {
      id: OWNER_ID,
      email: 'owner@example.com',
    });
  });

  it('passes a null email when the token carries none', async () => {
    const { email: _email, ...noEmail } = OWNER;

    await controller.activate(BUSINESS_ID, noEmail);

    expect(tenantService.activateBusiness).toHaveBeenCalledWith(BUSINESS_ID, {
      id: OWNER_ID,
      email: null,
    });
  });
});
