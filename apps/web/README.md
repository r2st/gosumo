# @gosumo/web

The GoSumo operator dashboard — a Next.js 14 (App Router) + React + Tailwind CSS frontend
for the AI-powered client management platform. GoSumo is a [DoAide](https://doaide.com) product.

## Stack

- **Next.js 14** (App Router, TypeScript strict)
- **Tailwind CSS** for styling (design tokens via CSS variables in `globals.css`)
- **TanStack Query (React Query)** for server state
- **Recharts** for charts
- **Lucide React** for icons

## Getting started

```bash
# from the monorepo root
pnpm install

# configure the API endpoint
cp apps/web/.env.example apps/web/.env.local
# edit NEXT_PUBLIC_API_URL to point at the running NestJS API (default http://localhost:3000)

pnpm --filter @gosumo/web dev      # http://localhost:3001
pnpm --filter @gosumo/web build    # production build
pnpm --filter @gosumo/web lint
```

## Structure

```
src/
  app/
    (auth)/        login, register, forgot/reset password
    (dashboard)/   dashboard, conversations, clients, catalog,
                   orders, bookings, payments, analytics, settings
  components/      UI primitives + feature components (conversations, dashboard, layout)
  hooks/           React Query hooks (use-queries.ts)
  lib/             api-client, types, formatting & utils, token store
  providers/       auth + query client providers
```

## API integration

- All requests target `${NEXT_PUBLIC_API_URL}/v1` (see `src/lib/api-client.ts`).
- The **access token is held in memory only**; the refresh token bootstraps the session
  on reload. The client transparently refreshes once on a `401` and replays the request.
- Monetary values arrive in **paise** and are formatted to ₹ with `paiseToRupees()`.
- Timestamps arrive in **UTC** and are displayed in **IST** (`Asia/Kolkata`).

## Notes / assumptions

A couple of endpoints the UI needs are not yet enumerated in `API_DESIGN.md`; the client
uses the conventional paths and they are isolated in `api.auth`:

- `POST /v1/auth/register` — business signup (mirrors the login response shape).
- `GET  /v1/auth/google` — Google OAuth entry point (backend completes the handshake).
