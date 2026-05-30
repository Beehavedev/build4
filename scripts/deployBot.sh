#!/bin/bash
#
# deployBot.sh — safe one-command bot deploy to GitHub origin/main (Render redeploy).
#
# Render builds the bot from GitHub origin/main. Local Replit `main` is a
# long-running branch that is NEVER pushed wholesale — a deploy brings ONLY the
# bot paths onto a commit cut from origin/main, then fast-forward pushes.
# `web4/` and `build4io-site/` (the website + web dApp) must NEVER be touched by
# a deploy; pushing them is how web4/ leaked onto origin in the first place.
#
# This script encodes the exact procedure from
# .agents/memory/bot-github-deploy.md:
#   1. fetch origin
#   2. build the deploy commit in a /tmp git worktree from origin/main
#      (a workspace checkout of origin/main trips the platform `.replit` guard)
#   3. check out ONLY bot paths from local main
#   4. HARD-FAIL if any staged path is forbidden (web4/, build4io-site/, etc.)
#   5. plain fast-forward push (NEVER --force)
#   6. clean up the worktree
#
# Usage:
#   scripts/deployBot.sh ["commit message"]
#
# Exit codes:
#   0  success (pushed, or nothing to deploy)
#   1  guard tripped / precondition failed (nothing pushed)

set -euo pipefail

# --- configuration -----------------------------------------------------------

# Only these top-level paths are allowed onto origin/main by a deploy.
BOT_PATHS=(src public render.yaml package.json package-lock.json scripts)

# Any staged path starting with one of these prefixes aborts the deploy.
FORBIDDEN_PREFIXES=(
  "web4/"
  "build4io-site/"
  ".agents/"
  ".local/"
  "attached_assets/"
  "exports/"
  ".replit"
  "replit.md"
)

WORKTREE_DIR="/tmp/deploy_ff"
REMOTE="origin"
TARGET_BRANCH="main"
LOCAL_BRANCH="main"

COMMIT_MSG="${1:-bot deploy: sync bot paths to origin/main}"

# --- helpers -----------------------------------------------------------------

log()  { printf '[deployBot] %s\n' "$*"; }
fail() { printf '[deployBot] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if git worktree list --porcelain 2>/dev/null | grep -q "^worktree ${WORKTREE_DIR}$"; then
    log "cleaning up worktree ${WORKTREE_DIR}"
    git worktree remove "${WORKTREE_DIR}" --force 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- preconditions -----------------------------------------------------------

git rev-parse --git-dir >/dev/null 2>&1 || fail "not inside a git repository"
git rev-parse --verify "${LOCAL_BRANCH}" >/dev/null 2>&1 \
  || fail "local branch '${LOCAL_BRANCH}' not found"

# Remove any stale locks that can be left behind by an aborted prior run.
rm -f .git/refs/remotes/${REMOTE}/${TARGET_BRANCH}.lock 2>/dev/null || true

# A pre-existing worktree at the path (from a crashed run) would block us.
cleanup

# --- 1. fetch origin ---------------------------------------------------------

log "fetching ${REMOTE}…"
git fetch "${REMOTE}" "${TARGET_BRANCH}"

# --- 2. build deploy commit in /tmp worktree from origin/main ----------------

log "creating worktree at ${WORKTREE_DIR} from ${REMOTE}/${TARGET_BRANCH}…"
git worktree add --detach "${WORKTREE_DIR}" "${REMOTE}/${TARGET_BRANCH}"

# --- 3. check out ONLY bot paths from local main -----------------------------

# Restrict to bot paths that actually exist on local main, so a missing optional
# path (e.g. package-lock.json) doesn't abort the whole deploy.
declare -a EXISTING_BOT_PATHS=()
for p in "${BOT_PATHS[@]}"; do
  if git cat-file -e "${LOCAL_BRANCH}:${p}" 2>/dev/null; then
    EXISTING_BOT_PATHS+=("${p}")
  else
    log "note: bot path '${p}' not present on ${LOCAL_BRANCH}, skipping"
  fi
done

[ "${#EXISTING_BOT_PATHS[@]}" -gt 0 ] || fail "no bot paths found on ${LOCAL_BRANCH}"

log "staging bot paths from ${LOCAL_BRANCH}: ${EXISTING_BOT_PATHS[*]}"
git -C "${WORKTREE_DIR}" checkout "${LOCAL_BRANCH}" -- "${EXISTING_BOT_PATHS[@]}"

# Stage everything (the checkout above already stages, but be explicit so that
# deletions of files removed on local main are captured too).
git -C "${WORKTREE_DIR}" add -A "${EXISTING_BOT_PATHS[@]}"

# --- 4. HARD-FAIL on any forbidden staged path -------------------------------

STAGED="$(git -C "${WORKTREE_DIR}" diff --cached --name-only)"

if [ -z "${STAGED}" ]; then
  log "no changes to deploy — origin/${TARGET_BRANCH} already matches bot paths. Nothing to push."
  exit 0
fi

log "staged paths:"
printf '  %s\n' ${STAGED}

while IFS= read -r path; do
  [ -n "${path}" ] || continue
  for prefix in "${FORBIDDEN_PREFIXES[@]}"; do
    case "${path}" in
      "${prefix}"*)
        fail "FORBIDDEN path staged for deploy: '${path}' (matches '${prefix}'). Aborting — nothing pushed."
        ;;
    esac
  done
done <<< "${STAGED}"

log "guard passed: no forbidden paths staged."

# --- 5. commit + plain fast-forward push (NEVER --force) ---------------------

git -C "${WORKTREE_DIR}" -c user.name="deployBot" \
    -c user.email="deploy@build4.local" \
    commit -m "${COMMIT_MSG}"

log "pushing to ${REMOTE}/${TARGET_BRANCH} (plain fast-forward)…"
git -C "${WORKTREE_DIR}" push "${REMOTE}" "HEAD:${TARGET_BRANCH}"

log "deploy pushed successfully to ${REMOTE}/${TARGET_BRANCH}."
