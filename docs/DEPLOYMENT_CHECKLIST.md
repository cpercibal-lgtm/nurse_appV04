# Server deployment checklist

A short list of only the steps for the current release, written for IT: [IT_HANDOVER.md](IT_HANDOVER.md).

A tick-box list for putting V04 on the production server and for later releases. It does not replace the guides; each step says where the detail is. Layout: one Ubuntu 24.04 VPS in the Kingdom, blue/green releases through GitHub Actions ([ops/vps/README.md](../ops/vps/README.md), decision D-57).

Use it twice: **Part A** once, for a new server; **Part B** for every release after that. Record the date and your initials beside each step. Stop at the first step that fails; do not skip ahead.

**Who:** *IT* = hospital IT / server administrator · *DBA* · *DPO* = data protection officer · *Owner* = the hospital's decision maker · *Dev* = whoever maintains the repository.

---

## Before you start: what is still open

These are decisions, not tasks. Production should not open until each is settled or accepted by name. (Source: [DEPLOYMENT.md §6](DEPLOYMENT.md#6-known-gaps-before-production), [MIGRATION.md §4](MIGRATION.md#4-open-programme-items-v03-remediation-tracker).)

- [ ] **U1, hosting.** A VPS in a data centre *in the Kingdom*, with a contract that says so, and an S3-compatible backup bucket also in the Kingdom. A Hostinger server may hold synthetic data only.
- [ ] **U2, credential policy and position rules.** The Director of Nursing supplies the real credential requirements and grace windows. Until then the rules in the system are placeholders.
- [ ] **U3, SCFHS agreement.** Licence checks answer from a *simulated* registry (`SCFHS_DRIVER=mock`) until it is signed. Decide whether go-live accepts that.
- [ ] **Badge system** is not connected; attendance gaps show only simulated events. Accept or delay.
- [ ] **Telegram bot** is not set up; alerts stay in the Dev Console inbox (`NOTIFICATION_DRIVER=mock`). Accept or set it up (A12).
- [ ] **Hospital questions** ([HOSPITAL_OPEN_QUESTIONS.md](HOSPITAL_OPEN_QUESTIONS.md)): the 72 unnamed beds, 281 vs 286, ICU Extension, Assistant Nurse licence, C1, C2, C5 are unanswered. The KPI figures use the "for now" values until HR changes them in Workforce.
- [ ] A **native Arabic speaker** has read the roster approval screens and notices.

---

# Part A. A new server (once)

## A1. Choose and contract the server (Owner, IT)
- [ ] Data centre in the Kingdom confirmed *in writing*; the same for backups and snapshots.
- [ ] Region id decided, e.g. `ksa-riyadh-<provider>`; the same value goes in `DATA_RESIDENCY_REGION` and `PDPL_ALLOWED_REGIONS`.
- [ ] Size: 4 vCPU, 16 GB RAM, 200 GB NVMe; plain **Ubuntu 24.04** image, no control-panel template.
- [ ] Public IPv4; ports 22, 80, 443 open (also in the provider's own firewall).
- [ ] Hospital's outbound (egress) IP known, for restricting SSH.

## A2. DNS (IT)
- [ ] `A` record: `nurse.<hospital-domain>` → the server's IPv4.
- [ ] Any extra names that should forward to the site (`REDIRECT_HOSTS`) also have an `A` record.
- [ ] `dig +short nurse.<hospital-domain>` returns the server's address (Caddy needs this before the first release).

## A3. Prepare the server (IT) — [ops/vps/README.md §2](../ops/vps/README.md#2-prepare-the-vps)
- [ ] Your own admin account with an SSH key; you can sign in as it in a *second* terminal.
- [ ] Deploy key pair created (`ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key`); public half on the server, private half kept for A7.
- [ ] `sudo ADMIN_USER=<you> DEPLOY_PUBKEY="$(cat deploy_key.pub)" ADMIN_SSH_CIDR=<hospital egress IP>/32 ops/vps/setup-host.sh` finished without error.
- [ ] After any provider-panel action (password reset, plan change): run `verify-install.sh` again; the image may have re-enabled root or password login.

## A4. Database and settings (IT, DBA) — [§3](../ops/vps/README.md#3-database-and-settings-once)
- [ ] `sudo SITE_HOST=… ACME_EMAIL=… DATA_RESIDENCY_REGION=… /opt/nurseapp/vps/db-init.sh` created the database, the four roles and the four settings files in `/etc/nurseapp` (mode `0600`).
- [ ] **`/etc/nurseapp` copied to the hospital's offline key store, in two places.** Someone other than the installer checked that the copy opens. (Without the encryption keys no backup can be read.)

## A5. Settings to review in `/etc/nurseapp/app.env` (IT, Dev) — [DEPLOYMENT.md §2](DEPLOYMENT.md#2-configuration)
- [ ] `NODE_ENV=production`, `DATA_RESIDENCY_REGION` and `PDPL_ALLOWED_REGIONS` set to the region id; never `local`.
- [ ] `CORS_ORIGIN` and `APP_BASE_URL` = `https://nurse.<hospital-domain>`.
- [ ] The four keys exist and differ from each other: `MFA_ENCRYPTION_KEY`, `DOCUMENT_ENCRYPTION_KEY`, `PDPL_FIELD_ENCRYPTION_KEY`, `PDPL_BLIND_INDEX_PEPPER`.
- [ ] **`LOGIN_THROTTLE_MAX_PER_CLIENT=100`** (hospital reply D1: staff use mobile internet, so many people share a carrier address). `LOGIN_THROTTLE_MAX_PER_ACCOUNT` stays 5.
- [ ] `MFA_REQUIRED_ROLES` includes at least `SYSTEM_ADMIN` and `HR_ADMIN` (production refuses a list without them). The default list also covers `SUPERVISOR`, `NURSING_ADMIN` and `NURSING_DIRECTOR`, so the people who approve and publish rosters must set up an authenticator app at their next sign-in.
- [ ] E-mail: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_REPLY_TO`; `EMAIL_HOURLY_LIMIT` below the provider's limit (UltaMail: 150). Empty `SMTP_HOST` means e-mail is off, so roster approval notices reach people in the app only.
- [ ] `BREAK_GLASS_ALERT_EMAILS` = the CEO and the IT Director.
- [ ] `NOTIFICATION_DRIVER`, `SCFHS_DRIVER` and `BADGE_SIMULATOR` match the decisions above. `DEMO_PASSWORD` is **not** set.
- [ ] `BACKUP_RETENTION_DAYS` equals the backup kit's value.
- [ ] Apply later edits with `sudo /opt/nurseapp/vps/deploy.sh restart`.

## A6. Backups (IT, DBA) — [§5](../ops/vps/README.md#5-backups-and-point-in-time-recovery-on-one-machine)
- [ ] Backup key pair generated *off the server*; only `backup.pub` is on the server; the private key is in the offline key store.
- [ ] `sudo BACKUP_PUBKEY=~/backup.pub /opt/nurseapp/vps/setup-backup.sh` done; first base backup taken (`sudo systemctl start aigh-backup.service`).
- [ ] Off-site bucket in the Kingdom: versioning on, non-current versions deleted after 31 days; `rclone` remote configured; `offsite.env` written; `sudo systemctl start nurseapp-offsite.service` ran and the log shows success.
- [ ] **Restore drill passed** with the private key, on a machine other than the server, and timed against the recovery time target ([ops/backup/README.md](../ops/backup/README.md)).

## A7. GitHub (Dev) — [§6](../ops/vps/README.md#6-releases-github-actions-bluegreen)
- [ ] Environment `production`: required reviewers set; deployment branches limited to `main`.
- [ ] Environment secrets `VPS_SSH_KEY` (private deploy key) and `VPS_KNOWN_HOSTS` (from `ssh-keyscan -t ed25519 <server>`, checked on a second channel such as the provider console).
- [ ] Variables `VPS_HOST` and `APP_URL`.
- [ ] The latest `main` is green in CI (build-and-test, images, fhir-validate, gitleaks).

## A8. Monitoring (IT)
- [ ] `/etc/nurseapp/monitor.env` has `ALERT_EMAILS` (and a webhook if e-mail is not ready).
- [ ] `sudo /opt/nurseapp/vps/monitor.sh --test-alert` sent a message to a person.
- [ ] An **outside** uptime check watches `https://nurse.<hospital-domain>/api/v1/health` (the monitor on the server cannot report the server itself being down).

## A9. First release (Dev, approver)
- [ ] Merge to `main`; the **Deploy (VPS)** workflow waits for the `production` approval; the approver approves.
- [ ] The workflow finished green. This ran the migrations, `02_grants.sql` and `verify.sql` (every check PASS), started the new colour, checked it, and switched Caddy.
- [ ] `https://nurse.<hospital-domain>` opens over HTTPS with a valid certificate (Let's Encrypt issues it on the first release).
- [ ] `curl -fsS https://nurse.<hospital-domain>/api/v1/health` answers `{"status":"ok","database":"up"}`.
- [ ] `sudo /opt/nurseapp/vps/deploy.sh status` shows the live colour.

## A10. First administrators and hospital data (IT, HR, DPO) — [§7](../ops/vps/README.md#7-the-first-administrators-and-database-access), [DEPLOYMENT.md "First installation"](DEPLOYMENT.md#first-installation-empty-database)
- [ ] `sudo /opt/nurseapp/vps/deploy.sh bootstrap` created the first **System Admin** and a hospital-wide **HR Admin** (two different people) and, if wanted, the break-glass account. Both set up their authenticator app.
- [ ] HR previews and requests the **hospital baseline import**; the System Admin elevates and approves; applied.
- [ ] HR enters the credential requirements (once U2 is settled), then accounts, employees and contracts.
- [ ] Beds and the nurse-to-bed settings reviewed in Workforce (units, `counts as nurse`, patient-care areas, inpatient beds). QMPS stays *not* counted (hospital reply A6).
- [ ] The DPO records the **processing register sign-off** (Nursing Administration → Data protection).
- [ ] Never run the demo fixtures here.

## A11. Roster approval roles (HR Admin, System Admin) — decision D-71
- [ ] At least one **Nursing Director** and one **Nursing Admin** account exist, each with a role assignment scoped to the right units (a system-wide grant needs a second administrator to approve it).
- [ ] The Nursing Director is not the person who normally asks for approval (a requester can never approve their own request).
- [ ] Try it once with test data: Nursing Admin drafts and asks → the Nursing Director gets the notice → approves → Publish becomes available. Then remove the test shifts.
- [ ] **Until a Nursing Director exists, no roster can be published.** Do this before the first roster is due.

## A12. Optional integrations
- [ ] **Telegram:** a bot from @BotFather owned by the hospital, token in `app.env`, `NOTIFICATION_DRIVER=telegram`, outbound HTTPS to `api.telegram.org`, chat ids for the CEO and IT Director ([DEPLOYMENT.md §2.3](DEPLOYMENT.md#23-telegram-replaces-sms)).
- [ ] **SCFHS live checks:** only after the agreement (U3).
- [ ] **Badge system:** register it as an API client with the `attendance.ingest` scope (D-65).

## A13. Verify, then open (IT, DBA, DPO, Owner) — [§9](../ops/vps/README.md#9-go-live-checklist)
- [ ] `sudo /opt/nurseapp/vps/verify-install.sh` ends with **READY**; every WARN is fixed or accepted by name.
- [ ] Stop Caddy for 5 minutes (`sudo docker stop nurseapp-edge-caddy-1`, then `start`): the FAILING and RECOVERED alerts arrived.
- [ ] A **release and a rollback** have both run through the workflow (`deploy.sh rollback`), with no failed requests.
- [ ] A System Admin opened **Audit → Verify chain** (intact) and **Nursing Administration → Jobs** (recent runs completed, no `*_PLAINTEXT` warnings in System health).
- [ ] Contract confirms the data centre, backups and snapshots are in the Kingdom; the DPO has signed off.
- [ ] Staff told to install an authenticator app before their first sign-in; a recovery path (HR resets two-factor) is known.
- [ ] Owner signs: **go-live approved** — name, date: __________

---

# Part B. Every later release (Dev, approver, IT)

## B1. Before merging
- [ ] CI is green on the commit; read the PR for **migrations** (anything under `backend/prisma/migrations`) and for **new settings** (`.env.example`, `backend/src/config/env.ts`).
- [ ] Migrations are *forward-only and expand-first*: the previous version must keep working with the new schema (so a rollback is safe). A migration that drops or renames something is a *contract* step and belongs in a later release.
- [ ] Any new required setting is already in `/etc/nurseapp/app.env`, **before** the release (the API refuses to start without a missing key).
- [ ] If the release changes who can do what (new roles or permissions): the matching role assignments are planned for right after it.
- [ ] Tell the affected users beforehand if a screen or a rule changes behaviour.

## B2. The release
- [ ] Merge to `main`; the approver checks the diff and approves the `production` deployment.
- [ ] The workflow is green: tests on the exact images, migrations, `02_grants.sql`, `verify.sql`, health check, switch.
- [ ] If it failed *before* the switch: nothing changed for users; fix and release again. If it failed *after*: `sudo /opt/nurseapp/vps/deploy.sh rollback`.

## B3. After the release
- [ ] `curl -fsS https://nurse.<hospital-domain>/api/v1/health` is `ok`; `deploy.sh status` shows the new colour.
- [ ] System health (Nursing Administration → Jobs) shows no new warnings; **Audit → Verify chain** is intact.
- [ ] Look at `/var/log/aigh-backup.log` and `monitor.sh` once: backups and off-site copy still running.
- [ ] Check the one thing the release was for (a screen, a notice, a rule) with a real account.

## B4. Routine
- [ ] Monthly: reboot for OS updates; `df -h /srv`; confirm the off-site copy is fresh.
- [ ] Quarterly: a restore drill; confirm the offline key store still opens; review who holds `SYSTEM_ADMIN`, `NURSING_DIRECTOR` and `NURSING_ADMIN`.
- [ ] Yearly: the DPO re-signs the processing register (it also falls due after any change).
- [ ] When someone leaves: revoke their role assignments; rotate the deploy key if they had access to it.

---

# This release: roster approval (D-71) and what it needs on an existing server

For a server that already runs an earlier version, the roster approval work (pull requests #12, #13, #14) needs, in order:

1. - [ ] **Deploy** through the workflow (Part B). The migration `20261031090000_roster_approval` adds the roles `NURSING_ADMIN` and `NURSING_DIRECTOR` and the table `roster_approvals`. It is forward-only; the previous version still works with it. `02_grants.sql` and `verify.sql` run as part of the release; on a hand-run server you must run them yourself.
2. - [ ] **Set `LOGIN_THROTTLE_MAX_PER_CLIENT=100`** in `/etc/nurseapp/app.env`, then `sudo /opt/nurseapp/vps/deploy.sh restart`.
3. - [ ] **Grant the roles** (A11) before the first roster is due.
4. - [ ] **Tell the users:** Supervisors and Nursing Admins now press *Ask for approval* and wait for the Nursing Director before *Publish week* becomes available. **A Supervisor can no longer publish alone.**
5. - [ ] If `MFA_REQUIRED_ROLES` is set in `/etc/nurseapp/app.env`, add `NURSING_ADMIN,NURSING_DIRECTOR` to it (the built-in default already has them); each holder sets up an authenticator app at their next sign-in (A5).
6. - [ ] Have the Arabic wording read by a native speaker.

**Rollback note:** rolling back to the release before this one is safe for the schema, but that version lets a Supervisor publish without approval again, and rosters already approved stay in `roster_approvals` unused.
