# GoSumo Web Dashboard — `@gosumo/web`

Next.js 14 (App Router) operator dashboard. Runs on port 3001.

## Commands

```bash
pnpm --filter @gosumo/web dev      # dev server :3001
pnpm --filter @gosumo/web build    # production build
pnpm --filter @gosumo/web lint
pnpm --filter @gosumo/web typecheck
```

## Conventions

- **Server state** lives in React Query hooks (`src/hooks/use-queries.ts`). Components never
  call `api.*` directly except inside those hooks (and the auth provider).
- **API client** is `src/lib/api-client.ts`; it appends `/v1` to `NEXT_PUBLIC_API_URL`,
  attaches the Bearer token, and refreshes once on `401`.
- **Auth** is in `src/providers/auth-provider.tsx`. Access token in memory only; refresh token
  in `token-store.ts`. The dashboard route group is guarded by `DashboardShell`.
- **Money** is always in paise from the API — render with `paiseToRupees()` / `paiseToCompactRupees()`.
- **Times** are UTC from the API — render with the IST helpers in `src/lib/format.ts`.
- **Types** mirror `API_DESIGN.md` and live in `src/lib/types.ts` (kept local, not imported
  from `@gosumo/shared`, so the frontend builds independently).
- **Styling** uses Tailwind with semantic tokens (`bg-primary`, `text-muted-foreground`, …)
  defined in `globals.css`. Prefer the UI primitives in `src/components/ui/`.

## Security headers

`next.config.mjs`'s `headers()` applies `src/lib/security-headers.mjs` to every route.
Caddy's site block already sent `nosniff`, `X-Frame-Options` and HSTS — which made the
audit look clean while the three that matter more for an origin that actually runs script
were missing entirely: no CSP, no `Referrer-Policy` (dashboard paths carry lead and
conversation ids, and they rode along to every external host a page linked to), no
`Permissions-Policy`. They live in the app rather than the Caddyfile because the Caddyfile
is not in this repo, so a header set there is invisible to CI and to anyone reading the code.

- The file is **`.mjs`** so `next.config.mjs` can import it — Next 14 has no TypeScript
  config support, and a header list that only exists inside the config object cannot be
  tested. `security-headers.test.ts` is the assertion.
- `headers()` is resolved at **build time** into the routes manifest, which is why the CSP
  reads `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` there — the same values the client
  bundle is compiled against, so the policy cannot disagree with the origin the app calls.
  `connect-src` needs the `wss://` form separately; it matches on scheme.
- **`script-src` keeps `'unsafe-inline'`, knowingly.** `layout.tsx` inlines
  `themeInitScript` and `langInitScript` to apply the saved theme before first paint, and
  Next's hydration bootstrap is inline too. Removing it means a per-request nonce, which
  means a `middleware.ts` and forcing every page onto dynamic rendering — its own piece of
  work. What the policy buys meanwhile: `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'` (the primitives `unsafe-inline` does *not* cover), `frame-ancestors`,
  and a `connect-src` narrowed to the one API. `'unsafe-eval'` is dev-only (Fast Refresh).
- `img-src` must keep `https:` in step with `next.config.mjs`'s `remotePatterns` — an image
  host allowed by one and blocked by the other is a broken avatar with an error only in the
  browser console.

Cookies go through `src/lib/preference-cookie.ts` — the only two are theme and UI language,
and both are now `Secure` on https. `HttpOnly` is impossible (they are written by
`document.cookie`) and pointless here; the session tokens that would want it are not cookies
at all — access token in memory, refresh in `token-store.ts`. `SameSite=Lax` rather than
`Strict` is deliberate: `Strict` withholds the cookie on the first navigation in from an
external link, which is the one request that would flash the wrong theme.

## Key gotchas

- Client components that read `useSearchParams()` must be wrapped in `<Suspense>` (Next build rule).
- `ConversationStatus` follows `API_DESIGN.md` (`OPEN | PENDING | RESOLVED | ESCALATED | BOT_HANDLING`),
  which differs from the backend's internal `@gosumo/shared` enum.
- `POST /auth/register` and `GET /auth/google` are assumed conventional paths (not yet in API_DESIGN.md).
