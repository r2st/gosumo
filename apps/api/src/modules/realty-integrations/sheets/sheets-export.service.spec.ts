/**
 * SheetsExportService unit tests. Repository, leads/inventory services, the
 * Google Sheets client, and EventEmitter2 are all mocked — no network, no DB.
 *
 * Coverage: OAuth completion, one-click export (data collection → write → event),
 * the not-connected guard, error recording, and the nightly sweep.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { signOAuthState } from '../../../common/utils/oauth-state.util';
import { BadRequestException } from '@nestjs/common';
import { RealtyIntegrationProvider } from '@prisma/client';
import type { realty_integration_connections } from '@prisma/client';

import { SheetsExportService } from './sheets-export.service';
import { RealtyIntegrationsRepository } from '../realty-integrations.repository';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { RealtyInventoryService } from '../../realty-inventory/realty-inventory.service';
import type { IGoogleSheetsClient } from './google-sheets.client';
import { SHEET_TABS } from '../realty-integrations.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
/** Stands in for JWT_SECRET, which the OAuth state HMAC is keyed with. */
const STATE_SECRET = 'test-jwt-secret-for-oauth-state';

function makeConnection(
  overrides: Partial<realty_integration_connections> = {},
): realty_integration_connections {
  return {
    id: 'conn-1',
    business_id: BUSINESS_ID,
    provider: RealtyIntegrationProvider.GOOGLE_SHEETS,
    status: 'CONNECTED',
    config: { refreshToken: 'rt', spreadsheetId: 'sheet-123' },
    external_ref: 'sheet-123',
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

describe('SheetsExportService', () => {
  let service: SheetsExportService;
  let repo: jest.Mocked<RealtyIntegrationsRepository>;
  let leads: jest.Mocked<RealtyLeadsService>;
  let inventory: jest.Mocked<RealtyInventoryService>;
  let sheets: jest.Mocked<IGoogleSheetsClient>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(() => {
    repo = {
      findConnection: jest.fn(),
      upsertConnection: jest.fn(),
      recordSync: jest.fn(),
      softDeleteConnection: jest.fn(),
      listConnectedByProvider: jest.fn(),
    } as unknown as jest.Mocked<RealtyIntegrationsRepository>;
    leads = {
      listLeads: jest.fn(),
    } as unknown as jest.Mocked<RealtyLeadsService>;
    inventory = {
      listProjects: jest.fn(),
      listUnits: jest.fn(),
      listUnitsForProjects: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<RealtyInventoryService>;
    sheets = {
      getAuthUrl: jest.fn(),
      exchangeCode: jest.fn(),
      ensureSpreadsheet: jest.fn(),
      writeSheet: jest.fn(),
    };
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;

    const config = {
      get: (_key: string, fallback?: string) => STATE_SECRET ?? fallback ?? '',
    } as unknown as ConfigService;

    service = new SheetsExportService(
      repo,
      leads,
      inventory,
      emitter,
      config,
      sheets,
    );
  });

  describe('OAuth state', () => {
    it('sends a signed state to Google, not the bare businessId', () => {
      sheets.getAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/auth');

      service.getAuthUrl(BUSINESS_ID);

      const [state] = sheets.getAuthUrl.mock.calls[0]!;
      expect(state).not.toBe(BUSINESS_ID);
      expect(state).not.toContain(BUSINESS_ID);
      expect(service.resolveOAuthState(state as string)).toBe(BUSINESS_ID);
    });

    it('refuses a callback that names a tenant with an unsigned state', () => {
      // The pre-fix behaviour: anyone knowing a businessId could bind their own
      // Google account to that tenant and receive its exported leads.
      expect(() => service.resolveOAuthState(BUSINESS_ID)).toThrow(
        BadRequestException,
      );
    });

    it('refuses a state signed with the wrong key', () => {
      const foreign = signOAuthState(BUSINESS_ID, 'not-our-secret');

      expect(() => service.resolveOAuthState(foreign)).toThrow(BadRequestException);
    });

    it('refuses an empty state', () => {
      expect(() => service.resolveOAuthState('')).toThrow(BadRequestException);
    });
  });

  describe('completeOAuth', () => {
    it('exchanges the code, stores tokens CONNECTED, and emits connected', async () => {
      sheets.exchangeCode.mockResolvedValue({ refreshToken: 'rt', accessToken: 'at' });
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.findConnection.mockResolvedValue(makeConnection());

      await service.completeOAuth(BUSINESS_ID, 'auth-code');

      expect(sheets.exchangeCode).toHaveBeenCalledWith('auth-code');
      expect(repo.upsertConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        RealtyIntegrationProvider.GOOGLE_SHEETS,
        expect.objectContaining({ status: 'CONNECTED' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.integration.connected',
        expect.objectContaining({ type: 'realty.integration.connected' }),
      );
    });

    it('rejects when Google returns no usable credentials', async () => {
      sheets.exchangeCode.mockResolvedValue({});
      await expect(service.completeOAuth(BUSINESS_ID, 'x')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepts an access-token-only grant', async () => {
      // Google withholds the refresh token on re-consent; the access token alone
      // is still enough to export until it expires.
      sheets.exchangeCode.mockResolvedValue({ accessToken: 'at' });
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.findConnection.mockResolvedValue(makeConnection());

      await expect(service.completeOAuth(BUSINESS_ID, 'code')).resolves.toMatchObject({
        connected: true,
      });
    });

    it('emits an empty connectionId when the row cannot be read back', async () => {
      sheets.exchangeCode.mockResolvedValue({ refreshToken: 'rt' });
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.findConnection.mockResolvedValue(null);

      await service.completeOAuth(BUSINESS_ID, 'code');

      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.integration.connected',
        expect.objectContaining({ connectionId: '' }),
      );
    });
  });

  describe('exportForBusiness', () => {
    it('throws when Sheets is not connected', async () => {
      repo.findConnection.mockResolvedValue(null);
      await expect(service.exportForBusiness(BUSINESS_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the connection row exists but is DISCONNECTED', async () => {
      repo.findConnection.mockResolvedValue(makeConnection({ status: 'DISCONNECTED' }));

      await expect(service.exportForBusiness(BUSINESS_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(sheets.ensureSpreadsheet).not.toHaveBeenCalled();
    });

    it('walks every page of leads before writing the sheet', async () => {
      repo.findConnection.mockResolvedValue(makeConnection());
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.recordSync.mockResolvedValue(makeConnection());
      leads.listLeads
        .mockResolvedValueOnce({
          data: [{ id: 'lead-1', bltc: { localities: [] } }] as never,
          total: 2,
          page: 1,
          limit: 500,
          totalPages: 2,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'lead-2', bltc: { localities: [] } }] as never,
          total: 2,
          page: 2,
          limit: 500,
          totalPages: 2,
        });
      inventory.listProjects.mockResolvedValue([]);
      sheets.ensureSpreadsheet.mockResolvedValue({
        spreadsheetId: 'sheet-123',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123',
      });
      sheets.writeSheet.mockResolvedValue();

      const result = await service.exportForBusiness(BUSINESS_ID);

      expect(leads.listLeads).toHaveBeenCalledTimes(2);
      expect(leads.listLeads).toHaveBeenLastCalledWith(BUSINESS_ID, {
        page: 2,
        limit: 500,
      });
      expect(result.leadsExported).toBe(2);
    });

    it('stops paging when a page comes back empty', async () => {
      // A shrinking result set must not spin to the MAX_LEAD_PAGES cap.
      repo.findConnection.mockResolvedValue(makeConnection());
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.recordSync.mockResolvedValue(makeConnection());
      leads.listLeads.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 500,
        totalPages: 99,
      });
      inventory.listProjects.mockResolvedValue([]);
      sheets.ensureSpreadsheet.mockResolvedValue({
        spreadsheetId: 'sheet-123',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123',
      });
      sheets.writeSheet.mockResolvedValue();

      const result = await service.exportForBusiness(BUSINESS_ID);

      expect(leads.listLeads).toHaveBeenCalledTimes(1);
      expect(result.leadsExported).toBe(0);
    });

    it('exports a project that has no units yet', async () => {
      repo.findConnection.mockResolvedValue(makeConnection());
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.recordSync.mockResolvedValue(makeConnection());
      leads.listLeads.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 500,
        totalPages: 1,
      });
      inventory.listProjects.mockResolvedValue([{ id: 'proj-empty' }] as never);
      inventory.listUnitsForProjects.mockResolvedValue(new Map() as never);
      sheets.ensureSpreadsheet.mockResolvedValue({
        spreadsheetId: 'sheet-123',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123',
      });
      sheets.writeSheet.mockResolvedValue();

      const result = await service.exportForBusiness(BUSINESS_ID);

      expect(result.unitsExported).toBe(0);
      expect(sheets.writeSheet).toHaveBeenCalledTimes(2);
    });

    it('persists the newly created spreadsheetId back onto the connection', async () => {
      // First export: the connection has credentials but no sheet yet.
      repo.findConnection.mockResolvedValue(
        makeConnection({ config: { refreshToken: 'rt' }, external_ref: null }),
      );
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.recordSync.mockResolvedValue(makeConnection());
      leads.listLeads.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 500,
        totalPages: 1,
      });
      inventory.listProjects.mockResolvedValue([]);
      sheets.ensureSpreadsheet.mockResolvedValue({
        spreadsheetId: 'sheet-new',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-new',
      });
      sheets.writeSheet.mockResolvedValue();

      await service.exportForBusiness(BUSINESS_ID);

      expect(repo.upsertConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        RealtyIntegrationProvider.GOOGLE_SHEETS,
        expect.objectContaining({
          externalRef: 'sheet-new',
          config: expect.objectContaining({
            refreshToken: 'rt',
            spreadsheetId: 'sheet-new',
          }),
        }),
      );
    });

    it('records a non-Error rejection as a string', async () => {
      repo.findConnection.mockResolvedValue(makeConnection());
      repo.recordSync.mockResolvedValue(makeConnection());
      leads.listLeads.mockRejectedValue('socket hang up');

      await expect(service.exportForBusiness(BUSINESS_ID)).rejects.toBe('socket hang up');
      expect(repo.recordSync).toHaveBeenCalledWith(BUSINESS_ID, 'conn-1', 'socket hang up');
    });

    it('collects leads + inventory, writes both tabs, records sync, and emits', async () => {
      repo.findConnection.mockResolvedValue(makeConnection());
      repo.upsertConnection.mockResolvedValue(makeConnection());
      repo.recordSync.mockResolvedValue(makeConnection());
      leads.listLeads.mockResolvedValue({
        data: [{ id: 'lead-1', bltc: { localities: [] } }] as never,
        total: 1,
        page: 1,
        limit: 500,
        totalPages: 1,
      });
      inventory.listProjects.mockResolvedValue([{ id: 'proj-1' }] as never);
      inventory.listUnitsForProjects.mockResolvedValue(
        new Map([['proj-1', [{ id: 'unit-1' }]]]) as never,
      );
      sheets.ensureSpreadsheet.mockResolvedValue({
        spreadsheetId: 'sheet-123',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123',
      });
      sheets.writeSheet.mockResolvedValue();

      const result = await service.exportForBusiness(BUSINESS_ID, false);

      expect(result).toEqual(
        expect.objectContaining({
          spreadsheetId: 'sheet-123',
          leadsExported: 1,
          unitsExported: 1,
        }),
      );
      const writtenTabs = sheets.writeSheet.mock.calls.map((c) => c[2]);
      expect(writtenTabs).toEqual([SHEET_TABS.LEADS, SHEET_TABS.INVENTORY]);
      expect(repo.recordSync).toHaveBeenCalledWith(BUSINESS_ID, 'conn-1', null);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.sheets.exported',
        expect.objectContaining({ leadsExported: 1, unitsExported: 1, scheduled: false }),
      );
    });

    it('records the error on the connection and rethrows on a gateway failure', async () => {
      repo.findConnection.mockResolvedValue(makeConnection());
      leads.listLeads.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 500,
        totalPages: 1,
      });
      inventory.listProjects.mockResolvedValue([]);
      sheets.ensureSpreadsheet.mockRejectedValue(new Error('google 403'));
      repo.recordSync.mockResolvedValue(makeConnection());

      await expect(service.exportForBusiness(BUSINESS_ID)).rejects.toThrow('google 403');
      expect(repo.recordSync).toHaveBeenCalledWith(BUSINESS_ID, 'conn-1', 'google 403');
    });
  });

  describe('runNightlyExport', () => {
    it('exports every connected business and counts failures', async () => {
      repo.listConnectedByProvider.mockResolvedValue([
        makeConnection({ id: 'c1', business_id: 'b1' }),
        makeConnection({ id: 'c2', business_id: 'b2' }),
      ] as never);
      const spy = jest
        .spyOn(service, 'exportForBusiness')
        .mockResolvedValueOnce({
          spreadsheetId: 's',
          spreadsheetUrl: 'u',
          leadsExported: 0,
          unitsExported: 0,
        })
        .mockRejectedValueOnce(new Error('boom'));

      const res = await service.runNightlyExport();

      expect(spy).toHaveBeenCalledTimes(2);
      expect(res).toEqual({ businesses: 2, failures: 1 });
    });

    it('counts a non-Error failure without derailing the sweep', async () => {
      repo.listConnectedByProvider.mockResolvedValue([
        makeConnection({ id: 'c1', business_id: 'b1' }),
        makeConnection({ id: 'c2', business_id: 'b2' }),
      ] as never);
      jest
        .spyOn(service, 'exportForBusiness')
        .mockRejectedValueOnce('socket hang up')
        .mockResolvedValueOnce({
          spreadsheetId: 's',
          spreadsheetUrl: 'u',
          leadsExported: 0,
          unitsExported: 0,
        });

      // The second business must still export after the first one blows up.
      expect(await service.runNightlyExport()).toEqual({ businesses: 2, failures: 1 });
    });

    it('reports a clean sweep when there is nothing connected', async () => {
      repo.listConnectedByProvider.mockResolvedValue([]);

      expect(await service.runNightlyExport()).toEqual({ businesses: 0, failures: 0 });
    });
  });

  describe('disconnect', () => {
    it('soft-deletes the connection and announces the disconnect', async () => {
      repo.findConnection.mockResolvedValue(makeConnection());

      await service.disconnect(BUSINESS_ID);

      expect(repo.softDeleteConnection).toHaveBeenCalledWith(
        BUSINESS_ID,
        RealtyIntegrationProvider.GOOGLE_SHEETS,
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.integration.disconnected',
        expect.objectContaining({
          type: 'realty.integration.disconnected',
          connectionId: 'conn-1',
          businessId: BUSINESS_ID,
        }),
      );
    });

    it('stays quiet when there was no connection to remove', async () => {
      // Disconnecting twice must not announce a second teardown — downstream
      // listeners treat the event as "credentials just went away".
      repo.findConnection.mockResolvedValue(null);

      await service.disconnect(BUSINESS_ID);

      expect(repo.softDeleteConnection).toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('reports a disconnected shell when no connection row exists', async () => {
      repo.findConnection.mockResolvedValue(null);

      expect(await service.getStatus(BUSINESS_ID)).toEqual({
        connected: false,
        status: 'DISCONNECTED',
        spreadsheetId: null,
        spreadsheetUrl: null,
        lastSyncAt: null,
        lastError: null,
        syncCount: 0,
      });
    });

    it('builds the spreadsheet URL from the stored id', async () => {
      const lastSyncAt = new Date('2026-01-02T03:04:05.000Z');
      repo.findConnection.mockResolvedValue(
        makeConnection({ last_sync_at: lastSyncAt, sync_count: 7 }),
      );

      const status = await service.getStatus(BUSINESS_ID);

      expect(status).toMatchObject({
        connected: true,
        spreadsheetId: 'sheet-123',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123',
        lastSyncAt,
        syncCount: 7,
      });
    });

    it('leaves the URL null before the first export has created a sheet', async () => {
      repo.findConnection.mockResolvedValue(
        makeConnection({ config: { refreshToken: 'rt' } }),
      );

      const status = await service.getStatus(BUSINESS_ID);

      expect(status.spreadsheetId).toBeNull();
      expect(status.spreadsheetUrl).toBeNull();
    });

    it('surfaces a connection parked in ERROR as not connected', async () => {
      repo.findConnection.mockResolvedValue(
        makeConnection({ status: 'ERROR', last_error: 'google 403' }),
      );

      const status = await service.getStatus(BUSINESS_ID);

      expect(status).toMatchObject({
        connected: false,
        status: 'ERROR',
        lastError: 'google 403',
      });
    });

    it('tolerates a connection whose config was never written', async () => {
      repo.findConnection.mockResolvedValue(makeConnection({ config: null as never }));

      expect((await service.getStatus(BUSINESS_ID)).spreadsheetId).toBeNull();
    });
  });
});
