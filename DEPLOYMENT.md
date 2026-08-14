# GoSumo — Deployment Strategy (Hetzner + Cloudflare)

> Cost-optimized, production-ready deployment for an early-stage Indian SaaS.
> **Design goal:** run the entire MVP for **under $30/month** on a single Hetzner VPS,
> with Cloudflare providing the edge (DNS, CDN, TLS, DDoS, rate limiting) for **$0**.
> Scale by moving stateful services onto their own boxes — not by rewriting anything.

This document covers the **single-box → split → HA** progression. The same
`docker-compose.prod.yml`, `Dockerfile.api`, and `deploy.yml` shipped alongside this
file drive every stage; only the host topology changes.

---

## 0. TL;DR

| Stage | Hetzner | Monthly (infra only) | Good for |
|---|---|---|---|
| **MVP** | 1× CAX21 (4 vCPU ARM, 8 GB) + Storage Box | **≈ $13–15** | First customers, < ~50 businesses |
| **Growth** | 1× CAX31 (8 vCPU, 16 GB) + Storage Box | ≈ $20–22 | Steady load, light HITL |
| **Scale** | CAX31 app box + CCX23 dedicated DB box + Storage Box | ≈ $55–70 | Noisy-neighbour isolation, real backups |

> Prices are Hetzner list prices in EUR converted at ~€1 ≈ $1.09, **excluding VAT**
> and **excluding usage-based costs** (Anthropic API, WhatsApp conversation fees,
> Razorpay MDR) which are not infrastructure. Anthropic spend will typically dwarf
> infra once you have real traffic — budget it separately per-tenant.

**Why this architecture:** Hetzner gives the cheapest reliable compute in the
market (ARM Ampere instances are ~half the price of equivalent AWS/GCP), and
Cloudflare's free tier covers everything an early SaaS needs at the edge. The only
thing you self-manage is one Linux box running Docker Compose — deliberately boring.

---

## 1. Infrastructure Layout (Hetzner)

### 1.1 Why Hetzner Cloud (not dedicated, yet)

- **Hetzner Cloud VPS** (hourly-billed, snapshot/resize in minutes) is the right
  product until a single box is genuinely saturated.
- **ARM (CAX series, Ampere Altra)** is the price/perf sweet spot. Node.js 20,
  PostgreSQL 16, Redis 7, and Qdrant all have native `linux/arm64` images, so there
  is no emulation penalty. The shipped `Dockerfile.api` is multi-arch-friendly
  (`node:20-alpine`).
- **Dedicated (CCX line / Hetzner Robot)** only becomes worth it when the DB needs
  guaranteed dedicated vCPU — i.e. the "Scale" stage below.
- **Region:** choose **`hel1` (Helsinki)** or **`nbg1`/`fsn1` (Germany)**. Hetzner
  has no India region; Cloudflare's CDN + Indian PoPs absorb most of the latency for
  static/dashboard assets, and the API's p95 budget (200 ms server-side) is
  unaffected by EU hosting since webhooks/messaging are async. *(If India data
  residency becomes a contractual requirement, plan a lift to an Indian provider —
  the Compose stack is portable.)*

### 1.2 Server specs

| Tier | Type | vCPU / RAM / Disk | Runs | List price |
|---|---|---|---|---|
| **MVP / Staging** | **CAX21** | 4 ARM / 8 GB / 80 GB | api, worker, postgres, redis, qdrant, cloudflared, uptime-kuma | ≈ €7.49 (**$8.2**)/mo |
| **Production (growth)** | **CAX31** | 8 ARM / 16 GB / 160 GB | same, with headroom | ≈ €14.39 (**$15.7**)/mo |
| **Production app box** | **CAX31** | 8 / 16 / 160 | api, worker, redis, qdrant, cloudflared | ≈ €14.39 (**$15.7**)/mo |
| **Production DB box** | **CCX23** (dedicated) | 4 ded / 16 GB / 160 GB | postgres only | ≈ €30 (**$33**)/mo |

> **Staging vs production:** staging can be a second, smaller box (**CAX11**, 2 vCPU /
> 4 GB, ≈ $4.2/mo) or simply a separate Compose project on the same MVP box using a
> distinct `.env.prod` and database. For true pre-prod parity, run a separate CAX11.

### 1.3 Memory budget on the 8 GB MVP box

