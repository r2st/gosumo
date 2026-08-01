# GoSumo — PROJECT_INFO

**Channel-agnostic AI client-management platform for small businesses in India — WhatsApp, Instagram, SMS, web chat and email handled through one AI interface.**

- **Repo:** https://github.com/r2st/gosumo · branch `main`
- **Local path:** `Products/GoSumo`

## Tech stack

| Layer | Technology |
|---|---|
| Language | Node 20 + TypeScript |
| Monorepo | pnpm workspaces + Turborepo (`turbo.json`, `pnpm-workspace.yaml`) |
| Layout | `apps/` (api, web) · `packages/` (incl. `@gosumo/database`) |
| ORM | Prisma |
| Database | PostgreSQL |
| Cache/queue | Redis |
| Vector store | Qdrant |
| LLM | Anthropic (+ OpenRouter) |
| Comms | Twilio; WhatsApp / Instagram / SMS / email channel adapters |
| Auth | Google OAuth |
| Container | Docker Compose (`docker/docker-compose.yml`, `docker-compose.prod.yml`, `docker-compose.deploy.yml`) |

Design docs in the repo root: `ARCHITECTURE.md`, `API_DESIGN.md`, `DATABASE_DESIGN.md`,
`AI_ENGINE_DESIGN.md`, `MODULES.md`, `DEPLOYMENT.md`, `DEVELOPMENT_GUIDE.md`, `SPRINT_PLAN.md`.

## Deploy location

| | |
|---|---|
| Host | Hetzner `89.167.8.178` — shared with Herald, TalentPing, Documedic, HomeNex, Knol |
| Code | `/opt/gosumo` — git checkout, `git pull origin main` |
| Public URL | https://api.gosumo.aiknol.com (webchat widget); `api.gosumo.app` / `app.gosumo.app` per `DEPLOYMENT.md` |
| Ports | `127.0.0.1:3001→3000` api (also 3002 per Herald's port map) · `5432`/`5433` postgres · `6379`/`6380` redis · `6333` qdrant — all loopback-only |
| Ingress | Cloudflare Tunnel — the VPS keeps 80/443 closed; only outbound 443 and SSH are open |
| Dashboard | Cloudflare Pages |
| Monitoring | uptime-kuma against `/api/health` |

## SSH key

`keys/hetzner_deploy_ed25519` (+ `.pub`) — **this project holds the canonical copy**; Herald's
deploy docs point at this path. Host IP at `keys/hetzner_vps_ip`.

```bash
ssh -i keys/hetzner_deploy_ed25519 root@89.167.8.178
```

> The same key is duplicated into HomeNex, Documedic, TalentPing, `knol/keys/` and
> `Hackathons/keys/`. One compromise takes every Hetzner target with it —
> see `~/projects/keys/KEYS_INDEX.md` §4.

## Environment variables

| Where | What |
|---|---|
| `.env.prod` (gitignored) | Anthropic, Qdrant, Google OAuth, Twilio |
| `keys/` (gitignored) | `Cloudfare_token.txt`, `Git_token.txt`, `sendgrid.txt`, `test-accounts`, `hetzner_*` |
| **Server** | **`/opt/gosumo/.env.prod`** — runtime app secrets live only on the VPS |

Note `deploy.sh` has the production `DATABASE_URL`, password included, hardcoded in the
migration step — worth moving into `.env.prod`.

## Key commands

```bash
pnpm install
pnpm docker:up                 # docker/docker-compose.yml
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev                       # turbo dev

pnpm build
pnpm test                      # turbo test
pnpm test:unit | test:integration | test:e2e
pnpm lint

# Deploy (run on the server)
ssh root@89.167.8.178
cd /opt/gosumo && bash deploy.sh
```

⚠️ This working copy currently has ~389 uncommitted changes, including `_tmp_*` scratch files
and `note.txt`. Worth a cleanup pass and a `.gitignore` entry for `_tmp_*`.

## Related projects

- [`../Herald`](../Herald), [`../TalentPing`](../TalentPing), [`../Documedic`](../Documedic), [`../HomeNex`](../HomeNex) — same Hetzner box, **same SSH deploy key**
- `Hackathons/healthfirst-clinic-demo` — demo site showcasing GoSumo patient comms
- `knol/memorylayer` — backs the `*.aiknol.com` estate
- `~/projects/PROJECT-INDEX.md`, `~/projects/keys/KEYS_INDEX.md` — estate-wide index
