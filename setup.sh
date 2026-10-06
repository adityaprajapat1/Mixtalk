#!/usr/bin/env bash
# MixTalk setup — retry-safe dependency install + env check
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "============================================"
echo " MixTalk Setup"
echo "============================================"
echo ""

# --- Dependencies ---
echo "[1/4] Installing npm dependencies..."
if npm install --no-audit --no-fund; then
  echo "  STATUS: READY — dependencies installed"
else
  echo "  STATUS: DEPENDENCY INSTALL FAILED"
  echo "  Try: npm install --registry https://registry.npmjs.org"
  exit 1
fi
echo ""

# --- Env file ---
echo "[2/4] Environment file..."
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    # Generate SESSION_SECRET if placeholder
    if grep -q "replace-with-a-long-random" .env.local 2>/dev/null; then
      SEC=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
      sed -i "s/replace-with-a-long-random-secret-at-least-32-chars/${SEC}/" .env.local
    fi
    echo "  Created .env.local from .env.example"
  else
    echo "  STATUS: NOT CONFIGURED — missing .env.example"
  fi
else
  echo "  .env.local present"
fi
echo ""

# --- Prisma generate (no DB connection required) ---
echo "[3/4] Prisma client generate..."
if [ -f prisma/schema.prisma ]; then
  if npx prisma generate 2>/dev/null; then
    echo "  STATUS: READY — Prisma client generated"
  else
    echo "  STATUS: NOT CONFIGURED or DEPENDENCY INSTALL FAILED (prisma)"
  fi
else
  echo "  STATUS: NOT CONFIGURED — no schema.prisma"
fi
echo ""

# --- Summary ---
echo "[4/4] Next steps"
echo "  1. Edit .env.local — set ADMIN_EMAIL + ADMIN_PASSWORD_HASH"
echo "     Hash: npx tsx scripts/hash-password.ts \"YourPassword\""
echo "  2. Optional: DATABASE_URL, REDIS_URL, TURN_*"
echo "  3. npm run health"
echo "  4. npm run dev          # Next.js"
echo "  5. npm run dev:ws       # WebSocket (separate terminal)"
echo ""
echo "Setup finished. Run: npm run health"
