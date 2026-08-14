import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@gosumo/shared';

import { fetchWithTimeout } from '../../common/utils/http-timeout.util';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface GoogleTokenSet {
  accessToken: string;
  /** Only returned on the first consent (offline access). */
  refreshToken: string | null;
  /** UTC instant the access token expires. */
  expiresAt: Date;
  scope: string | null;
}

export interface GoogleCalendarEventInput {
  summary: string;
  description?: string;
  /** UTC start instant. */
  startAt: Date;
  /** UTC end instant. */
  endAt: Date;
  /** IANA timezone for display in the event. */
  timeZone: string;
  location?: string;
  /** Email reminders/popups handled by Google before the event. */
  reminderMinutes?: number[];
}

export interface GoogleCalendarEventResult {
  eventId: string;
  htmlLink?: string;
  status: string;
}

/**
 * Gateway contract for Google Calendar. Swap for a mock in tests.
 */
export interface IGoogleCalendarGateway {
  getAuthUrl(state: string, redirectUri?: string): string;
  exchangeCode(code: string, redirectUri?: string): Promise<GoogleTokenSet>;
  refreshAccessToken(refreshToken: string): Promise<GoogleTokenSet>;
  createEvent(
    accessToken: string,
    calendarId: string,
    event: GoogleCalendarEventInput,
  ): Promise<GoogleCalendarEventResult>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleCalendarEventInput,
  ): Promise<GoogleCalendarEventResult>;
  deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
  ): Promise<void>;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * GoogleCalendarService — thin REST client for Google Calendar + OAuth2.
 *
 * Implemented with `fetch` (no SDK dependency), mirroring how
 * `razorpay.service.ts` wraps Razorpay. Credentials come from ConfigService:
 * `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`.
 */
@Injectable()
export class GoogleCalendarService implements IGoogleCalendarGateway {
  private readonly logger = new Logger(GoogleCalendarService.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly defaultRedirectUri: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('GOOGLE_CLIENT_ID', '');
    this.clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET', '');
    this.defaultRedirectUri = this.configService.get<string>(
      'GOOGLE_OAUTH_REDIRECT_URI',
      '',
    );

    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'Google OAuth credentials not configured. Calendar sync will be unavailable.',
      );
    }
  }

  /**
   * Build the consent URL. `state` carries the businessId (and optionally staff)
   * so the callback can route the returned code. We request offline access so a
   * refresh token is issued on first consent.
   */
  getAuthUrl(state: string, redirectUri?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri ?? this.defaultRedirectUri,
      response_type: 'code',
      scope: CALENDAR_SCOPE,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri?: string): Promise<GoogleTokenSet> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri ?? this.defaultRedirectUri,
      grant_type: 'authorization_code',
    });
    return this.requestToken(body);
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenSet> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
    });
    const tokens = await this.requestToken(body);
    // Refresh responses omit the refresh token — preserve the caller's.
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    event: GoogleCalendarEventInput,
  ): Promise<GoogleCalendarEventResult> {
    const result = await this.calendarRequest<{
      id: string;
      htmlLink?: string;
      status: string;
    }>(
      accessToken,
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      this.toGoogleEvent(event),
    );
    return { eventId: result.id, htmlLink: result.htmlLink, status: result.status };
  }

  async updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: GoogleCalendarEventInput,
  ): Promise<GoogleCalendarEventResult> {
    const result = await this.calendarRequest<{
      id: string;
      htmlLink?: string;
      status: string;
    }>(
      accessToken,
      'PUT',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      this.toGoogleEvent(event),
    );
    return { eventId: result.id, htmlLink: result.htmlLink, status: result.status };
  }

  async deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
  ): Promise<void> {
    await this.calendarRequest<unknown>(
      accessToken,
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private toGoogleEvent(event: GoogleCalendarEventInput): Record<string, unknown> {
    return {
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: event.startAt.toISOString(), timeZone: event.timeZone },
      end: { dateTime: event.endAt.toISOString(), timeZone: event.timeZone },
      reminders: event.reminderMinutes?.length
        ? {
            useDefault: false,
            overrides: event.reminderMinutes.map((minutes) => ({
              method: 'popup',
              minutes,
            })),
          }
        : { useDefault: true },
    };
  }

  private async requestToken(body: URLSearchParams): Promise<GoogleTokenSet> {
    const response = await fetchWithTimeout(
      GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      { service: 'Google OAuth' },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `Google token request failed: ${response.status} ${response.statusText} — ${errorBody}`,
      );
      throw new ExternalServiceError('Google OAuth', 'token request failed', {
        status: response.status,
        context: { body: errorBody },
      });
    }

    const json = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: json.scope ?? null,
    };
  }

  private async calendarRequest<T>(
    accessToken: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetchWithTimeout(
      `${GOOGLE_CALENDAR_API}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      { service: 'Google Calendar' },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `Google Calendar API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
      throw new ExternalServiceError('Google Calendar', `API error ${response.status}`, {
        status: response.status,
        context: { body: errorBody },
      });
    }

    // DELETE returns 204 No Content.
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    return response.json() as Promise<T>;
  }
}
