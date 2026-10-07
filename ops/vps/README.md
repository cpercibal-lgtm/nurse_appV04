# Production on a single VPS (decision D-57)

How V04 runs on one Ubuntu 24.04 virtual server with no managed cloud services, and how a release reaches it. Everything here is scripts in this folder; the local test (`test/run.sh`, *Verification*) exercises them against the real release images.

```
 users ──HTTPS (80 → 443)──▶ Caddy  (Let's Encrypt certificate, renewed automatically; HTTP/1.1, 2, 3)
                                │  reverse proxy to the LIVE colour only
                    ┌───────────┴────────────┐
                    ▼                        ▼   (idle colour: started only during a release or rollback)
          blue:  web ─▶ api ─▶ worker     green: web ─▶ api ─▶ worker          ClamAV (shared)
                    │  Docker network 172.30.0.0/24, no published ports
                    ▼  db.host = the Docker host address (172.17.0.1), firewall: containers only
          PostgreSQL 15 on the host  ──WAL archive + nightly base backup (ops/backup, GPG)──▶ /srv/backup
                                                                          └─ every 5 min ──▶ off-site bucket (in the Kingdom)
 Admin: SSH with keys only.   GitHub Actions: SSH key that can run one command (nurseapp-release).
```

## 1. Before choosing the server: data residency

The specification requires **all production data, backups and WAL archives to reside in the Kingdom** (§8.3.6, PDPL), and the API refuses to start unless `DATA_RESIDENCY_REGION` is on `PDPL_ALLOWED_REGIONS`. That check catches a misconfiguration; it cannot see where the server really is. **Where the server is, is the hosting contract's job.**

- **Hostinger** (checked September 2026) offers VPS locations in Europe, North and South America and South / South-East Asia — **none in Saudi Arabia or the Gulf**. Check again with Hostinger before deciding. A Hostinger VPS therefore must **not** hold the hospital's staff data. It is fine for a **staging or demo** server loaded only with the synthetic fixtures (`npm run fixtures:demo`), never a copy of production.
- For production, choose a VPS (or dedicated server) in a data centre **in the Kingdom**, with a contract that says so, that also covers the backup bucket (§5). Record the provider and site in the hosting sign-off, and use a region id that names it, e.g. `DATA_RESIDENCY_REGION=ksa-riyadh-<provider>` (the same value in `PDPL_ALLOWED_REGIONS`).
- Everything below is provider-neutral: it needs Ubuntu 24.04 with root access, a public IPv4 address and ports 22, 80 and 443.

**Why not Coolify (or another control panel)?** It would work, but it adds a web control plane with root control over Docker, its own login and its own update cycle — a second system to secure on a server holding health-workforce data — and its database and backup features do not match this project's roles (ops/db), WAL archive and PITR kit (ops/backup). Plain Docker Compose, Caddy and the scripts here keep the moving parts few and reviewed in this repository.

## 2. Prepare the VPS

**Size:** 4 vCPU, 16 GB RAM, 200 GB NVMe is comfortable (ClamAV needs about 1.5 GB; during a release both colours run for about a minute). Choose the plain **Ubuntu 24.04** image, not a control-panel template.

1. **DNS:** an `A` record for the host name (e.g. `nurse.<hospital-domain>`) → the VPS's IPv4 address. Caddy needs it before it can obtain the certificate.
2. **Your own account, with an SSH key** (from your computer: `ssh-keygen -t ed25519`), then on the VPS as root:
   ```bash
   adduser <you> && usermod -aG sudo <you>
   install -d -m 700 -o <you> -g <you> /home/<you>/.ssh
   echo 'ssh-ed25519 AAAA… you@laptop' > /home/<you>/.ssh/authorized_keys
   chown <you>:<you> /home/<you>/.ssh/authorized_keys && chmod 600 /home/<you>/.ssh/authorized_keys
   ```
   Sign in as `<you>` in a **second** terminal before going on.
