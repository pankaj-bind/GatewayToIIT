#!/usr/bin/env bash
# =============================================================================
# GatewayToIIT - Oracle Redeploy
# =============================================================================
# Idempotent: pulls latest code, rebuilds images, runs migrations, restarts.
# Safe to run repeatedly. Intended for manual redeploys and GitHub Actions.
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log() { echo -e "${GREEN}[deploy]${NC} $*"; }
die() { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

COMPOSE_FILE="docker-compose.oracle.yml"

[[ -f .env ]]              || die ".env missing. cp .env.oracle.example .env"
[[ -f "$COMPOSE_FILE" ]]   || die "$COMPOSE_FILE not found; wrong directory?"
[[ -d certbot/conf/live ]] || die "SSL certs missing. Run ./scripts/oracle-init-ssl.sh first."
[[ -f backend/credentials.json ]] || die "backend/credentials.json missing. scp it from your laptop first."
[[ -f backend/token.json ]]       || die "backend/token.json missing. scp it from your laptop first."

log "Pulling latest code..."
git fetch --all --prune
git reset --hard origin/main

log "Building images..."
docker compose -f "$COMPOSE_FILE" build --pull

log "Starting services..."
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log "Waiting for backend to be up..."
for _ in $(seq 1 30); do
    if docker compose -f "$COMPOSE_FILE" exec -T backend \
        python -c "import urllib.request,sys;urllib.request.urlopen('http://localhost:8000/api/auth/me/');" \
        >/dev/null 2>&1; then
        log "Backend responding."
        break
    fi
    # /api/auth/me/ will return 401 even when healthy -- that's still a
    # valid signal that gunicorn is up.
    if docker compose -f "$COMPOSE_FILE" exec -T backend \
        python -c "import urllib.request;import urllib.error;\
try:urllib.request.urlopen('http://localhost:8000/api/auth/me/')\
except urllib.error.HTTPError as e:exit(0 if e.code==401 else 1)" \
        >/dev/null 2>&1; then
        log "Backend responding (401 on /api/auth/me/ -- expected for unauthenticated check)."
        break
    fi
    sleep 2
done

log "Pruning dangling images..."
docker image prune -f >/dev/null

log "Deploy complete. Services:"
docker compose -f "$COMPOSE_FILE" ps
