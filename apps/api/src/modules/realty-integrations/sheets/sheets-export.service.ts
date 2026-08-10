import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RealtyIntegrationProvider } from '@prisma/client';
import { generateId, generateCorrelationId } from '@gosumo/shared';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import type { LeadResponseDto } from '../../realty-leads/realty-leads.service';
import { RealtyInventoryService } from '../../realty-inventory/realty-inventory.service';
import type {
  ProjectResponseDto,
  UnitResponseDto,
} from '../../realty-inventory/realty-inventory.service';
import { RealtyIntegrationsRepository } from '../realty-integrations.repository';
import {
  GOOGLE_SHEETS_CLIENT,
  IGoogleSheetsClient,
  GoogleSheetsCredentials,
} from './google-sheets.client';
import { buildLeadsSheet, buildInventorySheet } from './sheets-row-mapper';
import {
  signOAuthState,
  verifyOAuthState,
} from '../../../common/utils/oauth-state.util';
import { SHEET_TABS } from '../realty-integrations.constants';
import type {
  RealtySheetsExportedEvent,
  RealtyIntegrationConnectedEvent,
  RealtyIntegrationDisconnectedEvent,
} from '../realty-integrations.events';

export interface SheetsConnectionStatus {
  connected: boolean;
  status: string;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  syncCount: number;
}

export interface SheetsExportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  leadsExported: number;
  unitsExported: number;
}

const LEADS_PAGE_SIZE = 500;
/** Safety cap so a runaway export never loops unbounded. */
const MAX_LEAD_PAGES = 200;

/**
 * SheetsExportService — one-click and nightly export of a business's leads and
 * inventory into its connected Google Sheet (business plan §5). Credentials live
 * in the integration connection's `config`; the spreadsheet is created on first
 * export and reused (full-replace snapshot) thereafter.
 */
@Injectable()
export class SheetsExportService {
  private readonly logger = new Logger(SheetsExportService.name);
  private readonly provider = RealtyIntegrationProvider.GOOGLE_SHEETS;

  constructor(
    private readonly repository: RealtyIntegrationsRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly inventoryService: RealtyInventoryService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
    @Inject(GOOGLE_SHEETS_CLIENT)
    private readonly sheets: IGoogleSheetsClient,
  ) {}

  // ── OAuth connect / disconnect ───────────────

  /**
   * Key the OAuth state HMAC is signed with. `JWT_SECRET` is already a required
   * env var, so this adds no new deployment surface — and a deployment without
   * it fails the connect flow loudly rather than minting forgeable states.
   */
  private stateSecret(): string {
    return this.config.get<string>('jwt.secret', '');
  }

  /**
   * Build the Google consent URL. `state` carries the businessId back, signed —
   * see {@link signOAuthState} for why it must not be the bare id.
   */
  getAuthUrl(businessId: string): string {
    return this.sheets.getAuthUrl(signOAuthState(businessId, this.stateSecret()));
  }

