/**
 * CrmPushService unit tests. Repository, leads/billing services, EventEmitter2,
 * and the three adapters are mocked. Covers the Developer-tier gate, the
 * no-connection short-circuit, multi-CRM push with success/failure events, the
 * lead-lifecycle listeners, and connect/verify.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { RealtyIntegrationProvider } from '@prisma/client';
import type { realty_integration_connections } from '@prisma/client';

import { CrmPushService } from './crm-push.service';
import { RealtyIntegrationsRepository } from '../realty-integrations.repository';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { BillingService } from '../../billing/billing.service';
import { SellDoAdapter } from './selldo.adapter';
import { LeadSquaredAdapter } from './leadsquared.adapter';
import { PrivyrAdapter } from './privyr.adapter';
import { PLAN_DEFINITIONS } from '../../billing/billing.constants';
import { RealtyPlan } from '@prisma/client';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-0000000000aa';

function makeConnection(
  provider: RealtyIntegrationProvider,
  overrides: Partial<realty_integration_connections> = {},
): realty_integration_connections {
  return {
    id: `conn-${provider}`,
    business_id: BUSINESS_ID,
    provider,
    status: 'CONNECTED',
    config: { apiKey: 'k' },
    external_ref: null,
    last_sync_at: null,
    last_error: null,
    sync_count: 0,
    pushed_count: 0,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  } as realty_integration_connections;
}

describe('CrmPushService', () => {
  let service: CrmPushService;
  let repo: jest.Mocked<RealtyIntegrationsRepository>;
  let leads: jest.Mocked<RealtyLeadsService>;
  let billing: jest.Mocked<BillingService>;
  let emitter: jest.Mocked<EventEmitter2>;
  let selldo: SellDoAdapter;
  let leadsquared: LeadSquaredAdapter;
  let privyr: PrivyrAdapter;

  beforeEach(() => {
    repo = {
      listConnections: jest.fn(),
      findConnection: jest.fn(),
      upsertConnection: jest.fn(),
      softDeleteConnection: jest.fn(),
      recordSync: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RealtyIntegrationsRepository>;
    leads = { getLead: jest.fn() } as unknown as jest.Mocked<RealtyLeadsService>;
    billing = { canUseCrmSync: jest.fn() } as unknown as jest.Mocked<BillingService>;
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
    selldo = new SellDoAdapter();
    leadsquared = new LeadSquaredAdapter();
    privyr = new PrivyrAdapter();

    service = new CrmPushService(repo, leads, billing, emitter, selldo, leadsquared, privyr);
  });

  function stubLead(): void {
    leads.getLead.mockResolvedValue({
      id: LEAD_ID,
      name: 'Rahul',
      whatsappPhone: '+919876543210',
      altPhone: null,
      email: null,
      source: 'PORTAL',
      subSource: null,
      listingRef: null,
      stage: 'QUALIFIED',
      temperature: 'HOT',
      qualScore: 80,
      bltc: {
        budgetMinPaise: null,
        budgetMaxPaise: null,
        localities: [],
        timelineMonths: null,
        config: null,
        purpose: null,
        financing: null,
      },
    } as never);
  }

  describe('pushLead — plan gate', () => {
    it('skips entirely (no lead read) when the plan lacks CRM sync', async () => {
      billing.canUseCrmSync.mockResolvedValue(false);
      const res = await service.pushLead(BUSINESS_ID, LEAD_ID, 'created');
      expect(res).toEqual([]);
      expect(repo.listConnections).not.toHaveBeenCalled();
      expect(leads.getLead).not.toHaveBeenCalled();
    });

    it('returns empty when no CRM is connected', async () => {
      billing.canUseCrmSync.mockResolvedValue(true);
      repo.listConnections.mockResolvedValue([]);
      const res = await service.pushLead(BUSINESS_ID, LEAD_ID, 'created');
      expect(res).toEqual([]);
      expect(leads.getLead).not.toHaveBeenCalled();
    });
  });

  describe('pushLead — delivery', () => {
    beforeEach(() => {
      billing.canUseCrmSync.mockResolvedValue(true);
      stubLead();
    });

    it('pushes to every connected CRM and emits per-provider events', async () => {
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO),
        makeConnection(RealtyIntegrationProvider.PRIVYR, {
          config: { webhookUrl: 'https://hooks.privyr.com/x' },
        }),
      ]);
      jest.spyOn(selldo, 'push').mockResolvedValue({ ok: true, externalId: 'sd-1' });
      jest.spyOn(privyr, 'push').mockResolvedValue({ ok: true });

      const res = await service.pushLead(BUSINESS_ID, LEAD_ID, 'stage_changed');

      expect(res).toHaveLength(2);
      expect(repo.recordSync).toHaveBeenCalledTimes(2);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.crm.pushed',
        expect.objectContaining({
          provider: RealtyIntegrationProvider.SELLDO,
          reason: 'stage_changed',
          externalId: 'sd-1',
        }),
      );
    });

    it('emits push_failed and records the error when an adapter fails', async () => {
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO),
      ]);
      jest.spyOn(selldo, 'push').mockResolvedValue({ ok: false, error: 'boom' });

      await service.pushLead(BUSINESS_ID, LEAD_ID, 'created');

      expect(repo.recordSync).toHaveBeenCalledWith(BUSINESS_ID, 'conn-SELLDO', 'boom', 0);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.crm.push_failed',
        expect.objectContaining({ error: 'boom' }),
      );
    });

    it('substitutes a placeholder when a failing adapter gives no reason', async () => {
      // `recordSync` writes last_error, which the settings UI renders. A null
      // there reads as "no error" beside a failed sync count.
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO),
      ]);
      jest.spyOn(selldo, 'push').mockResolvedValue({ ok: false });

      await service.pushLead(BUSINESS_ID, LEAD_ID, 'created');

      expect(repo.recordSync).toHaveBeenCalledWith(BUSINESS_ID, 'conn-SELLDO', 'push failed', 0);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.crm.push_failed',
        expect.objectContaining({ error: 'unknown' }),
      );
    });

    it('pushes only to CRM providers, not every connected integration', async () => {
      // The connections table also holds Sheets and EOI rows. Reaching those
      // with a CRM payload would call an adapter that cannot accept it.
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.GOOGLE_SHEETS),
        makeConnection(RealtyIntegrationProvider.SELLDO),
      ]);
      jest.spyOn(selldo, 'push').mockResolvedValue({ ok: true });

      const res = await service.pushLead(BUSINESS_ID, LEAD_ID, 'created');

      expect(res).toHaveLength(1);
    });

    it('skips a connection that is not in CONNECTED state', async () => {
      // A connection left in ERROR after a credential change must not keep
      // receiving pushes that will fail.
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO, { status: 'ERROR' }),
      ]);
      const push = jest.spyOn(selldo, 'push');

      expect(await service.pushLead(BUSINESS_ID, LEAD_ID, 'created')).toEqual([]);
      expect(push).not.toHaveBeenCalled();
    });

    it('honors onlyProvider (single-CRM manual resync)', async () => {
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO),
        makeConnection(RealtyIntegrationProvider.PRIVYR, {
          config: { webhookUrl: 'https://hooks.privyr.com/x' },
        }),
      ]);
      const sd = jest.spyOn(selldo, 'push').mockResolvedValue({ ok: true });
      const pv = jest.spyOn(privyr, 'push').mockResolvedValue({ ok: true });

      await service.pushLead(BUSINESS_ID, LEAD_ID, 'manual', RealtyIntegrationProvider.PRIVYR);

      expect(pv).toHaveBeenCalledTimes(1);
      expect(sd).not.toHaveBeenCalled();
    });
  });

  describe('lead-lifecycle listeners', () => {
    it('onLeadCreated pushes with reason "created"', async () => {
      const spy = jest.spyOn(service, 'pushLead').mockResolvedValue([]);
      await service.onLeadCreated({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);
      expect(spy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, 'created');
    });

    it('onLeadStageChanged pushes with reason "stage_changed"', async () => {
      const spy = jest.spyOn(service, 'pushLead').mockResolvedValue([]);
      await service.onLeadStageChanged({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);
      expect(spy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, 'stage_changed');
    });

    it('swallows push errors so lead processing is never broken', async () => {
      jest.spyOn(service, 'pushLead').mockRejectedValue(new Error('crm down'));
      await expect(
        service.onLeadCreated({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never),
      ).resolves.toBeUndefined();
    });

    it('swallows a non-Error rejection too', async () => {
      // An adapter that rejects with a string would otherwise crash the error
      // handler itself on `.message`, turning a swallowed failure into a
      // thrown one — the opposite of what the wrapper exists for.
      jest.spyOn(service, 'pushLead').mockRejectedValue('crm down');
      await expect(
        service.onLeadCreated({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never),
      ).resolves.toBeUndefined();
    });
  });

  describe('connect', () => {
    it('verifies credentials before persisting a CONNECTED connection', async () => {
      repo.upsertConnection.mockResolvedValue(
        makeConnection(RealtyIntegrationProvider.SELLDO),
      );
      const status = await service.connect(
        BUSINESS_ID,
        RealtyIntegrationProvider.SELLDO,
        { apiKey: 'k' },
      );
      expect(status.status).toBe('CONNECTED');
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.integration.connected',
        expect.any(Object),
      );
    });

    it('rejects invalid credentials without persisting', async () => {
      await expect(
        service.connect(BUSINESS_ID, RealtyIntegrationProvider.SELLDO, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsertConnection).not.toHaveBeenCalled();
    });

    it('falls back to a generic message when verify fails without one', async () => {
      jest.spyOn(selldo, 'verify').mockResolvedValue({ ok: false });

      await expect(
        service.connect(BUSINESS_ID, RealtyIntegrationProvider.SELLDO, { apiKey: 'k' }),
      ).rejects.toThrow('Invalid CRM credentials');
    });

    it('rejects a provider with no adapter before touching the repository', async () => {
      await expect(
        service.connect(BUSINESS_ID, 'NOT_A_REAL_CRM' as RealtyIntegrationProvider, {}),
      ).rejects.toThrow(/Unsupported CRM provider/);
      expect(repo.upsertConnection).not.toHaveBeenCalled();
    });
  });

  describe('onLeadQualified', () => {
    it('pushes with reason "updated"', async () => {
      // A qualified lead is an update to a record the CRM already holds, not a
      // new one — pushing it as "created" would duplicate the row.
      const spy = jest.spyOn(service, 'pushLead').mockResolvedValue([]);
      await service.onLeadQualified({ businessId: BUSINESS_ID, leadId: LEAD_ID } as never);
      expect(spy).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, 'updated');
    });
  });

  describe('disconnect', () => {
    it('soft-deletes the connection and announces it', async () => {
      repo.findConnection.mockResolvedValue(makeConnection(RealtyIntegrationProvider.SELLDO));

      await service.disconnect(BUSINESS_ID, RealtyIntegrationProvider.SELLDO);

      expect(repo.softDeleteConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        RealtyIntegrationProvider.SELLDO,
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.integration.disconnected',
        expect.objectContaining({ provider: RealtyIntegrationProvider.SELLDO }),
      );
    });

    it('stays quiet when there was nothing connected', async () => {
      // Disconnecting twice is idempotent, but the second call must not
      // announce a disconnection that did not happen — listeners treat the
      // event as a state change.
      repo.findConnection.mockResolvedValue(null);

      await service.disconnect(BUSINESS_ID, RealtyIntegrationProvider.SELLDO);

      expect(repo.softDeleteConnection).toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('listConnections', () => {
    it('returns the CRM connections as status rows', async () => {
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO, { pushed_count: 7 }),
      ]);

      const [status] = await service.listConnections(BUSINESS_ID);

      expect(status).toMatchObject({
        provider: RealtyIntegrationProvider.SELLDO,
        status: 'CONNECTED',
        pushedCount: 7,
      });
    });

    it('drops non-CRM integrations sharing the connections table', async () => {
      // Sheets and EOI connections live in the same table; surfacing them from
      // the CRM endpoint would show a provider this service cannot push to.
      repo.listConnections.mockResolvedValue([
        makeConnection(RealtyIntegrationProvider.SELLDO),
        makeConnection(RealtyIntegrationProvider.GOOGLE_SHEETS),
      ]);

      const result = await service.listConnections(BUSINESS_ID);

      expect(result).toHaveLength(1);
      expect(result[0]!.provider).toBe(RealtyIntegrationProvider.SELLDO);
    });

    it('returns empty when the business has no integrations', async () => {
      repo.listConnections.mockResolvedValue([]);
      expect(await service.listConnections(BUSINESS_ID)).toEqual([]);
    });
  });

  describe('testConnection', () => {
    it('reports "Not connected" without calling the provider', async () => {
      repo.findConnection.mockResolvedValue(null);

      const result = await service.testConnection(BUSINESS_ID, RealtyIntegrationProvider.SELLDO);

      expect(result).toEqual({ ok: false, error: 'Not connected' });
    });

    it('verifies the stored credentials against the provider', async () => {
      repo.findConnection.mockResolvedValue(
        makeConnection(RealtyIntegrationProvider.SELLDO, { config: { apiKey: 'k' } }),
      );
      const verify = jest.spyOn(selldo, 'verify').mockResolvedValue({ ok: true });

      const result = await service.testConnection(BUSINESS_ID, RealtyIntegrationProvider.SELLDO);

      expect(verify).toHaveBeenCalledWith({ apiKey: 'k' });
      expect(result.ok).toBe(true);
    });

    it('treats a null stored config as an empty one rather than throwing', async () => {
      // `config` is nullable in the schema; a connection row written before the
      // column was populated must surface as a failed verify, not a TypeError.
      repo.findConnection.mockResolvedValue(
        makeConnection(RealtyIntegrationProvider.SELLDO, { config: null }),
      );
      const verify = jest.spyOn(selldo, 'verify').mockResolvedValue({ ok: false, error: 'no key' });

      const result = await service.testConnection(BUSINESS_ID, RealtyIntegrationProvider.SELLDO);

      expect(verify).toHaveBeenCalledWith({});
      expect(result.ok).toBe(false);
    });

    it('rejects a provider this service has no adapter for', async () => {
      repo.findConnection.mockResolvedValue(
        makeConnection(RealtyIntegrationProvider.GOOGLE_SHEETS),
      );

      await expect(
        service.testConnection(BUSINESS_ID, RealtyIntegrationProvider.GOOGLE_SHEETS),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CRM sync plan gate (constants)', () => {
    it('is a Developer-only feature', () => {
      expect(PLAN_DEFINITIONS[RealtyPlan.SOLO].crmSyncEnabled).toBe(false);
      expect(PLAN_DEFINITIONS[RealtyPlan.TEAM].crmSyncEnabled).toBe(false);
      expect(PLAN_DEFINITIONS[RealtyPlan.DEVELOPER].crmSyncEnabled).toBe(true);
    });
  });
});