3. **The GitHub deploy key** (on your computer): `ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key`. The public half goes to the VPS now; the private half to GitHub in §6.
4. **Run the host setup** (copy the repository's `ops/` folder to the VPS, e.g. `git clone` or `scp -r`):
   ```bash
   sudo ADMIN_USER=<you> DEPLOY_PUBKEY="$(cat deploy_key.pub)" ADMIN_SSH_CIDR=<hospital egress IP>/32 ops/vps/setup-host.sh
   ```
   [`setup-host.sh`](setup-host.sh) — idempotent — updates the OS and turns on unattended security updates; SSH keys only, no root login, fail2ban; firewall: SSH (from `ADMIN_SSH_CIDR` if given), 80, 443 and nothing else; Docker Engine + Compose; PostgreSQL 15 listening only on `localhost` and the Docker host address, with the containers' subnet allowed only to the application database; the `deploy` account; `/etc/nurseapp`, `/srv/nurseapp` and the containers' network; and the 5-minute health monitor (§8). If the provider has its own firewall (Hostinger: VPS → Firewall), open the same three ports there.

   Some provider images set `PermitRootLogin yes` / `PasswordAuthentication yes` in `/etc/ssh/sshd_config` **above** its `Include` line, where they beat any drop-in (sshd keeps the first value it reads; found on UltaHost). The script comments those global lines out (the original is kept as `sshd_config.before-nurseapp`) and **stops with an error** unless `sshd -T` then reports keys only and no root sign-in. On a host without an IPv6 route it also makes `apt` use IPv4 only. A provider panel action (password reset, plan change) can re-run the image's setup and put such lines back: run `verify-install.sh` afterwards.

**HTTPS** needs nothing else: on the first release Caddy obtains the certificate from Let's Encrypt, redirects HTTP to HTTPS and renews it by itself. HSTS, CSP and the other security headers come from the web container's nginx, as in every deployment.

## 3. Database and settings (once)

```bash
sudo SITE_HOST=nurse.<hospital-domain> ACME_EMAIL=it@<hospital-domain> \
     DATA_RESIDENCY_REGION=ksa-riyadh-<provider> /opt/nurseapp/vps/db-init.sh
```

[`db-init.sh`](db-init.sh) creates the database `nurseapp_v04` and the four roles of [ops/db](../db/README.md) (runtime, migration, backup, audit reader), each with a new random password, and writes the settings files — root-only, `0600`:

| File | Holds | Read by |
| :--- | :--- | :--- |
| `/etc/nurseapp/app.env` | `DATABASE_URL` (runtime role), `JWT_SECRET`, the four encryption keys (newly generated), `CORS_ORIGIN`, the residency region, e-mail settings (empty = off) | API and worker |
| `/etc/nurseapp/migrate.env` | the migration role's URL | the release step only — never the running app |
| `/etc/nurseapp/deploy.env` | `SITE_HOST`, `ACME_EMAIL`, `DB_NAME`; optional `REDIRECT_HOSTS` — names that only forward to `https://SITE_HOST`, space-separated **in double quotes** (the file is read by bash: `REDIRECT_HOSTS="example.org www.example.org"`), each with its own certificate and a DNS A record pointing here | `deploy.sh`, Caddy |
| `/etc/nurseapp/audit-reader.env` | the audit reader's password | compliance queries (§7) |

It refuses to overwrite an existing settings file: new keys would make the stored data unreadable.

**Then, at once: copy `/etc/nurseapp` to the hospital's offline key store** (an encrypted USB key in a safe, a password manager vault — two places). A VPS has no key-management service: these files are the keys. Without `PDPL_FIELD_ENCRYPTION_KEY` and `DOCUMENT_ENCRYPTION_KEY` no backup can be read. Rotating a key later: [DEPLOYMENT.md "Rotating a key"](../../docs/DEPLOYMENT.md#rotating-a-key).

Later edits (e.g. the SMTP relay): edit `app.env`, then `sudo /opt/nurseapp/vps/deploy.sh restart` — the live release is started again in the other colour and switched in the same way as a release, without interruption.

## 4. Settings reference

Everything in [`.env.example`](../../.env.example) may go in `app.env`. Set by the Compose file, not there: `NODE_ENV=production`, `JOBS_MODE`, `TRUST_PROXY`, `UPLOAD_SCANNER=clamav`, `CLAMAV_HOST`. The API and worker refuse to start in production if `DATABASE_URL` can change the schema, a key is missing, the scanner is not ClamAV or the region check fails.

## 5. Backups and point-in-time recovery on one machine

The backup kit ([ops/backup](../backup/README.md)) runs unchanged, on the host, against the host's PostgreSQL:

1. **The backup key pair — not on the VPS.** On an administrator's workstation (or the hospital's key facility):
   ```bash
   gpg --quick-generate-key "AIGH NurseApp backups <it@hospital>" rsa4096 encrypt never
   gpg --armor --export it@hospital > backup.pub      # → the VPS
   gpg --armor --export-secret-keys it@hospital > backup-private.asc   # → the offline key store only
   ```
   The VPS gets only the public half: it can encrypt its backups but never read them — a stolen server does not give away its own backups.
