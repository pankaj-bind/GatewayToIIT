.PHONY: help dev up down logs shell \
        oracle-bootstrap oracle-ssl-init oracle-up oracle-down oracle-deploy \
        oracle-logs oracle-shell oracle-ps oracle-backup oracle-restart-nginx

help:
	@echo ""
	@echo "GatewayToIIT - Available Commands"
	@echo "================================="
	@echo ""
	@echo "Local development:"
	@echo "  make dev         Start local dev stack (docker-compose.yml)"
	@echo "  make up          Start containers (detached)"
	@echo "  make down        Stop containers"
	@echo "  make logs        Tail container logs"
	@echo "  make shell       Shell in backend container"
	@echo ""
	@echo "Oracle Cloud (backend-only; frontend lives on Vercel):"
	@echo "  make oracle-bootstrap      First-time VM setup (docker, swap, ufw, fail2ban)"
	@echo "  make oracle-ssl-init       Issue Let's Encrypt cert for \$$DOMAIN"
	@echo "  make oracle-up             Start the production stack"
	@echo "  make oracle-down           Stop the production stack"
	@echo "  make oracle-deploy         git pull + rebuild + migrate + restart"
	@echo "  make oracle-logs           Tail all service logs"
	@echo "  make oracle-shell          Shell inside backend container"
	@echo "  make oracle-ps             Show service status"
	@echo "  make oracle-backup         Trigger an immediate SQLite snapshot"
	@echo "  make oracle-restart-nginx  Reload nginx after manual cert/config changes"
	@echo ""

# =============================================================================
# Local development
# =============================================================================
dev:
	docker compose up --build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

shell:
	docker compose exec backend /bin/bash

# =============================================================================
# Oracle Cloud
# =============================================================================
ORACLE_COMPOSE := docker-compose.oracle.yml

oracle-bootstrap:
	chmod +x scripts/oracle-bootstrap.sh
	./scripts/oracle-bootstrap.sh

oracle-ssl-init:
	chmod +x scripts/oracle-init-ssl.sh
	./scripts/oracle-init-ssl.sh

oracle-up:
	docker compose -f $(ORACLE_COMPOSE) up -d --build

oracle-down:
	docker compose -f $(ORACLE_COMPOSE) down

oracle-deploy:
	chmod +x scripts/oracle-deploy.sh
	./scripts/oracle-deploy.sh

oracle-logs:
	docker compose -f $(ORACLE_COMPOSE) logs -f --tail=200

oracle-shell:
	docker compose -f $(ORACLE_COMPOSE) exec backend /bin/bash

oracle-ps:
	docker compose -f $(ORACLE_COMPOSE) ps

oracle-backup:
	# The sqlite-backup sidecar already snapshots hourly; this forces one now.
	docker compose -f $(ORACLE_COMPOSE) exec -T sqlite-backup \
		sh -c 'sqlite3 /app/db-data/db.sqlite3 ".backup /backups/daily/db-$$(date -u +%Y-%m-%dT%H%M%SZ)-manual.sqlite3" && \
		       gzip /backups/daily/db-*-manual.sqlite3 && \
		       ls -lh /backups/daily/ | tail -5'

oracle-restart-nginx:
	docker compose -f $(ORACLE_COMPOSE) exec -T nginx nginx -s reload
