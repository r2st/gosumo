/**
 * `PATCH /business/settings` used to be read-modify-write on a JSONB column:
 * read the whole `profile`, spread the patch over `profile.settings` in
 * process, write the whole `profile` back. Every concurrent write to that
 * column was lost, and `profile` has more than one writer — `suspendBusiness`
 * and `activateBusiness` stamp `suspendedAt`/`suspendedReason` into it the same
 * way. So a manager saving office hours while ops suspended the business could
 * restore the profile the suspension had just marked, leaving a business
 * inactive with no record of why. Two managers on the settings screen is the
 * ordinary version: one saves office hours, the other saves a greeting a moment
 * later, and the office hours are gone with nothing in any log.
 *
 * These tests pin the two halves of the fix: the merge is expressed as one
 * statement Postgres evaluates (so there is no window), and the controller is
 * no longer the thing doing the merging.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { TenantRepository } from './tenant.repository';
import { TenantService } from './tenant.service';
import { BusinessController } from './business.controller';
import { SubscriptionService } from './services/subscription.service';
import { PrismaService } from '../../common/services/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';

const BUSINESS = '00000000-0000-4000-8000-000000000001';

describe('TenantRepository.mergeProfileSettings', () => {
  let queryRaw: jest.Mock;
  let repository: TenantRepository;

  beforeEach(() => {
    queryRaw = jest.fn().mockResolvedValue([{ settings: { greeting: 'hi' } }]);
    repository = new TenantRepository({ $queryRaw: queryRaw } as unknown as PrismaService);
  });

  /** The SQL text, with the tagged template's interpolations stripped out. */
  function sql(): string {
    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    return strings.join(' ').replace(/\s+/g, ' ').trim();
  }

  it('merges inside the UPDATE rather than reading the row first', async () => {
    await repository.mergeProfileSettings(BUSINESS, { greeting: 'hi' });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sql()).toContain('UPDATE businesses');
    // `||` is the merge, and it reads `profile -> 'settings'` inside the same
    // statement — which is what makes it atomic. A merge computed in JS and
    // passed in whole would show up here as a bare assignment.
    expect(sql()).toContain("COALESCE(profile -> 'settings', '{}'::jsonb) ||");
  });

  it('writes only the settings key, leaving the rest of profile alone', async () => {
    await repository.mergeProfileSettings(BUSINESS, { greeting: 'hi' });

    // jsonb_set targets `{settings}`; `suspendedAt` and every other profile key
    // is untouched by construction, not by the caller remembering to copy it.
    expect(sql()).toContain("jsonb_set(");
    expect(sql()).toContain("'{settings}'");
  });

  it('passes the patch as a bound parameter, not as interpolated SQL', async () => {
    await repository.mergeProfileSettings(BUSINESS, { greeting: "it's fine" });

    const args = queryRaw.mock.calls[0] as unknown[];
    // Tagged template: [strings, ...values]. The patch travels as a value.
    expect(args.slice(1)).toContain(JSON.stringify({ greeting: "it's fine" }));
  });

  it('stamps updated_at, which a raw statement would otherwise leave stale', async () => {
    await repository.mergeProfileSettings(BUSINESS, { greeting: 'hi' });

    // Prisma applies @updatedAt client-side, so raw SQL bypasses it entirely.
    expect(sql()).toContain('updated_at = NOW()');
  });

  it('scopes the update to a live business', async () => {
    await repository.mergeProfileSettings(BUSINESS, { greeting: 'hi' });

    expect(sql()).toContain('WHERE id =');
    expect(sql()).toContain('deleted_at IS NULL');
  });

  it('returns the merged settings the database produced', async () => {
    queryRaw.mockResolvedValue([{ settings: { greeting: 'hi', officeHoursEnabled: true } }]);

    await expect(repository.mergeProfileSettings(BUSINESS, { greeting: 'hi' })).resolves.toEqual({
      greeting: 'hi',
      officeHoursEnabled: true,
    });
  });

  it('returns an empty object when the row had no settings yet', async () => {
    queryRaw.mockResolvedValue([{ settings: null }]);

    await expect(repository.mergeProfileSettings(BUSINESS, {})).resolves.toEqual({});
  });

  it('returns null when the update matched no row', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(repository.mergeProfileSettings(BUSINESS, { greeting: 'hi' })).resolves.toBeNull();
  });
});

describe('TenantService.updateProfileSettings', () => {
  let repository: { mergeProfileSettings: jest.Mock; findBusinessById: jest.Mock };
  let emitter: { emit: jest.Mock };
  let service: TenantService;

  beforeEach(() => {
    repository = {
      mergeProfileSettings: jest.fn().mockResolvedValue({ greeting: 'hi' }),
      findBusinessById: jest
        .fn()
        .mockResolvedValue({ id: BUSINESS, profile: { settings: { greeting: 'old' } } }),
    };
    emitter = { emit: jest.fn() };
    service = new TenantService(
      repository as unknown as TenantRepository,
      emitter as unknown as EventEmitter2,
      { record: jest.fn() } as unknown as AuditLogService,
    );
  });

  it('delegates the merge to the database and returns its result', async () => {
    await expect(
      service.updateProfileSettings(BUSINESS, { greeting: 'hi' }),
    ).resolves.toEqual({ greeting: 'hi' });

    expect(repository.mergeProfileSettings).toHaveBeenCalledWith(BUSINESS, {
      greeting: 'hi',
    });
  });

  it('announces exactly the keys that moved', async () => {
    await service.updateProfileSettings(BUSINESS, {
      greeting: 'hi',
      officeHoursEnabled: true,
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      'business.settings.updated',
      expect.objectContaining({
        businessId: BUSINESS,
        changedFields: ['greeting', 'officeHoursEnabled'],
      }),
    );
  });

  it('writes nothing and announces nothing for an empty patch', async () => {
    await expect(service.updateProfileSettings(BUSINESS, {})).resolves.toEqual({
      greeting: 'old',
    });

    expect(repository.mergeProfileSettings).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('reports a missing business rather than a silent no-op', async () => {
    repository.mergeProfileSettings.mockResolvedValue(null);

    await expect(
      service.updateProfileSettings(BUSINESS, { greeting: 'hi' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BusinessController.updateSettings', () => {
  it('does no reading or merging of its own', async () => {
    const tenantService = {
      updateProfileSettings: jest.fn().mockResolvedValue({ defaultGreeting: 'hi' }),
    };
    const prisma = {
      businesses: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    };
    const controller = new BusinessController(
      tenantService as unknown as TenantService,
      {} as unknown as SubscriptionService,
      prisma as unknown as PrismaService,
    );

    const dto = { defaultGreeting: 'hi' } as UpdateBusinessSettingsDto;
    await expect(controller.updateSettings(BUSINESS, dto)).resolves.toEqual({
      defaultGreeting: 'hi',
    });

    expect(tenantService.updateProfileSettings).toHaveBeenCalledWith(BUSINESS, {
      defaultGreeting: 'hi',
    });
    // The read-modify-write is gone, not merely narrowed: the controller no
    // longer reads the row, and no longer writes the whole profile column.
    expect(prisma.businesses.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.businesses.update).not.toHaveBeenCalled();
  });
});
