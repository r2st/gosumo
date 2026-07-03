import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import type { SheetRow } from './sheets-row-mapper';

/**
 * Per-connection Google OAuth credentials, persisted (encrypted at rest by the
 * DB layer) inside `realty_integration_connections.config`.
 */
export interface GoogleSheetsCredentials {
  accessToken?: string;
  refreshToken?: string;
  /** Unix epoch ms when the access token expires. */
  expiryDate?: number;
  /** The spreadsheet this business exports into (created on first export). */
  spreadsheetId?: string;
}

export interface EnsureSpreadsheetResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

/**
 * The Google Sheets operations the export flow needs. Depending on this
 * interface (not the concrete client) keeps the export service unit-testable
 * with an in-memory fake — no network, no real Google account.
 */
export interface IGoogleSheetsClient {
  /** Build the OAuth consent-screen URL for the Sheets connection flow. */
  getAuthUrl(state: string): string;
  /** Exchange an OAuth authorization code for tokens. */
  exchangeCode(code: string): Promise<GoogleSheetsCredentials>;
  /** Create the export spreadsheet if `spreadsheetId` is unset; else return it. */
  ensureSpreadsheet(
    creds: GoogleSheetsCredentials,
    title: string,
  ): Promise<EnsureSpreadsheetResult>;
  /** Overwrite a worksheet (tab) with `rows` (row 0 is the header). */
  writeSheet(
    creds: GoogleSheetsCredentials,
    spreadsheetId: string,
    tabName: string,
    rows: SheetRow[],
  ): Promise<void>;
}

/** DI token for {@link IGoogleSheetsClient} (a mock is bound in tests). */
export const GOOGLE_SHEETS_CLIENT = 'GOOGLE_SHEETS_CLIENT';

/** OAuth scopes: create/edit spreadsheets in the user's Drive. */
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * GoogleSheetsClient — the production {@link IGoogleSheetsClient} backed by the
 * `googleapis` package. OAuth app credentials come from ConfigService
 * (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`);
 * per-business tokens are passed in per call.
 */
@Injectable()
export class GoogleSheetsClient implements IGoogleSheetsClient {
  private readonly logger = new Logger(GoogleSheetsClient.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('GOOGLE_CLIENT_ID', '');
    this.clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET', '');
    this.redirectUri = this.configService.get<string>('GOOGLE_OAUTH_REDIRECT_URI', '');
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'Google OAuth credentials not configured. Sheets export will fail until GOOGLE_CLIENT_ID/SECRET are set.',
      );
    }
  }

  private oauthClient(creds?: GoogleSheetsCredentials) {
    const client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
    if (creds) {
      client.setCredentials({
        access_token: creds.accessToken,
        refresh_token: creds.refreshToken,
        expiry_date: creds.expiryDate,
      });
    }
    return client;
  }

  getAuthUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
    });
  }

  async exchangeCode(code: string): Promise<GoogleSheetsCredentials> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    return {
      accessToken: tokens.access_token ?? undefined,
      refreshToken: tokens.refresh_token ?? undefined,
      expiryDate: tokens.expiry_date ?? undefined,
    };
  }

  async ensureSpreadsheet(
    creds: GoogleSheetsCredentials,
    title: string,
  ): Promise<EnsureSpreadsheetResult> {
    const sheets = google.sheets({ version: 'v4', auth: this.oauthClient(creds) });
    if (creds.spreadsheetId) {
      return {
        spreadsheetId: creds.spreadsheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${creds.spreadsheetId}`,
      };
    }
    const created = await sheets.spreadsheets.create({
      requestBody: { properties: { title } },
    });
    const spreadsheetId = created.data.spreadsheetId;
    if (!spreadsheetId) {
      throw new Error('Google Sheets did not return a spreadsheetId on create');
    }
    return {
      spreadsheetId,
      spreadsheetUrl:
        created.data.spreadsheetUrl ??
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    };
  }

  async writeSheet(
    creds: GoogleSheetsCredentials,
    spreadsheetId: string,
    tabName: string,
    rows: SheetRow[],
  ): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.oauthClient(creds) });
    await this.ensureTab(sheets, spreadsheetId, tabName);
    // Clear the tab, then write the fresh snapshot (export is a full replace).
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }

  /** Create the worksheet tab if it does not already exist. */
  private async ensureTab(
    sheets: ReturnType<typeof google.sheets>,
    spreadsheetId: string,
    tabName: string,
  ): Promise<void> {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = (meta.data.sheets ?? []).some(
      (s) => s.properties?.title === tabName,
    );
    if (exists) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
  }
}
