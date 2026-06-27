import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GoogleCalendarService } from './google-calendar.service';

const CONFIG: Record<string, string> = {
  GOOGLE_CLIENT_ID: 'client-id-123',
  GOOGLE_CLIENT_SECRET: 'client-secret-456',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://app.gosumo.in/oauth/google',
};

function mockFetchOnce(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  (global as unknown as { fetch: jest.Mock }).fetch = fn;
  return fn;
}

describe('GoogleCalendarService', () => {
  let service: GoogleCalendarService;
  const realFetch = global.fetch;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleCalendarService,
        {
          provide: ConfigService,
          useValue: { get: (key: string, def: string) => CONFIG[key] ?? def },
        },
      ],
    }).compile();
    service = module.get<GoogleCalendarService>(GoogleCalendarService);
  });

  afterEach(() => {
    (global as unknown as { fetch: typeof realFetch }).fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('getAuthUrl', () => {
    it('builds a consent URL with offline access and state', () => {
      const url = service.getAuthUrl('biz-1');
      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=client-id-123');
      expect(url).toContain('access_type=offline');
      expect(url).toContain('state=biz-1');
      expect(url).toContain('prompt=consent');
      expect(url).toContain('calendar.events');
    });

    it('honours a custom redirect URI', () => {
      const url = service.getAuthUrl('biz-1', 'https://custom/cb');
      expect(decodeURIComponent(url)).toContain('https://custom/cb');
    });
  });

  describe('exchangeCode', () => {
    it('parses the token response and computes expiry', async () => {
      const fetchMock = mockFetchOnce({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.events',
      });

      const tokens = await service.exchangeCode('auth-code');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.refreshToken).toBe('rt-1');
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('throws when the token endpoint returns an error', async () => {
      mockFetchOnce({ error: 'invalid_grant' }, { ok: false, status: 400 });
      await expect(service.exchangeCode('bad')).rejects.toThrow(/token request failed/);
    });
  });

  describe('refreshAccessToken', () => {
    it('preserves the original refresh token when none is returned', async () => {
      mockFetchOnce({ access_token: 'at-2', expires_in: 3600 });
      const tokens = await service.refreshAccessToken('rt-original');
      expect(tokens.accessToken).toBe('at-2');
      expect(tokens.refreshToken).toBe('rt-original');
    });
  });

  describe('createEvent', () => {
    it('POSTs the event and returns the new event id', async () => {
      const fetchMock = mockFetchOnce({
        id: 'evt-1',
        htmlLink: 'https://calendar/evt-1',
        status: 'confirmed',
      });

      const result = await service.createEvent('at-1', 'primary', {
        summary: 'Haircut',
        startAt: new Date('2026-06-27T03:30:00Z'),
        endAt: new Date('2026-06-27T04:00:00Z'),
        timeZone: 'Asia/Kolkata',
        reminderMinutes: [60],
      });

      expect(result.eventId).toBe('evt-1');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain('/calendars/primary/events');
      expect(init.method).toBe('POST');
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody.summary).toBe('Haircut');
      expect(sentBody.start.timeZone).toBe('Asia/Kolkata');
      expect(sentBody.reminders.overrides[0].minutes).toBe(60);
    });
  });

  describe('updateEvent', () => {
    it('PUTs to the event path', async () => {
      const fetchMock = mockFetchOnce({ id: 'evt-1', status: 'confirmed' });
      await service.updateEvent('at-1', 'primary', 'evt-1', {
        summary: 'Haircut (rescheduled)',
        startAt: new Date('2026-06-28T03:30:00Z'),
        endAt: new Date('2026-06-28T04:00:00Z'),
        timeZone: 'Asia/Kolkata',
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain('/calendars/primary/events/evt-1');
      expect(init.method).toBe('PUT');
    });
  });

  describe('deleteEvent', () => {
    it('handles a 204 No Content response', async () => {
      const fetchMock = mockFetchOnce(null, { ok: true, status: 204 });
      await expect(
        service.deleteEvent('at-1', 'primary', 'evt-1'),
      ).resolves.toBeUndefined();
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.method).toBe('DELETE');
    });

    it('throws on an API error', async () => {
      mockFetchOnce({ error: 'notFound' }, { ok: false, status: 404 });
      await expect(
        service.deleteEvent('at-1', 'primary', 'missing'),
      ).rejects.toThrow(/Google Calendar API error/);
    });
  });
});