The shipped `docker-compose.prod.yml` sets conservative `deploy.resources.limits`.
On a **CAX21 (8 GB)**, tune them so the sum leaves ~1 GB for the host:

| Service | RAM limit (CAX21) | Notes |
|---|---|---|
| postgres | 2.0 GB | `shared_buffers` ≈ 512 MB |
| qdrant | 1.5 GB | grows with vector count; watch it |
| api | 1.0 GB | NestJS + Prisma |
| worker | 1.0 GB | BullMQ processors |
| redis | 0.75 GB | `maxmemory 384mb` + AOF, **`noeviction`** (BullMQ safety) |
| uptime-kuma | 0.25 GB | |
| cloudflared | 0.1 GB | |
| **host reserve** | ~1.4 GB | kernel, Docker, ssh |

When this gets tight (Qdrant + Postgres are the first to hurt), move to **CAX31
(16 GB)** — a one-command `hcloud server change-type` resize with a single reboot.

### 1.4 Database hosting — self-managed PostgreSQL on the VPS

**Hetzner has no managed PostgreSQL offering.** Options, in order of preference for
this stage:

1. **Self-managed Postgres 16 in Docker on the VPS (chosen).** Cheapest, full
   control, RLS works out of the box (required by GoSumo's multi-tenant model in
   `ARCHITECTURE.md §7`). You own backups (see §7.2).
2. **Split Postgres onto a dedicated CCX box** at the Scale stage for I/O isolation
   from the AI workers.
3. **External managed (Neon / Supabase / Aiven)** only if you want point-in-time
   recovery without operating it yourself — adds ~$20–25/mo and egress latency to
   the EU. Defer until a customer contractually needs managed RPO/RTO.

> Postgres data lives on the named volume `postgres-data`. For the Scale tier,
> attach a **Hetzner Volume** (€0.0052/GB·mo ≈ $0.55 per 10 GB) so storage scales
> independently of the instance and survives a re-create.

### 1.5 Redis & Qdrant hosting

- **Redis 7** — self-hosted container. Critical config (already in the prod compose):
  `--appendonly yes` for durability and **`--maxmemory-policy noeviction`** so BullMQ
  jobs are *never* evicted under memory pressure. Password-protected via
  `REDIS_PASSWORD`. Bound to `127.0.0.1` only.
- **Qdrant** — self-hosted container, API-key protected
  (`QDRANT__SERVICE__API_KEY`), bound to `127.0.0.1`. Partition collections by
  `businessId` payload filter per `ARCHITECTURE.md §7 Layer 5`. **Qdrant Cloud** has
  a free 1 GB tier if you'd rather offload it — fine for early RAG volumes, revisit
  when the working set exceeds ~1 GB.

### 1.6 Object storage (media files)

GoSumo stores media (`MessageContent` IMAGE/DOCUMENT). Use an **S3-compatible**
bucket — **Hetzner Object Storage** (S3 API, EU) or **Cloudflare R2** (10 GB free,
**zero egress fees** — a strong fit since media is served back through Cloudflare).
**Recommendation: Cloudflare R2** for the free egress alone. Point `S3_*` env vars at
the R2 endpoint.

---

## 2. Cloudflare Setup (the entire edge, for $0)

All of the following are on Cloudflare's **Free** plan unless noted.

### 2.1 DNS
- Move the domain's nameservers to Cloudflare (authoritative DNS, free, fast).
- Records:
  - `api.gosumo.app` → **CNAME to the tunnel** (Cloudflare manages this when you
    create the tunnel route — no A record to the VPS IP).
  - `app.gosumo.app` (dashboard) → Cloudflare Pages (auto).
  - `gosumo.app` → Pages or redirect to `app.`.
- **The VPS public IP is never published in DNS.** Ingress is exclusively via the
  Cloudflare Tunnel (§2.5).

### 2.2 CDN / frontend (Next.js)
Two valid hosting models for the `dashboard` app:

- **Recommended — Cloudflare Pages** (free): connect the GitHub repo, build the
  Next.js dashboard, deploy globally to Cloudflare's edge with automatic preview
  deployments per PR. Zero infra cost, served from Indian PoPs, frees ~250 MB RAM on
  the VPS. Use `@cloudflare/next-on-pages` for App Router/SSR support, or static
  export if the dashboard is mostly client-rendered against the API.
- **Alternative — containerize the dashboard** on the VPS behind the same tunnel.
  Only do this if you need Node SSR features Pages can't host. Costs RAM you don't
  have to spend.

