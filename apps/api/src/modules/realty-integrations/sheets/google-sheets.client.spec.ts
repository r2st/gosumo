/**
 * GoogleSheetsClient unit tests.
 *
 * The export service is tested against the `IGoogleSheetsClient` interface with
 * an in-memory fake, which is the right trade for that layer — but it means the
 * only concrete implementation of the interface had no tests at all. Everything
 * this file asserts is about the seam between our data and Google's API, and
 * none of it is exercised by the export-service suite.
 *
 * Three things here are worth pinning:
 *
 *  1. **`ensureSpreadsheet` is idempotent.** It creates a spreadsheet only when
 *     the connection has no `spreadsheetId`. A regression that always created
 *     one would silently orphan a tenant's export history on every run and
 *     litter their Drive.
 *
 *  2. **`writeSheet` is a full replace, in order.** clear-then-update, with the
 *     tab created first. Reordering clear and update leaves the tail of a
 *     previous, longer export below the new rows — stale inventory that reads
 *     as current.
 *
 *  3. **Per-call credentials.** Tokens are per-business and arrive as an
 *     argument, never as client state. The test asserts each call sets the
 *     credentials it was handed, because a client that cached them across calls
 *     would write one tenant's data into another's spreadsheet.
 *
 * `googleapis` is mocked wholesale: these are unit tests, and the real package
 * would need a network and a Google account.
 */

import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@gosumo/shared';

const generateAuthUrl = jest.fn(
  (_opts: Record<string, unknown>) => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1',
);
const getToken = jest.fn();
const setCredentials = jest.fn();
const OAuth2 = jest.fn(() => ({ generateAuthUrl, getToken, setCredentials }));

const spreadsheetsCreate = jest.fn();
const spreadsheetsGet = jest.fn();
const batchUpdate = jest.fn();
const valuesClear = jest.fn();
const valuesUpdate = jest.fn();

const sheetsFactory = jest.fn(() => ({
  spreadsheets: {
    create: spreadsheetsCreate,
    get: spreadsheetsGet,
    batchUpdate,
    values: { clear: valuesClear, update: valuesUpdate },
  },
}));

jest.mock('googleapis', () => ({
  google: {
    auth: {
      get OAuth2() {
        return OAuth2;
      },
    },
    sheets: (...args: unknown[]) => sheetsFactory(...(args as [])),
  },
}));

import { GoogleSheetsClient, GoogleSheetsCredentials } from './google-sheets.client';
import type { SheetRow } from './sheets-row-mapper';

const CONFIG = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://gosumo.example/realty/sheets/callback',
};

function makeClient(overrides: Record<string, string> = {}): GoogleSheetsClient {
  const values: Record<string, string> = { ...CONFIG, ...overrides };
  const configService = {
    get: (key: string, fallback: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
  return new GoogleSheetsClient(configService);
}

const CREDS: GoogleSheetsCredentials = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiryDate: 1_777_000_000_000,
};

beforeEach(() => {
  jest.clearAllMocks();
  spreadsheetsGet.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Leads' } }] } });
  valuesClear.mockResolvedValue({});
  valuesUpdate.mockResolvedValue({});
  batchUpdate.mockResolvedValue({});
});

describe('GoogleSheetsClient construction', () => {
  it('builds the OAuth client from configured app credentials', () => {
    makeClient().getAuthUrl('state-1');

    expect(OAuth2).toHaveBeenCalledWith(
      'client-id',
      'client-secret',
      'https://gosumo.example/realty/sheets/callback',
    );
  });

  it.each([['GOOGLE_CLIENT_ID'], ['GOOGLE_CLIENT_SECRET']])(
    'warns rather than throwing when %s is unset',
    (key) => {
      // The module must still load with Sheets unconfigured — most tenants
      // never connect it. The warning is what stops that being silent.
      const warn = jest
        .spyOn(
          jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common').Logger.prototype,
          'warn',
        )
        .mockImplementation();

      expect(() => makeClient({ [key]: '' })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));

      warn.mockRestore();
    },
  );
});