2. **Turn it on:** `scp backup.pub <you>@vps:` then `sudo BACKUP_PUBKEY=~/backup.pub /opt/nurseapp/vps/setup-backup.sh`. [`setup-backup.sh`](setup-backup.sh) turns on continuous WAL archiving (every change, encrypted, into `/srv/backup/wal`; at most 5 minutes behind — `archive_timeout`, decided D-58), the nightly encrypted base backup at 01:00 Riyadh, and the off-site copy. Take the first base backup at once: `sudo systemctl start aigh-backup.service`.
3. **Off-site copy.** One machine is one point of loss: the backups must also leave it. Create a bucket at an S3-compatible object store **in the Kingdom**, with **versioning on** and a lifecycle rule **deleting non-current versions after 31 days**; give the VPS credentials that can write it. Then:
   ```bash
   sudo rclone config --config /etc/nurseapp/rclone.conf          # a remote, e.g. "ksa-backup"
   echo 'RCLONE_REMOTE=ksa-backup:nurseapp-backups' | sudo tee /etc/nurseapp/offsite.env
   sudo chmod 600 /etc/nurseapp/offsite.env /etc/nurseapp/rclone.conf
   sudo systemctl start nurseapp-offsite.service && tail /var/log/aigh-backup.log
   ```
   [`offsite-sync.sh`](offsite-sync.sh) mirrors the WAL archive, the base backups and the document vault (all already encrypted) every 5 minutes. Versioning keeps anything deleted on the VPS — by retention, by an erasure (D-55) or by an intruder — for 31 days, which is the backup window the erasure record states.
4. **Restores** never go over the live database. The kit restores to a *second* cluster on another port (`RESTORE_PORT`), to any instant (PITR), on this VPS or a new one; you check it, then switch. Follow [ops/backup/README.md](../backup/README.md) — including the **restore drill before go-live**, run with the private key on the machine doing the restore. Losing the VPS entirely: a new VPS, §2–§3 with the saved `/etc/nurseapp`, `rclone copy` the bucket back, restore, release.

## 6. Releases: GitHub Actions, blue/green

Images are built by GitHub Actions — **never on the server**: the VPS needs no Node.js, npm, source code or build tools, and it runs exactly the images CI tested. The npm workspaces are built inside the Dockerfiles (`npm ci` + `npm run build -w backend` / `-w frontend`, Vite for the frontend); `npm run db:deploy -w backend` (Prisma `migrate deploy`) is what the `migrate` image runs, as the migration role.

**Setup in GitHub** (Settings → Secrets and variables → Actions, and Settings → Environments):

| Where | Name | Value |
| :--- | :--- | :--- |
| Environment `production` | required reviewers; deployment branches: `main` | — |
| Environment secret | `VPS_SSH_KEY` | the private deploy key (`deploy_key`, §2 step 3) |
| Environment secret | `VPS_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <vps address>` — checked on a second channel (the provider console) |
| Variable | `VPS_HOST` | the VPS address or host name |
| Variable | `APP_URL` | `https://nurse.<hospital-domain>` |

**A release** ([`deploy-vps.yml`](../../.github/workflows/deploy-vps.yml)): every merge to `main` → CI → build `api`, `migrate`, `web` for that commit → **waits for approval** → one SSH call carrying the images and these scripts → on the VPS, [`deploy.sh release`](deploy.sh):

1. migrations as `nurseapp_migration`; then `02_grants.sql` and `verify.sql` — any FAIL stops the release before anything changes for users;
2. the **idle colour** (blue ↔ green) starts beside the live one with the new images;
3. it must answer healthy — nginx → API → database — inside the container network;
4. Caddy is pointed at it with a **graceful reload**: requests in flight finish, new ones go to the new colour, none is dropped;
5. the old colour's job worker stops and the new one's starts (one job runner at a time); after 10 s the old colour stops, kept for rollback.

**Rollback** (`sudo /opt/nurseapp/vps/deploy.sh rollback`, or `ssh deploy@vps rollback` with the deploy key) brings the previous release's colour back in front the same way. **Migrations are forward-only**: a release's schema change must keep working for the version before it — *expand* (add columns, tables), release, and only *contract* (drop, rename) in a later release. This is what makes both the switch and a rollback safe.

The deploy key can run only `nurseapp-release` (`release <commit>` with a bundle on standard input, `rollback`, `status`): no shell, no forwarding. It still installs code that runs as root — treat it as a production credential: only in the protected environment, rotated when people leave. The bundle is checked (only `ops/…` and `images.tar.gz`, no links, no `..`) before anything is written.