> Either way, the dashboard talks to `https://api.gosumo.app`, which is proxied
> (orange-cloud) so the API also benefits from Cloudflare caching/WAF.

### 2.3 SSL/TLS — Full (Strict)
- Set SSL/TLS mode to **Full (Strict)**.
- Because ingress is a **Cloudflare Tunnel**, the origin connection is already an
  authenticated, encrypted outbound tunnel — there is **no inbound 443 to terminate
  on the VPS** and no public origin cert to manage. Cloudflare presents a valid edge
  cert to clients; the tunnel secures edge↔origin. (If you ever expose the origin
  directly instead of tunnelling, install a **Cloudflare Origin Certificate** on the
  box and keep Full Strict.)
- Enable **Always Use HTTPS**, **HSTS** (max-age 6 months, includeSubDomains), and
  **TLS 1.3**. This matches `ARCHITECTURE.md §11` (TLS 1.3 everywhere, HSTS).

### 2.4 DDoS protection
- Cloudflare's **unmetered L3/L4/L7 DDoS mitigation** is automatic on all plans,
  including Free. Because the origin is only reachable through the tunnel, volumetric
  attacks hit Cloudflare's edge, never the VPS.

### 2.5 Cloudflare Tunnel vs direct exposure — **use the Tunnel**
- The `cloudflared` service in the prod compose runs a named tunnel using
  `CLOUDFLARE_TUNNEL_TOKEN` (created in **Zero Trust → Networks → Tunnels**).
- Route `api.gosumo.app` → `http://api:3000` inside the tunnel config.
- **Result: the VPS firewall keeps ports 80/443 closed.** Only outbound 443 (the
  tunnel) and your locked-down SSH port are open. This is strictly safer than
  publishing the origin and allow-listing Cloudflare IP ranges.

### 2.6 Rate limiting
- **WAF custom rules** (Free includes a limited number) — block/challenge obvious
  abuse (bad user-agents, path scanning).
- **Rate Limiting Rules** — Free tier allows one rule; apply it to the most abusable
  surface:
  - `POST /api/auth/*` → e.g. 10 req/min per IP (brute-force / credential stuffing).
