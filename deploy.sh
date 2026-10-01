#!/bin/bash
set -euo pipefail

# GoSumo Deploy Script — Hetzner VPS
# Run on the server: ssh root@89.167.8.178 then bash deploy.sh

echo "=== GoSumo Deploy ==="
cd /opt/gosumo

echo "[1/8] Pulling latest from main..."
git pull origin main

echo "[2/8] Installing dependencies..."
pnpm install

echo "[3/8] Generating Prisma client..."
cd packages/database
npx prisma generate
cd /opt/gosumo

echo "[4/8] Running database migrations..."
cd packages/database
DATABASE_URL="postgresql://gosumo:gs_prod_2026_secure@127.0.0.1:5433/gosumo_db" npx prisma migrate deploy
cd /opt/gosumo

# The API build does not fit in Node's default heap on this box. `nest build`
# type-checks the whole project in one pass and peaks around 1.9 GB, so it dies
# with "Ineffective mark-compacts near heap limit" and exit 134 — which reads
# like a code fault and is not one. The box has 4 GB shared with Postgres and
# the web server, so this is headroom rather than a fix for a leak.
export NODE_OPTIONS="--max-old-space-size=3072"

echo "[5/8] Building API..."
npx turbo build --filter=@gosumo/api

echo "[6/8] Building Web..."
npx turbo build --filter=@gosumo/web

echo "[7/8] Copying static assets to standalone..."
rm -rf apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
if [ -d apps/web/public ]; then
  rm -rf apps/web/.next/standalone/apps/web/public
  cp -r apps/web/public apps/web/.next/standalone/apps/web/public
fi
ls apps/web/.next/standalone/apps/web/.next/static/css/*.css >/dev/null 2>&1 \
  || { echo "FATAL: static CSS missing from standalone build"; exit 1; }

echo "[8/8] Restarting services..."
systemctl restart gosumo gosumo-web

echo ""
echo "=== Waiting for services to start... ==="
sleep 3

echo "API status:"
systemctl is-active gosumo || true

echo "Web status:"
systemctl is-active gosumo-web || true

echo ""
echo "Health checks:"
# `v1` is the global prefix set in main.ts; the health routes sit under it. The
# old /api/health path 404s, so this check reported a failure on every deploy of
# a perfectly healthy API — and a check that always cries wolf is worse than none.
curl -sf http://localhost:3001/v1/health 2>/dev/null && echo " API OK" || echo " API not responding yet (may need a few more seconds)"
curl -sf http://localhost:3002 2>/dev/null > /dev/null && echo " Web OK" || echo " Web not responding yet (may need a few more seconds)"

# Check OPENROUTER_API_KEY
if ! grep -q "OPENROUTER_API_KEY" /etc/systemd/system/gosumo.service 2>/dev/null; then
  echo ""
  echo "WARNING: OPENROUTER_API_KEY may not be set in gosumo.service."
  echo "Add it to the [Service] section: Environment=OPENROUTER_API_KEY=your_key_here"
  echo "Then: systemctl daemon-reload && systemctl restart gosumo"
fi

echo ""
echo "=== Deploy complete ==="
echo "API: https://api.gosumo.aiknol.com"
echo "Web: https://desk.doaide.com"
