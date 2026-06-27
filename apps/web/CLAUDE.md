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

## Key gotchas

- Client components that read `useSearchParams()` must be wrapped in `<Suspense>` (Next build rule).
- `ConversationStatus` follows `API_DESIGN.md` (`OPEN | PENDING | RESOLVED | ESCALATED | BOT_HANDLING`),
  which differs from the backend's internal `@gosumo/shared` enum.
- `POST /auth/register` and `GET /auth/google` are assumed conventional paths (not yet in API_DESIGN.md).
