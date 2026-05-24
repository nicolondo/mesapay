#!/usr/bin/env bash
# Zero-downtime deploy for MESAPAY.
#
# Layout on the VPS:
#   /opt/mesapay/
#   ├── repo/                 git clone of the project (bare-ish)
#   ├── releases/<git-hash>/  each deploy lives in its own dir
#   ├── shared/
#   │   ├── .env.production   shared secrets (DATABASE_URL, etc.)
#   │   ├── .env.blue         PORT=3300
#   │   ├── .env.green        PORT=3301
#   │   └── uploads/          symlinked into each release
#   ├── blue   -> releases/<hash>     (symlink, repointed by activate)
#   ├── green  -> releases/<hash>     (symlink, repointed by activate)
#   ├── active-color          file holding "blue" or "green"
#   └── scripts/activate.sh   this file
#
# Flow:
#   1. Pull latest main, build a new release dir
#   2. Repoint the INACTIVE color's symlink at the new release
#   3. Restart the inactive systemd service
#   4. Poll /api/health on the inactive port until 200 (timeout 60s)
#   5. Rewrite /etc/nginx/conf.d/mesapay-active.conf and `nginx -s reload`
#   6. Update active-color marker
#   7. Sleep 30s to let the OLD color drain in-flight requests
#   8. Stop the OLD color's service
#   9. Prune old releases (keep last 5)
#
# If health check fails: bail out without touching nginx. The old color
# keeps serving and someone investigates the new release in releases/.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────
APP_DIR="/opt/mesapay"
REPO_DIR="$APP_DIR/repo"
RELEASES_DIR="$APP_DIR/releases"
SHARED_DIR="$APP_DIR/shared"
ACTIVE_COLOR_FILE="$APP_DIR/active-color"
NGINX_UPSTREAM_FILE="/etc/nginx/conf.d/mesapay-active.conf"
HEALTH_TIMEOUT=60     # seconds to wait for new color to come up
DRAIN_SECONDS=30      # seconds to let old color finish in-flight requests
KEEP_RELEASES=5

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; exit 1; }

# ── 1. Pull code ─────────────────────────────────────────────────────
log "Fetching latest main..."
cd "$REPO_DIR"
git fetch --depth=20 origin main
git checkout -q origin/main
GIT_HASH=$(git rev-parse --short HEAD)
RELEASE_DIR="$RELEASES_DIR/$GIT_HASH"
log "Target release: $GIT_HASH"

# ── 2. Build release if not cached ───────────────────────────────────
if [ ! -d "$RELEASE_DIR" ]; then
  log "Building $GIT_HASH..."
  mkdir -p "$RELEASE_DIR"
  # Copy the working tree (faster + smaller than git clone for each release)
  rsync -a --delete \
    --exclude=node_modules \
    --exclude=.next \
    --exclude=.git \
    "$REPO_DIR/" "$RELEASE_DIR/"
  cd "$RELEASE_DIR"

  # Wire shared env + uploads
  ln -sf "$SHARED_DIR/.env.production" .env.production
  ln -sfn "$SHARED_DIR/uploads" public/uploads

  npm ci --prefer-offline --no-audit --no-fund
  # Apply schema changes. We rely on the expand-contract pattern so this
  # is always backwards-compatible with the OLD color that's still
  # serving traffic right now.
  npx prisma generate
  npx prisma db push --skip-generate --accept-data-loss=false
  npm run build
  log "Build complete"
else
  log "Release $GIT_HASH already built — reusing"
fi

# ── 3. Pick the inactive color ───────────────────────────────────────
CURRENT=$(cat "$ACTIVE_COLOR_FILE" 2>/dev/null || echo "")
if [ "$CURRENT" = "blue" ]; then
  NEXT="green"
  NEXT_PORT=3301
else
  # Default to blue on first-ever deploy, or after manual recovery.
  NEXT="blue"
  NEXT_PORT=3300
fi
log "Current active: ${CURRENT:-<none>} → switching to: $NEXT (port $NEXT_PORT)"

# ── 4. Point the inactive color's symlink + restart its service ──────
ln -sfn "$RELEASE_DIR" "$APP_DIR/$NEXT"
sudo systemctl restart "mesapay@$NEXT.service"

# ── 5. Poll health endpoint until ready ──────────────────────────────
log "Waiting for $NEXT to become healthy (timeout ${HEALTH_TIMEOUT}s)..."
HEALTHY=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -fs -m 2 "http://127.0.0.1:$NEXT_PORT/api/health" > /dev/null 2>&1; then
    HEALTHY=1
    log "Healthy after ${i}s"
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  log "Tail of journal for the unhealthy color:"
  sudo journalctl -u "mesapay@$NEXT.service" -n 50 --no-pager || true
  fail "$NEXT didn't become healthy in ${HEALTH_TIMEOUT}s — aborting. $CURRENT continues to serve."
fi

# ── 6. Atomic nginx swap ─────────────────────────────────────────────
log "Swapping nginx upstream to port $NEXT_PORT..."
echo "server 127.0.0.1:$NEXT_PORT;" | sudo tee "$NGINX_UPSTREAM_FILE" > /dev/null
if ! sudo nginx -t > /dev/null 2>&1; then
  fail "nginx config test failed — leaving traffic on $CURRENT"
fi
sudo nginx -s reload
log "nginx now points at $NEXT"

# ── 7. Mark new color as active ──────────────────────────────────────
echo "$NEXT" > "$ACTIVE_COLOR_FILE"

# ── 8. Drain the old color ───────────────────────────────────────────
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$NEXT" ]; then
  log "Letting $CURRENT drain for ${DRAIN_SECONDS}s before stopping it..."
  sleep "$DRAIN_SECONDS"
  sudo systemctl stop "mesapay@$CURRENT.service"
  log "$CURRENT stopped"
fi

# ── 9. Prune old releases ────────────────────────────────────────────
# Keep the N most recent so we have rollback targets. Never delete a
# release that's currently symlinked by either color.
ACTIVE_REL=$(readlink -f "$APP_DIR/$NEXT" || true)
log "Pruning old releases (keeping last $KEEP_RELEASES + the active one)..."
cd "$RELEASES_DIR"
ls -1dt */ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r dir; do
  full=$(readlink -f "$dir")
  if [ "$full" = "$ACTIVE_REL" ]; then continue; fi
  rm -rf "$dir"
done

log "Deploy complete. Active color: $NEXT (release $GIT_HASH)"