describe('GoogleSheetsClient.getAuthUrl', () => {
  it('requests offline access so the refresh token survives the session', () => {
    // Exports run from a queue long after the browser is gone. Without
    // `access_type: offline` Google issues no refresh token and every export
    // after the first hour fails.
    const url = makeClient().getAuthUrl('signed-state');

    expect(url).toContain('accounts.google.com');
    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({ access_type: 'offline', prompt: 'consent', state: 'signed-state' }),
    );
  });

  it('asks only for the spreadsheet and drive.file scopes', () => {
    // `drive.file` limits us to files this app created. Widening to full
    // `drive` would give the export job read access to the user's whole Drive.
    makeClient().getAuthUrl('state-1');

    const { scope } = generateAuthUrl.mock.calls[0]![0] as { scope: string[] };
    expect(scope).toEqual([
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ]);
  });

  it('does not attach any per-business credentials', () => {
    // The consent URL is built before any tokens exist.
    makeClient().getAuthUrl('state-1');
    expect(setCredentials).not.toHaveBeenCalled();
  });
});

describe('GoogleSheetsClient.exchangeCode', () => {
  it('normalises the token response', async () => {
    getToken.mockResolvedValue({
      tokens: { access_token: 'a', refresh_token: 'r', expiry_date: 123 },
    });

    await expect(makeClient().exchangeCode('auth-code')).resolves.toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiryDate: 123,
    });
    expect(getToken).toHaveBeenCalledWith('auth-code');
  });

  it('maps absent token fields to undefined, not null', async () => {
    // Google returns `null` for a refresh token on re-consent. Persisting the
    // null would overwrite the stored refresh token with an unusable value;
    // `undefined` lets the caller's merge leave the existing one alone.
    getToken.mockResolvedValue({
      tokens: { access_token: null, refresh_token: null, expiry_date: null },
    });

    await expect(makeClient().exchangeCode('auth-code')).resolves.toEqual({
      accessToken: undefined,
      refreshToken: undefined,
      expiryDate: undefined,
    });
  });

  it('propagates an exchange failure', async () => {
    // An invalid or replayed code must surface — the callback route turns it
    // into a 401 rather than storing an empty connection.
    getToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(makeClient().exchangeCode('stale-code')).rejects.toThrow('invalid_grant');
  });
});

describe('GoogleSheetsClient.ensureSpreadsheet', () => {
  it('returns the existing spreadsheet without creating a new one', async () => {
    const result = await makeClient().ensureSpreadsheet(
      { ...CREDS, spreadsheetId: 'sheet-1' },
      'DoAide Inbox Export',
    );

    expect(result).toEqual({
      spreadsheetId: 'sheet-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1',
    });
    // The idempotency that keeps a tenant's export history in one document.
    expect(spreadsheetsCreate).not.toHaveBeenCalled();
  });

  it('creates the spreadsheet on first export', async () => {
    spreadsheetsCreate.mockResolvedValue({
      data: {
        spreadsheetId: 'new-sheet',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-sheet/edit',
      },
    });

    const result = await makeClient().ensureSpreadsheet(CREDS, 'DoAide Inbox Export');

    expect(spreadsheetsCreate).toHaveBeenCalledWith({
      requestBody: { properties: { title: 'DoAide Inbox Export' } },
    });
    expect(result).toEqual({
      spreadsheetId: 'new-sheet',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-sheet/edit',
    });
  });

  it('derives a URL when Google returns an id but no url', async () => {
    spreadsheetsCreate.mockResolvedValue({ data: { spreadsheetId: 'new-sheet' } });

    await expect(makeClient().ensureSpreadsheet(CREDS, 'Export')).resolves.toEqual({
      spreadsheetId: 'new-sheet',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-sheet',
    });
  });

  it('throws when the create response carries no spreadsheetId', async () => {
    // Returning a result with an undefined id would push the failure into
    // `writeSheet`, where it reads as a permissions problem instead.
    spreadsheetsCreate.mockResolvedValue({ data: {} });

    const error = await makeClient()
      .ensureSpreadsheet(CREDS, 'Export')
      .then(
        () => null,
        (err: unknown) => err,
      );

    // Not retryable: creating again would just make a second orphan sheet.
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).message).toBe(
      'create returned no spreadsheetId',
    );
    expect((error as ExternalServiceError).retryable).toBe(false);
  });

  it('authenticates with the credentials it was handed', async () => {
    await makeClient().ensureSpreadsheet({ ...CREDS, spreadsheetId: 'sheet-1' }, 'Export');

    expect(setCredentials).toHaveBeenCalledWith({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expiry_date: 1_777_000_000_000,
    });
  });
});