  /**
   * Resolve the tenant a returned `state` belongs to, or reject it.
   *
   * The callback is `@Public()`, so this is the only thing standing between an
   * anonymous request and a credential write against an arbitrary tenant.
   */
  resolveOAuthState(state: string): string {
    const businessId = verifyOAuthState(state, this.stateSecret());
    if (!businessId) {
      this.logger.warn('Rejected Google Sheets OAuth callback: invalid or expired state');
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    return businessId;
  }

  /**
   * Complete the OAuth handshake: exchange the code, persist tokens on the
   * connection, and mark it CONNECTED. `businessId` must have come from
   * {@link resolveOAuthState}, never straight off the query string.
   */
  async completeOAuth(businessId: string, code: string): Promise<SheetsConnectionStatus> {
    const creds = await this.sheets.exchangeCode(code);
    if (!creds.refreshToken && !creds.accessToken) {
      throw new BadRequestException('Google did not return usable credentials');
    }
    await this.repository.upsertConnection(businessId, this.provider, {
      status: 'CONNECTED',
      config: creds as unknown as Record<string, unknown>,
      lastError: null,
    });
    const conn = await this.repository.findConnection(businessId, this.provider);
    this.emit<RealtyIntegrationConnectedEvent>('realty.integration.connected', {
      ...this.base(businessId),
      type: 'realty.integration.connected',
      provider: this.provider,
      connectionId: conn?.id ?? '',
    });
    this.logger.log(`Google Sheets connected for business ${businessId}`);
    return this.getStatus(businessId);
  }

  async disconnect(businessId: string): Promise<void> {
    const conn = await this.repository.findConnection(businessId, this.provider);
    await this.repository.softDeleteConnection(businessId, this.provider);
    if (conn) {
      this.emit<RealtyIntegrationDisconnectedEvent>('realty.integration.disconnected', {
        ...this.base(businessId),
        type: 'realty.integration.disconnected',
        provider: this.provider,
        connectionId: conn.id,
      });
    }
    this.logger.log(`Google Sheets disconnected for business ${businessId}`);
  }

  async getStatus(businessId: string): Promise<SheetsConnectionStatus> {
    const conn = await this.repository.findConnection(businessId, this.provider);
    if (!conn) {
      return {
        connected: false,
        status: 'DISCONNECTED',
        spreadsheetId: null,
        spreadsheetUrl: null,
        lastSyncAt: null,
        lastError: null,
        syncCount: 0,
      };
    }
    const creds = this.readCreds(conn.config);
    const spreadsheetId = creds.spreadsheetId ?? null;
    return {
      connected: conn.status === 'CONNECTED',
      status: conn.status,
      spreadsheetId,
      spreadsheetUrl: spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        : null,
      lastSyncAt: conn.last_sync_at,
      lastError: conn.last_error,
      syncCount: conn.sync_count,
    };
  }

  // ── Export ───────────────────────────────────

  /**
   * Export a single business's leads + inventory to its sheet. Used by the
   * one-click UI action (`scheduled=false`) and the nightly sweep (`true`).
   * A gateway failure is recorded on the connection (status ERROR) and rethrown.
   */
  async exportForBusiness(
    businessId: string,
    scheduled = false,
  ): Promise<SheetsExportResult> {
    const conn = await this.repository.findConnection(businessId, this.provider);
    if (!conn || conn.status === 'DISCONNECTED') {
      throw new BadRequestException('Google Sheets is not connected for this business');
    }
    const creds = this.readCreds(conn.config);

    try {
      const leads = await this.collectLeads(businessId);
      const inventory = await this.collectInventory(businessId);

      const ensured = await this.sheets.ensureSpreadsheet(
        creds,
        `GoSumo Realty — ${businessId.slice(0, 8)}`,
      );

      const leadRows = buildLeadsSheet(leads);
      const unitEntries = inventory;
      const inventoryRows = buildInventorySheet(unitEntries);

      await this.sheets.writeSheet(creds, ensured.spreadsheetId, SHEET_TABS.LEADS, leadRows);
      await this.sheets.writeSheet(
        creds,
        ensured.spreadsheetId,
        SHEET_TABS.INVENTORY,
        inventoryRows,
      );

      const unitsExported = inventory.reduce((n, e) => n + e.units.length, 0);

      // Persist the (possibly newly-created) spreadsheetId back onto the connection.
      await this.repository.upsertConnection(businessId, this.provider, {
        config: { ...creds, spreadsheetId: ensured.spreadsheetId } as unknown as Record<
          string,
          unknown
        >,
        externalRef: ensured.spreadsheetId,
      });
      await this.repository.recordSync(businessId, conn.id, null);

      this.emit<RealtySheetsExportedEvent>('realty.sheets.exported', {
        ...this.base(businessId),
        type: 'realty.sheets.exported',
        connectionId: conn.id,
        spreadsheetId: ensured.spreadsheetId,
        leadsExported: leads.length,
        unitsExported,
        scheduled,
      });

      this.logger.log(
        `Sheets export for ${businessId}: ${leads.length} lead(s), ${unitsExported} unit(s) → ${ensured.spreadsheetId}`,
      );
      return {
        spreadsheetId: ensured.spreadsheetId,
        spreadsheetUrl: ensured.spreadsheetUrl,
        leadsExported: leads.length,
        unitsExported,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repository.recordSync(businessId, conn.id, message);
      this.logger.error(`Sheets export failed for ${businessId}: ${message}`);
      throw err;
    }
  }

  /** Nightly sweep: export every business with a CONNECTED Sheets connection. */
  async runNightlyExport(): Promise<{ businesses: number; failures: number }> {
    const connections = await this.repository.listConnectedByProvider(this.provider);
    let failures = 0;
    for (const conn of connections) {
      try {
        await this.exportForBusiness(conn.business_id, true);
      } catch (err) {
        failures += 1;
        this.logger.error(
          `Nightly Sheets export failed for ${conn.business_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(
      `Nightly Sheets export complete: ${connections.length} business(es), ${failures} failure(s)`,
    );
    return { businesses: connections.length, failures };
  }

  // ── Data collection ──────────────────────────

  private async collectLeads(businessId: string): Promise<LeadResponseDto[]> {
    const all: LeadResponseDto[] = [];
    for (let page = 1; page <= MAX_LEAD_PAGES; page += 1) {
      const res = await this.leadsService.listLeads(businessId, {
        page,
        limit: LEADS_PAGE_SIZE,
      });
      all.push(...res.data);
      if (page >= res.totalPages || res.data.length === 0) break;
    }
    return all;
  }

  private async collectInventory(
    businessId: string,
  ): Promise<Array<{ project: ProjectResponseDto; units: UnitResponseDto[] }>> {
    const projects = await this.inventoryService.listProjects(businessId, {});
    // Two queries for the whole portfolio rather than two per project.
    const unitsByProject = await this.inventoryService.listUnitsForProjects(
      businessId,
      projects.map((p) => p.id),
    );
    return projects.map((project) => ({
      project,
      units: unitsByProject.get(project.id) ?? [],
    }));
  }

  // ── Helpers ──────────────────────────────────

  private readCreds(config: unknown): GoogleSheetsCredentials {
    return (config ?? {}) as GoogleSheetsCredentials;
  }

  private base(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }

  private emit<T>(name: string, payload: T): void {
    this.eventEmitter.emit(name, payload);
  }
}
