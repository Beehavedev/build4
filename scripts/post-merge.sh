#!/bin/bash
set -e
npm install
# This project uses Prisma, not Drizzle. Schema changes are applied via
# `npx prisma db push` only when prisma/schema.prisma actually changed —
# the generic `npm run db:push` (drizzle-kit) does not apply here and
# fails because no drizzle.config.* exists.
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q '^prisma/schema\.prisma$'; then
  echo "[post-merge] prisma/schema.prisma changed — running prisma db push"
  npx prisma generate
  # Mirror render.yaml's buildCommand: drop the legacy unique index on
  # Agent.walletAddress (older databases have duplicates that block the
  # constraint) and accept data loss so additive/destructive schema sync
  # actually applies. Without this, `db push` errors out asking for the
  # flag and the deploy fails.
  echo 'DROP INDEX IF EXISTS "Agent_walletAddress_key";' \
    | npx prisma db execute --schema=prisma/schema.prisma --stdin || true
  npx prisma db push --skip-generate --accept-data-loss
else
  echo "[post-merge] no prisma schema changes — skipping db push"
fi
