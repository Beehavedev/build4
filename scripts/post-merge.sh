#!/bin/bash
set -e
npm install

# Prisma schema for this project lives at src/prisma/schema.prisma and is
# managed canonically by render.yaml's buildCommand on Render. There used
# to be a duplicate schema at prisma/schema.prisma which:
#   1. Triggered Replit's deploy Provision stage to offer destructive
#      schema diffs against the production bot database (could rename or
#      wipe live tables — nearly happened on 2026-05-01).
#   2. Caused this post-merge hook to run `prisma db push --accept-data-loss`
#      against DATABASE_URL whenever a task agent merged a change to it,
#      duplicating Render's schema management and risking divergence.
#
# That duplicate is now archived at _prisma_archived/schema.prisma and is
# not used by any automatic workflow. Render owns bot DB schema. Replit
# auto-pushes are intentionally disabled here. If a Replit task agent
# legitimately needs to alter the bot DB schema, do it explicitly with
# `npx prisma db push --schema=src/prisma/schema.prisma --accept-data-loss`
# after weighing the risk.
echo "[post-merge] prisma db push intentionally skipped — Render owns the bot DB schema (src/prisma/)"
