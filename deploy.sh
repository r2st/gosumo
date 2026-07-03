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

echo "[5/8] Building API..."
npx turbo build --filter=@gosumo/api

echo "[6/8] Building Web..."
npx turbo build --filter=@gosumo/web

echo "[7/8] Copying static assets to standalone..."
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
if [ -d apps/web/public ]; then
  cp -r apps/web/public apps/web/.next/standalone/apps/web/public
fi

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
curl -sf http://localhost:3001/api/health 2>/dev/null && echo " API OK" || echo " API not responding yet (may need a few more seconds)"
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
echo "Web: https://gosumo.aiknol.com"