- **Webhook endpoints** (`/api/webhooks/*`) must **not** be rate-limited by IP at the
  edge (Meta/Razorpay send from rotating IPs and you can burst). Protect them instead
  with **HMAC-SHA256 signature verification in-app** (already mandated by
  `CLAUDE.md` rule #3) — that is the real defense, not edge rate limiting.
- Application-level per-tenant rate limits stay in the API (Redis-backed), since only
  the app knows `businessId`.

---

## 3. Docker Deployment

### 3.1 Files in this repo
| File | Purpose |
|---|---|
| `docker/Dockerfile.api` | Multi-stage production image for the NestJS API + worker (same image, two entrypoints). |
| `docker-compose.prod.yml` | Full prod/staging stack: api, worker, postgres, redis, qdrant, cloudflared, uptime-kuma. |
| `docker/docker-compose.yml` | Existing **local dev** datastores only (unchanged). |

### 3.2 Image & registry — GitHub Container Registry (GHCR)
- Images publish to `ghcr.io/r2st/gosumo-api` (free for public; free quota for
  private). CI authenticates with the built-in `GITHUB_TOKEN` — no extra secret.
- Tags: `latest` (moving) + `sha-<short>` (immutable, for rollbacks).
- **Rollback** = re-deploy a previous SHA tag:
  `IMAGE_TAG=sha-abc1234 docker compose -f docker-compose.prod.yml up -d api worker`.

### 3.3 Health checks & restart policies
- Every service declares a **`healthcheck`**; `api`/`worker` depend on datastores
  being `service_healthy` before they boot.
- **`restart: always`** on every long-lived service — survives crashes and host
  reboots (Docker starts on boot via systemd).
- The API exposes **`GET /api/health`** (add a NestJS `@nestjs/terminus` health
  controller that pings Postgres + Redis + Qdrant). The container `HEALTHCHECK`,
  Compose, Cloudflare, and Uptime Kuma all probe this one endpoint.
- **DB migrations** run automatically on API start via `prisma migrate deploy`
  (idempotent) — see the `api` service `command`.

### 3.4 Staging
Run the same compose file with a separate env file and project name:
```bash
docker compose -p gosumo-staging -f docker-compose.prod.yml --env-file .env.staging up -d
```

---

## 4. CI/CD Pipeline (GitHub Actions)

See `.github/workflows/deploy.yml`. Three jobs:

1. **`test`** (every push + PR): `pnpm install --frozen-lockfile` → Prisma generate →
   `pnpm lint` → `pnpm build` (type-check) → `pnpm test:unit`. PRs stop here.
2. **`build`** (push to `main` only): build `docker/Dockerfile.api` with Buildx,
   layer-cache via GitHub Actions cache, push `latest` + `sha-<short>` to GHCR.
3. **`deploy`** (push to `main` only): SSH into the Hetzner box (`appleboy/ssh-action`),
   `git pull` the repo at `/opt/gosumo`, `docker login ghcr.io`, `docker compose pull`,
   `up -d`, then `docker image prune -f` to reclaim disk on the small VPS.

**Auto-deploy on push to `main`** is therefore the default. (Gate the `deploy` job
behind a GitHub **`production` Environment** with a required reviewer if you want a
manual approval step before prod.)

### 4.1 Secrets & env management
- **GitHub Actions secrets:** `HETZNER_HOST`, `HETZNER_SSH_USER`, `HETZNER_SSH_KEY`
  (the deploy private key), `HETZNER_SSH_PORT`. GHCR uses `GITHUB_TOKEN`.
- **Runtime app secrets** live **only on the VPS** in `/opt/gosumo/.env.prod`
  (mode `600`, owner = deploy user). They are **never** in the repo, the image, or CI
  logs. The compose file reads them via `env_file:`.
- Required `.env.prod` keys (mirror `apps/api/.env.example` + infra):
  `DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `QDRANT_API_KEY`,
  `CLOUDFLARE_TUNNEL_TOKEN`, `OPENROUTER_API_KEY`, `JWT_SECRET`,
  `WHATSAPP_*`, `RAZORPAY_*`, `S3_*` (R2).
- `CORS_ORIGIN` must be set to the dashboard origin. Left unset the API falls
  back to `*` **with credentials disabled** and logs a warning at boot — the
  dashboard's authenticated calls will fail rather than be silently exposed.
- `ENABLE_SWAGGER` is **not** set in production. Swagger UI (`GET /v1/docs`)
  publishes every route, DTO and example, so it is left unmounted whenever
  `NODE_ENV=production`. Set it to the literal `true` only for a deliberate,
  temporary debugging window, and unset it afterwards; a 404 on `/v1/docs` in
  prod is the expected, healthy state.
- For stronger secret hygiene later: SOPS+age-encrypted `.env.prod` in the repo,
  decrypted on the box at deploy time; or Hetzner + HashiCorp Vault. Overkill for MVP.

> ⚠️ **Secrets are never committed.** The `keys/` directory (local SSH/deploy keys,
> tokens) and all `*token*.txt`, `*.pem`, `*.key`, `*_ed25519` files are in
> `.gitignore`. See §7.3.

---

## 5. Monitoring & Logging

Everything here is free or self-hosted.

### 5.1 Uptime & alerting — Uptime Kuma (self-hosted, in the stack)
- The `uptime-kuma` service monitors `https://api.gosumo.app/api/health` and the
  dashboard URL from *outside* the app's perspective.
- Configure notifications to **Telegram / Slack / email** (free) — primary alerting
  channel for "is it up".
- Also add an **external** check (e.g. **Better Stack / UptimeRobot** free tier) so
  you're alerted even if the whole VPS — Uptime Kuma included — goes down.

### 5.2 Metrics — optional, add at Growth stage
- Lightweight: **Grafana + Prometheus + cAdvisor + node-exporter** as extra compose
  services (≈ 300–400 MB RAM). Dashboards for CPU/RAM/disk, container health, Postgres
  and Redis metrics. Add only when the box has headroom (CAX31).
- Hosted-free alternative: **Grafana Cloud free tier** (10k series, 14-day retention)
  — no RAM cost on the VPS; ship metrics out via Grafana Agent.

### 5.3 Logs
- **Default:** Docker `json-file` driver with rotation (`max-size: 10m, max-file: 3`,
  already set via the `x-logging` anchor) — bounded disk, `docker compose logs -f`.
- **Aggregation (Growth):** **Grafana Loki + Promtail** (self-hosted, cheap) or
  **Grafana Cloud Loki** free tier. Query logs across api/worker/postgres in one place.
- **Error tracking:** **Sentry** (free tier: 5k errors/mo) — wire the NestJS SDK as
  in `ARCHITECTURE.md §13`. This is the highest-value observability add; do it first.
- **PII discipline:** per `ARCHITECTURE.md §11`, PII must be filtered from all logs.
  Keep customer message bodies out of logs; log IDs and `businessId`, not content.

### 5.4 What to alert on
- API `/health` failing (Uptime Kuma → Telegram).
- Disk > 80% on the VPS (node-exporter, or a cron + Uptime Kuma push monitor).
- BullMQ queue depth / failed jobs climbing (expose a metric; alert at threshold).
- Postgres connections near `max_connections`; Redis memory near `maxmemory`.

---

## 6. Cost Optimization

### 6.1 MVP monthly total (target: under $30) ✅

| Item | Product | Monthly (USD) |
|---|---|---|
| Compute | Hetzner **CAX21** (4 vCPU / 8 GB) | **$8.2** |
| Backups | Hetzner **Storage Box BX11** (1 TB) | **$4.2** |
| Snapshots | Hetzner snapshots (~20 GB @ €0.0119/GB) | ~$0.3 |
| Object storage | **Cloudflare R2** (≤10 GB free) | $0 |
| Edge | **Cloudflare Free** (DNS, CDN, TLS, DDoS, 1 rate-limit rule, Tunnel) | $0 |
| Frontend | **Cloudflare Pages** (free) | $0 |
| Registry | **GHCR** (free quota) | $0 |
| CI/CD | **GitHub Actions** (free tier minutes) | $0 |
| Monitoring | Uptime Kuma (self-host) + Sentry/Grafana free | $0 |
| **Infra total** | | **≈ $13 / month** |

> **Not included (usage-based, not infra):** Anthropic Claude API (the real variable
> cost — meter it per tenant and bake into pricing), WhatsApp Business conversation
> charges, Razorpay MDR, SMS gateway fees. Track these separately in `analytics`.

### 6.2 Scaling strategy as users grow
Vertical first, then split stateful, then go horizontal:

1. **Resize the box** (CAX21 → CAX31 → CAX41). One command, one reboot. Cheapest win.
2. **Split Postgres** onto a dedicated **CCX23** when DB I/O contends with AI workers.
   Move `DATABASE_URL` to the new box over the private network; no app changes.
3. **Split Redis/Qdrant** onto their own box if memory-bound.
4. **Horizontal API**: run multiple `api` replicas behind a small load balancer
   (Hetzner LB ≈ €5.4/mo) or multiple tunnel origins. The API is stateless (sessions
   in Redis), so this is config-only. Scale `worker` replicas independently by queue.
5. **Managed DB** (Neon/Aiven) only when you need point-in-time recovery / read
   replicas without operating them.
6. **Kubernetes** (per `ARCHITECTURE.md §10`) is the *eventual* target — defer it
   until you're running 3+ boxes and need real orchestration. Compose carries you a
   long way.

### 6.3 When to upgrade tiers (triggers)
- **CAX21 → CAX31:** sustained RAM > 80% or Postgres+Qdrant memory pressure / OOM.
- **Split DB box:** Postgres CPU steal or query p95 rising under worker load.
- **Add replicas / LB:** API CPU sustained > 70%, or you need zero-downtime deploys.
- **Hosted Loki/Grafana:** when self-hosted monitoring itself competes for VPS RAM.

---

## 7. Security

### 7.1 Firewall rules (defense in depth)

**Cloudflare (edge):**
- WAF managed + custom rules; rate limiting on `/api/auth/*` (§2.6).
- Full (Strict) TLS, HSTS, Always-HTTPS, TLS 1.3, Bot Fight Mode.

**Hetzner Cloud Firewall + host `ufw` (origin):**
| Port | Rule |
|---|---|
| 80 / 443 inbound | **CLOSED** — ingress is the Cloudflare Tunnel (outbound only). |
| SSH (22, or a custom port) | Allow **only** your admin IP(s); key-only auth. |
| Egress 443 | Allow (tunnel, Anthropic, Razorpay, Meta, GHCR, R2). |
| Datastore ports (5432/6379/6333) | **Never** exposed publicly — bound to `127.0.0.1`. |

Harden the host: disable SSH password auth & root login, install `fail2ban`, enable
unattended security upgrades, keep Docker rootless-ish (non-root user in image —
already done in `Dockerfile.api`).

### 7.2 Backup strategy
- **Postgres logical backups:** nightly `pg_dump` (custom format), pushed to the
  **Hetzner Storage Box** over SSH/rsync or to **R2**. Keep 7 daily + 4 weekly + 3
  monthly. Example cron on the host:
  ```bash
  0 2 * * * docker exec gosumo-postgres pg_dump -U gosumo -Fc gosumo_db \
    | restic -r sftp:storagebox:/gosumo backup --stdin --stdin-filename db.dump
  ```
  Use **restic** (or Borg) for encrypted, deduplicated, versioned backups.
- **Volume snapshots:** Hetzner snapshots of the server (weekly) for fast full
  restore; cheap (~€0.0119/GB·mo).
- **Qdrant:** periodic snapshot API → Storage Box/R2.
- **Redis:** AOF on the volume is enough (it's a cache/broker, not the source of
  truth); jobs in flight are re-derivable from Postgres events.
- **Test restores quarterly** — an untested backup is not a backup.
- **`audit_logs` are append-only** (`CLAUDE.md` rule #7) — ensure backups capture
  them and never run UPDATE/DELETE; 12-month retention per `ARCHITECTURE.md §11`.

### 7.3 Secret management
- **No secrets in git, ever.** `.gitignore` blocks `keys` / `keys/`, `*.pem`,
  `*.key`, `*_ed25519`, `*token*.txt`, `*secret*`, `*.tfvars`. The local `keys/`
  directory (deploy SSH keypair, Cloudflare/Git tokens, VPS IP) stays untracked.
- **Runtime secrets** live in `/opt/gosumo/.env.prod` on the box (`chmod 600`), read
  via Compose `env_file`. Not baked into images, not in CI logs.
- **CI secrets** in GitHub Actions encrypted secrets (§4.1).
- **Rotation:** rotate `JWT_SECRET`, DB/Redis/Qdrant passwords, and the deploy key
  on a schedule (`ARCHITECTURE.md §11` calls for 90-day key rotation). The tunnel
  token and provider keys (Anthropic, Razorpay, WhatsApp) rotate via their dashboards.
- **Field-level PII encryption** (AES-256) stays an app concern per `ARCHITECTURE.md`.

---

## 8. First-time provisioning runbook

1. **Create the box:** Hetzner Cloud → CAX21, Ubuntu 24.04, add your SSH key, region
   `hel1`. Attach a Hetzner Cloud Firewall (SSH from your IP only).
2. **Harden + install Docker:**
   ```bash
   adduser deploy && usermod -aG sudo deploy
   # disable root/password SSH, set up ufw, fail2ban, unattended-upgrades
   curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy
   ```
3. **Clone the repo** to `/opt/gosumo` as the `deploy` user (using the deploy key).
4. **Create `/opt/gosumo/.env.prod`** (`chmod 600`) with all required secrets (§4.1).
5. **Cloudflare:** add the domain, create a **Tunnel** (Zero Trust → Tunnels), copy
   the token into `.env.prod` as `CLOUDFLARE_TUNNEL_TOKEN`, and add a public hostname
   route `api.gosumo.app → http://api:3000`. Set SSL to Full (Strict).
6. **Boot:** `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d`.
   The `api` service runs `prisma migrate deploy` automatically on first start.
7. **Dashboard:** connect the repo to **Cloudflare Pages**; set `NEXT_PUBLIC_API_URL`
   to `https://api.gosumo.app`.
8. **Monitoring:** open Uptime Kuma (via SSH tunnel to `127.0.0.1:3001`), add the
   `/api/health` monitor + Telegram alerts. Add an external UptimeRobot check.
9. **Add GitHub secrets** (`HETZNER_*`) → push to `main` → CI/CD takes over from here.

---

## 9. Summary

- **One Hetzner ARM VPS + Cloudflare free tier** runs the full GoSumo stack for
  **~$13/month**, comfortably under the $30 target.
- **Cloudflare Tunnel** means **zero inbound ports** on the origin — the strongest,
  simplest security posture available for free.
- **One image, two roles** (api/worker), **one health endpoint**, **one compose file**
  across staging and prod keeps operations boring and reproducible.
- **Scale by resizing, then splitting stateful services** — the architecture in
  `ARCHITECTURE.md §10` (K8s, managed data) is the destination, not the starting line.
- The real cost driver is **Anthropic API usage**, not infra — meter it per tenant
  and price accordingly.
