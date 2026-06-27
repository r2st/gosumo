# GoSumo Dashboard App

Next.js 14 frontend for GoSumo operators. Provides the conversation inbox, HITL task queue, analytics dashboards, catalog management, booking calendar, campaign management, and business settings. Runs on port 3001.

## Commands

```bash
# From repo root
pnpm --filter @gosumo/dashboard dev     # Dev server on :3001
pnpm --filter @gosumo/dashboard build   # Production build
pnpm --filter @gosumo/dashboard lint    # ESLint + Next.js lint

# From apps/dashboard/
next dev -p 3001
next build && next start -p 3001
```

## Tech Stack

- **Next.js 14** with App Router
- **TypeScript strict** mode
- **React** — UI components
- **Socket.IO client** — real-time task notifications and typing indicators
- API communication via `fetch` to `@gosumo/api` (REST + WebSocket)

## Architecture

```
src/
  app/              # Next.js App Router pages
    (auth)/         # Login, MFA setup (no layout)
    (dashboard)/    # Main layout with sidebar
      conversations/    # Conversation inbox
      tasks/            # HITL task queue
      clients/          # Client profiles
      catalog/          # Product/service management
      bookings/         # Appointment calendar
      campaigns/        # Campaign management
      analytics/        # Reports and KPIs
      settings/         # Business profile, channels, AI config, team
  components/       # Shared UI components
  hooks/            # Custom React hooks (useSocket, useAuth, etc.)
  lib/              # API client, auth helpers, type definitions
  stores/           # Client-side state (Zustand or React context)
```

## API Communication

- All API calls go to `process.env.NEXT_PUBLIC_API_URL` (defaults to `http://localhost:3000`)
- Auth tokens stored in memory (not localStorage) — access token refreshed from HttpOnly cookie
- API client lives in `src/lib/api-client.ts` — wraps fetch with auth headers and error handling

## Real-Time (Socket.IO)

- Dashboard connects to Socket.IO on login: `io(API_URL, { auth: { token: accessToken } })`
- Joins room `business:{businessId}` automatically
- Listens for: `task.created`, `task.assigned`, `conversation.updated`, `message.received`
- Typing indicators: emits `typing.start` / `typing.stop` when operator types in reply box

## Key Gotchas

- **Never store access tokens in localStorage** — keep in memory only; refresh via HttpOnly cookie silently
- All monetary values from API are in paise — convert to rupees using `paiseToRupees()` before displaying
- All timestamps from API are UTC — convert to IST (`Asia/Kolkata`) using the date utils from `@gosumo/shared`
- The dashboard uses **server components** where possible for initial data load (SSR), then hydrates with client components for real-time updates
- `@Public()` routes on the API (login, webhooks) do not require auth headers — do not send the Authorization header to these endpoints
- MFA setup is required on first login — redirect to `/setup-mfa` if `requiresMfa: true` in the login response
- The task queue badge count is kept in sync via Socket.IO events, not by polling

## Development Notes

- No tests written yet (`"test": "echo 'No tests yet'"` in package.json) — this is a known gap; add Playwright E2E tests as a priority
- Use `pnpm docker:up` before starting the dashboard to ensure the API and its dependencies are running
