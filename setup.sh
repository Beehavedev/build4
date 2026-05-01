#!/bin/bash
# APEX Bot — Full Setup Script
set -e

echo "⚡ APEX Bot Setup"
echo "=================="

echo ""
echo "📦 Step 1/5 — Installing backend dependencies..."
npm install

echo ""
echo "🗄️  Step 2/5 — Generating Prisma client..."
# NOTE: Schema lives at _prisma_archived/schema.prisma (was prisma/ but
# Replit's deploy Provision stage auto-detects prisma/ and offered to
# rename/wipe production tables — see commit message of 2026-05-01).
# Render uses src/prisma/schema.prisma instead; this root schema is for
# manual local setup only.
npx prisma generate --schema=_prisma_archived/schema.prisma

echo ""
echo "🗄️  Step 3/5 — Pushing database schema..."
npx prisma db push --schema=_prisma_archived/schema.prisma --accept-data-loss

echo ""
echo "🌱 Step 4/5 — Seeding quests..."
npx tsx _prisma_archived/seed.ts

echo ""
echo "📦 Step 5/5 — Installing & building mini-app..."
cd src/miniapp
npm install
npm run build
cd ../..

echo ""
echo "✅ Setup complete! Now run: npm start"
echo ""
echo "Required secrets in Replit Secrets panel:"
echo "  TELEGRAM_BOT_TOKEN   — from @BotFather"
echo "  ANTHROPIC_API_KEY    — from console.anthropic.com"
echo "  MASTER_ENCRYPTION_KEY — any 32+ random chars"
echo "  TELEGRAM_WEBHOOK_URL  — https://YOUR-REPL.repl.co/api/webhook"
echo "  DATABASE_URL          — auto-set by Replit PostgreSQL addon"
