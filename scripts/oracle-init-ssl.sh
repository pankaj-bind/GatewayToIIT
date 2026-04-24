#!/usr/bin/env bash
# =============================================================================
# GatewayToIIT - Let's Encrypt SSL Bootstrap (Oracle, API-only)
# =============================================================================
# Issues a certificate for $DOMAIN via a short-lived nginx webroot.
# Run ONCE on the VM before `make oracle-up`.
#
# Prereqs:
#   - Docker installed, ports 80/443 open
#   - DNS for $DOMAIN resolves to this VM's public IP
#   - .env in repo root with DOMAIN= and LETSENCRYPT_EMAIL= filled
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[ssl]${NC} $*"; }
warn() { echo -e "${YELLOW}[ssl]${NC} $*"; }
die()  { echo -e "${RED}[ssl]${NC} $*" >&2; exit 1; }

STAGING="${STAGING:-0}"
RSA_KEY_SIZE=4096

[[ -f .env ]] || die ".env not found. Run: cp .env.oracle.example .env && edit it."

# Parse .env safely without sourcing it (source breaks on values with spaces
# or $ characters, e.g. Gmail app passwords or Fernet keys).
get_env() {
    local key="$1"
    grep -E "^${key}=" .env | head -n1 | cut -d= -f2- \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

DOMAIN="$(get_env DOMAIN)"
LETSENCRYPT_EMAIL="$(get_env LETSENCRYPT_EMAIL)"

[[ -n "$DOMAIN" ]]            || die "DOMAIN is not set in .env"
[[ -n "$LETSENCRYPT_EMAIL" ]] || die "LETSENCRYPT_EMAIL is not set in .env"
[[ "$DOMAIN" != "your-subdomain.duckdns.org" || "${FORCE:-0}" == "1" ]] || \
    die "DOMAIN is still the placeholder value. Edit .env first (or set FORCE=1)."

command -v docker >/dev/null || die "docker is not installed."

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)"
[[ -z "$RESOLVED" ]] && die "DNS for $DOMAIN does not resolve. Point it at this VM first."
log "DNS $DOMAIN -> $RESOLVED"

mkdir -p ./certbot/conf ./certbot/www

if [[ ! -e ./certbot/conf/options-ssl-nginx.conf || ! -e ./certbot/conf/ssl-dhparams.pem ]]; then
    log "Fetching TLS parameters..."
    curl -fsSL \
        https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
        -o ./certbot/conf/options-ssl-nginx.conf
    curl -fsSL \
        https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
        -o ./certbot/conf/ssl-dhparams.pem
fi

log "Starting temporary ACME webroot server on :80..."
docker rm -f gatewaytoiit-acme-bootstrap >/dev/null 2>&1 || true
docker run -d --name gatewaytoiit-acme-bootstrap \
    -p 80:80 \
    -v "$(pwd)/certbot/www:/usr/share/nginx/html:ro" \
    nginx:1.27-alpine \
    >/dev/null

cleanup() { docker rm -f gatewaytoiit-acme-bootstrap >/dev/null 2>&1 || true; }
trap cleanup EXIT
sleep 3

STAGING_ARG=""
if [[ "$STAGING" == "1" ]]; then
    warn "Using Let's Encrypt STAGING environment (untrusted test certs)."
    STAGING_ARG="--staging"
fi

log "Requesting certificate for $DOMAIN..."
docker run --rm \
    -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
    -v "$(pwd)/certbot/www:/var/www/certbot" \
    certbot/certbot:latest \
    certonly --webroot -w /var/www/certbot \
        $STAGING_ARG \
        -d "$DOMAIN" \
        --email "$LETSENCRYPT_EMAIL" \
        --rsa-key-size "$RSA_KEY_SIZE" \
        --agree-tos --no-eff-email \
        --non-interactive

cleanup
trap - EXIT

log "Certificate issued for $DOMAIN. Next: make oracle-up"