describe('GoogleSheetsClient.writeSheet', () => {
  const ROWS: SheetRow[] = [
    ['Name', 'Phone', 'Budget'],
    ['Asha Rao', '+919876543210', '8500000'],
  ];

  it('replaces the tab contents: clear, then write from A1', async () => {
    await makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', ROWS);

    expect(valuesClear).toHaveBeenCalledWith({ spreadsheetId: 'sheet-1', range: 'Leads' });
    expect(valuesUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      range: 'Leads!A1',
      // RAW, so a phone number like +919876543210 is not reinterpreted as a
      // formula or reformatted into scientific notation.
      valueInputOption: 'RAW',
      requestBody: { values: ROWS },
    });
  });

  it('clears before it writes', async () => {
    // The other order leaves the tail of a longer previous export sitting
    // below the new rows, where it reads as current inventory.
    await makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', ROWS);

    expect(valuesClear.mock.invocationCallOrder[0]!).toBeLessThan(
      valuesUpdate.mock.invocationCallOrder[0]!,
    );
  });

  it('reuses an existing tab rather than adding a duplicate', async () => {
    spreadsheetsGet.mockResolvedValue({
      data: { sheets: [{ properties: { title: 'Inventory' } }, { properties: { title: 'Leads' } }] },
    });

    await makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', ROWS);

    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('creates the tab when it is missing', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Leads' } }] } });

    await makeClient().writeSheet(CREDS, 'sheet-1', 'Inventory', ROWS);

    expect(batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      requestBody: { requests: [{ addSheet: { properties: { title: 'Inventory' } } }] },
    });
  });

  it('creates the tab when the spreadsheet reports no sheets at all', async () => {
    spreadsheetsGet.mockResolvedValue({ data: {} });

    await makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', ROWS);

    expect(batchUpdate).toHaveBeenCalled();
  });

  it('tolerates a sheet entry with no properties', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { sheets: [{}, { properties: {} }] } });

    await expect(makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', ROWS)).resolves.toBeUndefined();
    expect(batchUpdate).toHaveBeenCalled();
  });

  it('creates the tab before clearing it', async () => {
    spreadsheetsGet.mockResolvedValue({ data: { sheets: [] } });

    await makeClient().writeSheet(CREDS, 'sheet-1', 'Inventory', ROWS);

    // Clearing a range on a tab that does not exist is a 400 from Google.
    expect(batchUpdate.mock.invocationCallOrder[0]!).toBeLessThan(
      valuesClear.mock.invocationCallOrder[0]!,
    );
  });

  it('writes an empty sheet without special-casing it', async () => {
    // An export that legitimately has no rows must still clear the tab, or
    // last week's data stays visible.
    await makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', []);

    expect(valuesClear).toHaveBeenCalled();
    expect(valuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { values: [] } }),
    );
  });

  it('propagates a write failure to the caller', async () => {
    // The export processor retries on rejection; a swallowed error would
    // report a successful export that never landed.
    valuesUpdate.mockRejectedValue(new Error('The caller does not have permission'));

    await expect(makeClient().writeSheet(CREDS, 'sheet-1', 'Leads', ROWS)).rejects.toThrow(
      /does not have permission/,
    );
  });
});
