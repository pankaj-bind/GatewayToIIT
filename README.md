# GatewayToIIT

Backend + frontend platform for video/PDF vault with Google Drive + Telegram integrations.

| Layer    | Stack                                               | Host               |
|----------|-----------------------------------------------------|--------------------|
| Frontend | React 19 + Vite + TypeScript + Tailwind             | Vercel             |
| Backend  | Django 4 + DRF + SimpleJWT (HttpOnly cookies)       | Oracle Cloud VM    |
| DB       | SQLite (in a Docker volume, hot-backed up hourly)   | Same VM            |
| Video    | FFmpeg + Google Drive (folder-backed object store)  | Backend container  |
| Messaging| Telethon for Telegram integration                   | Backend container  |

---

## Local development

```bash
git clone https://github.com/pankaj-bind/GatewayToIIT.git
cd GatewayToIIT
make dev          # equivalent to: docker compose up --build
```

Frontend at `http://localhost:80`, backend at `http://localhost:8000`. The stock `docker-compose.yml` bundles both services; SQLite lives in `./backend/db.sqlite3` (host-mounted) so data persists between restarts.

To run without Docker, see `backend/README` conventions — `python manage.py runserver` inside a venv works once `backend/.env` is filled in.

---

## Production — Oracle Cloud (backend) + Vercel (frontend)

### 0. Prerequisites

- Oracle Cloud VM (Ubuntu 22.04 LTS, Ampere A1 or any shape).
- SSH access as `ubuntu`.
- A DuckDNS hostname pointing at the VM's public IP (e.g. `gatewaytoiit.duckdns.org`). Let's Encrypt will not sign a bare IP and browsers block HTTPS-frontend → HTTP-backend calls as mixed content — a hostname is mandatory.
- Google OAuth `credentials.json` + `token.json` already generated for Drive access (never committed — uploaded directly to the VM).

### 1. Open ports in the Oracle Cloud Console

Oracle restricts traffic at **two** layers — both must allow 80/443:

1. **VCN Security List** (cloud-level firewall) — Networking → your VCN → Security Lists → default list → Add Ingress Rules for TCP 80 and TCP 443 from `0.0.0.0/0`.
2. **OS-level firewall** — handled automatically by `oracle-bootstrap.sh` in step 3.

### 2. Point DNS at the VM

```
gatewaytoiit.duckdns.org  A  <VM-IP>
```

Verify from your laptop: `dig +short gatewaytoiit.duckdns.org` should print the VM IP.

### 3. Bootstrap the VM (once)

```bash
ssh ubuntu@<VM-IP>
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/pankaj-bind/GatewayToIIT.git
cd GatewayToIIT
make oracle-bootstrap
```

This installs Docker + Compose plugin, creates a 4 GB swap file, opens 22/80/443 via `ufw`, removes Oracle's default `REJECT` iptables rule, installs fail2ban, and enables unattended security upgrades.

**Log out and back in** so Docker group membership takes effect:

```bash
exit
ssh ubuntu@<VM-IP>
cd GatewayToIIT
docker ps    # should work without sudo
```

### 4. Configure secrets

```bash
cp .env.oracle.example .env
nano .env
```

Fill in:
- `DOMAIN`, `PUBLIC_IP`, `LETSENCRYPT_EMAIL`
- `FRONTEND_ORIGIN` (your Vercel URL)
- `DJANGO_SECRET_KEY` — `python3 -c "import secrets; print(secrets.token_urlsafe(50))"`
- `GOOGLE_DRIVE_FOLDER_ID`
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` — from <https://my.telegram.org/apps>

### 5. Upload Google OAuth credentials

These two files are NEVER committed. Copy them once from your laptop:

```bash
# From your laptop (not the VM)
scp backend/credentials.json ubuntu@<VM-IP>:~/GatewayToIIT/backend/
scp backend/token.json       ubuntu@<VM-IP>:~/GatewayToIIT/backend/
```

`docker-compose.oracle.yml` mounts them read-only into the container.

### 6. Issue the TLS certificate and start the stack

```bash
make oracle-ssl-init     # Let's Encrypt via certbot webroot (one-shot)
make oracle-up           # build + migrate + start everything
make oracle-ps           # verify: backend + nginx + certbot + sqlite-backup
```

Create the Django superuser:

```bash
make oracle-shell
python manage.py createsuperuser
exit
```

Admin at `https://<DOMAIN>/admin/`.

