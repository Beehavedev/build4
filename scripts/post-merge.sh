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
  npx prisma db push --skip-generate
else
  echo "[post-merge] no prisma schema changes — skipping db push"
fi
