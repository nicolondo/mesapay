#!/usr/bin/env bash
# Zero-downtime deploy for MESAPAY (blue/green).
#
# Drop-in replacement for /opt/mesapay/shared/activate.sh. The webhook
# pipeline still does:
#
#   webhook.js  →  deploy-from-github.sh <sha>  →  this script <sha>
#
# `deploy-from-github.sh` has already fetched the bare mirror at
# /opt/mesapay/shared/repo.git and extracted the working tree into
# /opt/mesapay/releases/<sha>. Our job is to:
#
#   1. Build the release (npm ci + prisma db push + next build)
#   2. Repoint the INACTIVE color's symlink at the new release
#   3. Restart the inactive systemd service
#   4. Poll /api/health on the inactive port until 200 (60s timeout)
#   5. Rewrite /etc/nginx/conf.d/mesapay-active.conf + nginx -s reload
#   6. Update the active-color marker
#   7. Sleep 30s to let the OLD color drain in-flight requests
#   8. Stop the OLD color's service
#   9. Prune old releases (keep last 5)
#
# If the health check fails we bail out without touching nginx; the
# old color keeps serving traffic and someone investigates manually.

set -euo pipefail

SHA="${1:?usage: activate.sh <sha>}"

# ── Config ────────────────────────────────────────────────────────────
APP_DIR="/opt/mesapay"
RELEASES_DIR="$APP_DIR/releases"
SHARED_DIR="$APP_DIR/shared"
RELEASE_DIR="$RELEASES_DIR/$SHA"
ACTIVE_COLOR_FILE="$APP_DIR/active-color"
NGINX_UPSTREAM_FILE="/etc/nginx/mesapay-active.conf"
HEALTH_TIMEOUT=60     # seconds to wait for new color to come up
DRAIN_SECONDS=30      # seconds to let old color finish in-flight requests
KEEP_RELEASES=5

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; exit 1; }

# ── 1. Build the release ─────────────────────────────────────────────
if [[ ! -d "$RELEASE_DIR" ]]; then
  fail "release dir missing: $RELEASE_DIR (deploy-from-github.sh should have created it)"
fi

cd "$RELEASE_DIR"

# Wire shared env + uploads into this release (same as the old script).
ln -sfn "$SHARED_DIR/.env.production" "$RELEASE_DIR/.env.production"
ln -sfn "$SHARED_DIR/.env.production" "$RELEASE_DIR/.env"
mkdir -p public
ln -sfn "$SHARED_DIR/uploads" "$RELEASE_DIR/public/uploads"

# A `.next` cache may already exist if this is a retry; npm ci is safe
# either way because it tears down node_modules first.
if [[ ! -f "$RELEASE_DIR/.next/BUILD_ID" ]]; then
  log "Installing deps + building $SHA..."
  npm ci --prefer-offline --no-audit --no-fund
  # Schema changes apply once here, while the OLD color is still
  # serving. We rely on expand-contract so the OLD color tolerates
  # the new schema for the ~10s gap before traffic swaps.
  npx prisma db push --accept-data-loss --skip-generate
  npx prisma generate
  npm run build
  log "Build complete"
else
  log "Release $SHA already built — reusing"
fi

# ── 2. Pick the inactive color ───────────────────────────────────────
CURRENT=$(cat "$ACTIVE_COLOR_FILE" 2>/dev/null || echo "")
if [[ "$CURRENT" == "blue" ]]; then
  NEXT="green"
  NEXT_PORT=3301
else
  # Default to blue on first-ever deploy, or after manual recovery.
  NEXT="blue"
  NEXT_PORT=3300
fi
log "Current active: ${CURRENT:-<none>} → switching to: $NEXT (port $NEXT_PORT)"

# ── 3. Point the inactive color's symlink + restart its service ──────
ln -sfn "$RELEASE_DIR" "$APP_DIR/$NEXT"
sudo /bin/systemctl restart "mesapay@$NEXT.service"

# ── 4. Poll health endpoint until ready ──────────────────────────────
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

if [[ "$HEALTHY" -ne 1 ]]; then
  log "Tail of journal for the unhealthy color:"
  sudo /bin/journalctl -u "mesapay@$NEXT.service" -n 50 --no-pager || true
  fail "$NEXT didn't become healthy in ${HEALTH_TIMEOUT}s — aborting. ${CURRENT:-<none>} continues to serve."
fi

# ── 5. Atomic nginx swap ─────────────────────────────────────────────
log "Swapping nginx upstream to port $NEXT_PORT..."
echo "server 127.0.0.1:$NEXT_PORT;" | sudo /usr/bin/tee "$NGINX_UPSTREAM_FILE" > /dev/null
if ! sudo /usr/sbin/nginx -t > /dev/null 2>&1; then
  fail "nginx config test failed — leaving traffic on ${CURRENT:-<none>}"
fi
sudo /usr/sbin/nginx -s reload
log "nginx now points at $NEXT"

# ── 6. Mark new color as active ──────────────────────────────────────
echo "$NEXT" > "$ACTIVE_COLOR_FILE"

# Keep the legacy `current` symlink up to date so anything still
# pointing at /opt/mesapay/current (logs, scripts, the old service if
# it ever comes back) sees the latest release too.
ln -sfn "$RELEASE_DIR" "$APP_DIR/current.new"
mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"

# ── 7. Drain the old color ───────────────────────────────────────────
if [[ -n "$CURRENT" && "$CURRENT" != "$NEXT" ]]; then
  log "Letting $CURRENT drain for ${DRAIN_SECONDS}s before stopping it..."
  sleep "$DRAIN_SECONDS"
  sudo /bin/systemctl stop "mesapay@$CURRENT.service"
  log "$CURRENT stopped"
fi

# ── 8. Prune old releases ────────────────────────────────────────────
# Never delete a release that's currently symlinked by either color.
BLUE_REL=$(readlink -f "$APP_DIR/blue" 2>/dev/null || true)
GREEN_REL=$(readlink -f "$APP_DIR/green" 2>/dev/null || true)
log "Pruning old releases (keeping last $KEEP_RELEASES + the active ones)..."
cd "$RELEASES_DIR"
ls -1dt */ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r dir; do
  full=$(readlink -f "$dir")
  if [[ "$full" == "$BLUE_REL" || "$full" == "$GREEN_REL" ]]; then continue; fi
  rm -rf "$dir"
done

log "Deploy complete. Active color: $NEXT (release $SHA)"
