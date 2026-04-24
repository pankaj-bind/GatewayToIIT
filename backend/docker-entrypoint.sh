#!/usr/bin/env sh
# =============================================================================
# GatewayToIIT backend container entrypoint.
# =============================================================================
# Runs collectstatic + migrate, then execs gunicorn. Kept as a real script so
# compose `command:` blocks never have to embed multi-line sh -c scripts
# (where YAML folded scalars silently break gunicorn's argv).
#
# Env knobs:
#   GUNICORN_WORKERS   (default 3)
#   GUNICORN_THREADS   (default 2)
#   GUNICORN_TIMEOUT   (default 300; long for video uploads + FFmpeg calls)
#   GUNICORN_BIND      (default 0.0.0.0:8000)
#   SKIP_MIGRATE=1     skip `migrate`
#   SKIP_COLLECTSTATIC=1
# =============================================================================

set -eu

: "${GUNICORN_WORKERS:=3}"
: "${GUNICORN_THREADS:=2}"
: "${GUNICORN_TIMEOUT:=300}"
: "${GUNICORN_BIND:=0.0.0.0:8000}"

if [ "${SKIP_COLLECTSTATIC:-0}" != "1" ]; then
    echo "[entrypoint] collectstatic..."
    python manage.py collectstatic --noinput
fi

if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
    echo "[entrypoint] migrate..."
    python manage.py migrate --noinput
fi

echo "[entrypoint] starting gunicorn on ${GUNICORN_BIND} with ${GUNICORN_WORKERS} workers (timeout=${GUNICORN_TIMEOUT}s)..."
exec gunicorn \
    --bind "${GUNICORN_BIND}" \
    --workers "${GUNICORN_WORKERS}" \
    --threads "${GUNICORN_THREADS}" \
    --timeout "${GUNICORN_TIMEOUT}" \
    --worker-class gthread \
    --worker-tmp-dir /dev/shm \
    --access-logfile - \
    --error-logfile - \
    --capture-output \
    core.wsgi:application