### 7. Configure Vercel

In the Vercel project for this repo:

1. **Root Directory**: `frontend`
2. **Framework Preset**: Vite (auto-detected from `frontend/vercel.json`)
3. **Environment Variables** (Production + Preview):
   - `VITE_API_URL` = `https://<DOMAIN>` (no trailing `/api` — endpoint paths already include it)
4. Trigger a redeploy. `VITE_API_URL` is baked into the bundle at build time, so any backend URL change requires a Vercel rebuild.

### 8. Redeploy loop

Pushes to `main` that touch backend files auto-deploy via [`.github/workflows/deploy-oracle.yml`](.github/workflows/deploy-oracle.yml) — the workflow SSHes into the VM and runs `scripts/oracle-deploy.sh` (git pull → rebuild → migrate → restart). Vercel redeploys the frontend on the same push.

Manual redeploy:

```bash
ssh ubuntu@<VM-IP> 'cd GatewayToIIT && ./scripts/oracle-deploy.sh'
# or on the VM: make oracle-deploy
```

### 9. GitHub Actions secrets (one-time)

Needed for auto-deploy. Generate a dedicated SSH key on your laptop:

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\gatewaytoiit_deploy" -C "github-actions@gatewaytoiit"
# press Enter twice when prompted for passphrase (no passphrase)
```

Add the **public** key to the VM's `~/.ssh/authorized_keys` with a forced command so the key can only run the deploy script:

```
command="cd /home/ubuntu/GatewayToIIT && bash ./scripts/oracle-deploy.sh",restrict ssh-ed25519 AAAA... github-actions@gatewaytoiit
```

Then in the repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|------|-------|
| `ORACLE_HOST` | VM public IP |
| `ORACLE_USER` | `ubuntu` |
| `ORACLE_SSH_KEY` | entire content of the **private** key file (including BEGIN/END lines) |
| `ORACLE_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519,rsa <VM-IP>` |

### 10. Backups

SQLite is hot-backed-up every hour by the `sqlite-backup` sidecar to `./backups/daily/db-<ts>.sqlite3.gz`, retained for 7 days. Trigger a manual snapshot with `make oracle-backup`.

For off-site copies, add a cron on the VM:

```bash
crontab -e
# OCI Object Storage (Always-Free 20 GB)
0 * * * * oci os object bulk-upload --bucket-name gatewaytoiit-backups \
          --src-dir /home/ubuntu/GatewayToIIT/backups --overwrite
```

Restore is a plain `gunzip` + stop-swap-restart:

```bash
docker compose -f docker-compose.oracle.yml stop backend
gunzip -c backups/daily/db-<timestamp>.sqlite3.gz > /tmp/restored.sqlite3
docker compose -f docker-compose.oracle.yml cp /tmp/restored.sqlite3 \
    backend:/app/db-data/db.sqlite3
docker compose -f docker-compose.oracle.yml start backend
```

---

## Common failure modes

| Symptom | Fix |
|---|---|
| `make oracle-ssl-init` → `DNS problem: NXDOMAIN` | DuckDNS record not resolving yet. Recheck DNS, wait a few minutes. |
| `make oracle-ssl-init` → `Connection refused` on port 80 | OCI Security List rule for TCP 80 is missing. |
| Login works, but subsequent calls 401 | Cookie isn't being sent. Ensure `AUTH_COOKIE_SAMESITE=None` and both origins are HTTPS — browsers drop `SameSite=None` cookies on plain HTTP. |
| `CSRF verification failed` in admin | `https://<DOMAIN>` is missing from `CSRF_TRUSTED_ORIGINS` in `.env`. |
| Video upload stalls or 504s | `client_max_body_size` or proxy timeouts too low; defaults here are unlimited body + 600s timeouts. Check nginx logs for the specific cutoff. |
| Google Drive calls fail on VM | `backend/credentials.json` or `backend/token.json` wasn't scp'd to the VM. |

---

## License

See [LICENSE](LICENSE).
