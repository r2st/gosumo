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
  });

  describe('exportForBusiness', () => {
    it('throws when Sheets is not connected', async () => {
      repo.findConnection.mockResolvedValue(null);
      await expect(service.exportForBusiness(BUSINESS_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
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
      inventory.listUnits.mockResolvedValue([{ id: 'unit-1' }] as never);
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
  });
});