`nurseapp-release` is copied to `/usr/local/sbin` by `setup-host.sh` only; a release does not replace it (it is the check that guards releases). After a change to it, install it once from the released scripts:

```bash
sudo install -m 0755 -o root -g root /opt/nurseapp/vps/nurseapp-release /usr/local/sbin/nurseapp-release
```

Each release unpacks its bundle in `/var/tmp/nurseapp-release.*` and deletes it before switching colours. Releases before 2026-10-07 left theirs behind (about 1 GB each); delete them once, while no release is running:

```bash
sudo find /var/tmp -maxdepth 1 -type d -name 'nurseapp-release.*' -mmin +60 -exec rm -rf {} +
```

## 7. The first administrators, and database access

Once the first release is live (the site answers), sign in to the VPS with your key and run:

```bash
ssh <you>@<vps>
sudo /opt/nurseapp/vps/deploy.sh bootstrap
```

It runs the bootstrap command ([`backend/src/cli/bootstrap.ts`](../../backend/src/cli/bootstrap.ts), the same as `npm run bootstrap -w backend`) **inside the running API container**, as the runtime role, over the private container network: it asks for the first System Admin's and HR Admin's names, e-mails and passwords at a hidden prompt, and refuses to run once any account exists. Nothing is exposed: the database never listens on a public address, and nothing is built on the server. Then sign in at `https://<host>` and do the baseline import ([DEPLOYMENT.md §4](../../docs/DEPLOYMENT.md#first-installation-empty-database)); the DPO records the register sign-off.

**Database access** — none from the internet, ever:
- on the VPS: `sudo /opt/nurseapp/vps/deploy.sh psql` (superuser, local socket);
- from a workstation, through SSH: `ssh -N -L 5433:localhost:5432 <you>@<vps>`, then `psql "postgresql://nurseapp_audit_reader:<password from audit-reader.env>@localhost:5433/nurseapp_v04"` — the tunnel ends at the VPS's own `localhost`.

## 8. Running it

| Task | Command (on the VPS) |
| :--- | :--- |
| What is live | `sudo /opt/nurseapp/vps/deploy.sh status` |
| Apply changed settings | `sudo /opt/nurseapp/vps/deploy.sh restart` |
| Logs | `sudo docker logs --since 1h nurseapp-blue-api-1` (colour as `status` shows); Caddy: `nurseapp-edge-caddy-1`; backups: `/var/log/aigh-backup.log` |
| Health now | `sudo /opt/nurseapp/vps/monitor.sh` (PASS / WARN / FAIL per check); the app's own view: Nursing Administration → Jobs → System health |
| OS updates | security updates install themselves; reboot monthly (Docker and PostgreSQL start by themselves; `live-restore` keeps containers up across Docker upgrades) |
| Disk | `df -h /srv` — the WAL archive grows until the nightly backup prunes it |
| Outside monitoring | an external uptime check on `https://<host>/api/v1/health` (it answers 503 when the database is down) |

### Alerts

[`monitor.sh`](monitor.sh) runs every 5 minutes (`nurseapp-monitor.timer`) and checks: the site over HTTPS through Caddy (and the database behind it), the live colour's containers plus Caddy and ClamAV, PostgreSQL, WAL archiving (last segment ≤ 30 min, no failed attempt), the nightly base backup (≤ 26 h), the off-site copy (≤ 20 min), disk (warn 80 %, fail 90 %), the certificate (warn < 14 days, fail < 7 — Caddy renews at 30) and a pending reboot. It alerts when a check starts failing, turns to a warning or recovers, and repeats every 6 hours while something still fails. Who hears it — `/etc/nurseapp/monitor.env` (root, `0600`):

```bash
ALERT_EMAILS=it-oncall@hospital.sa,dba@hospital.sa
# Optional: a Microsoft Teams / Slack incoming webhook as well (JSON {"text": …})
ALERT_WEBHOOK_URL=
# The relay; by default the app's own SMTP settings from app.env are used
# SMTP_HOST=…  SMTP_PORT=587  SMTP_USER=…  SMTP_PASS=…  SMTP_FROM=NurseApp monitor <nurseapp@hospital.sa>
```

After creating or changing it, send a test: `sudo /opt/nurseapp/vps/monitor.sh --test-alert` (exit 1 and the reason if nothing could be sent).

Until e-mail works (the hospital relay, D-47), use the webhook — or at least an **outside** uptime check on `https://<host>/api/v1/health` (it answers 503 when the database is down), since a monitor on the VPS cannot report the VPS itself being down.

### Exit package (moving to another provider)

Spec §14.3 (D-62): everything needed to take the workforce history elsewhere, as one ZIP — workforce master, contract history and events, credentials (sensitive values opened), every evidence file decrypted and renamed `EMP_<id>_<TEMPLATE>_<date>`, the hash-chained audit log with the inputs of each hash, and a SHA-256 manifest ([`exit-package.ts`](../../backend/src/cli/exit-package.ts)). It holds personal data **in clear**, so it is produced only on the server:

```bash
sudo /opt/nurseapp/vps/deploy.sh exit-package "Migration to <new provider>, approved by <name>, <ref>"
```

The ZIP streams from the live API container straight into `gpg`, encrypted to the backup **public** key (`/etc/nurseapp/backup.pub`); no plaintext copy is written on the VPS. The result is `/srv/nurseapp/exit/aigh-exit-package-<UTC time>.zip.gpg` (`0600`, not copied off-site); the run is audited HIGH (`EXIT_PACKAGE_CREATED`, with the reason and the counts). Only the holder of the backup private key can open it — offline, in the hospital: `gpg --decrypt … > package.zip`, then `sha256sum -c MANIFEST.sha256` and read `README.txt` (what is inside, what could not be included, how to re-verify the audit chain). Hand it to the new provider only under a data processing agreement, and destroy every copy once the migration is verified.

## 9. Go-live checklist

`sudo /opt/nurseapp/vps/verify-install.sh` checks the installation against §2–§8 — OS, SSH, firewall, security updates, PostgreSQL's listen addresses, the deploy key's restriction, the settings files and residency region, `verify.sql`, backups (archiving, timer, *no private key on the server*), off-site copy, DNS, HTTPS/HSTS/CSP, certificate, the live release, the first administrators and monitoring — and ends with **READY** or **NOT READY**. Then, before the first real user:

1. `verify-install.sh` reads READY; every WARN is fixed or accepted by name.
2. The **restore drill** passed ([ops/backup](../backup/README.md)) with the private key, on a machine other than the VPS — timed against the RTO.
3. `/etc/nurseapp` and the backup private key are in the offline key store, in two places, and someone other than the installer has checked they open.
4. The hosting contract confirms the data centre (and every backup and snapshot) is in the Kingdom; the DPO has signed off the processing register (Nursing Administration → Data protection).
5. Alerts reach a person: stop Caddy for 5 minutes (`sudo docker stop nurseapp-edge-caddy-1`, then `start`) and confirm the FAILING and RECOVERED messages arrive.
6. A release and a rollback have run through the GitHub workflow with the `production` approval.

## Verification (what was tested, 2026-09-25)

`test/run.sh` stands in for the VPS with Docker — a PostgreSQL 15 container in the host database's place, Caddy with its own local CA instead of Let's Encrypt — and runs the real release images: `db-init.sh` (database, roles, settings files `0600`, and refusing to overwrite them); a first release onto blue; a second release onto green **the way GitHub Actions does it** — a bundle through `nurseapp-release`, which also refused a bundle with a foreign path and a malformed command; then a rollback to blue, then `restart` after a settings change (green). A client polling `https://…/api/v1/health` every 0.2 s during all three switches saw **about 760 requests per run, 0 failed**; HTTP redirected to HTTPS; HSTS present; the retired colour stopped each time; `verify.sql` passed on every release. Monitoring: with Caddy stopped, `monitor.sh --notify` failed and e-mailed FAILING alerts to a test mailbox (once — a second run within 6 hours stayed quiet), and RECOVERED alerts after Caddy was back; `verify-install.sh` passed the checks that apply without a real server (settings, `verify.sql`, HTTPS headers, containers, site) and flagged the missing administrators. The exit package: `deploy.sh exit-package` streamed the ZIP into `gpg` with a test key, left no plaintext or partial file, refused a reason under 10 characters, and the package decrypted with the private key started with the ZIP signature and passed its `MANIFEST.sha256`.

Not tested here: `setup-host.sh`, `setup-backup.sh` and the host-level checks of `verify-install.sh` (SSH, firewall, timers) on a real Ubuntu 24.04 server (they need systemd; the backup kit itself is verified in [ops/backup](../backup/README.md)), Let's Encrypt issuance (needs public DNS), and the workflow's run against a real VPS. Run §2–§7 once on the server with hospital IT and correct anything that differs.
