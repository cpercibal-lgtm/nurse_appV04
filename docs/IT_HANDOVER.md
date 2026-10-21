# IT handover: installing the server and releasing this version

For hospital IT and the server administrator. **The server is new**, so this page has two parts:

- **Part A: install the server (once).** From the contract to a running, backed-up, monitored site with its first administrators.
- **Part B: the release.** Settings, the release run, the checks afterwards, the role accounts for roster approval, and what to tell users. On a new server the first release is the same procedure.

The full tick-box list is [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) (it covers the same steps in more detail; its step numbers differ from this page). Every command is explained in [ops/vps/README.md](../ops/vps/README.md). Stop at the first step that fails; do not skip ahead.

**One thing to know first:** the install scripts were tested against a stand-in for the server, not on a real Ubuntu 24.04 machine ([ops/vps/README.md](../ops/vps/README.md), "Verification"). The first real run may differ in small ways. If a script stops, keep its message and send it to the developer; do not work around a failing check.

**Who does what:** *IT* = hospital IT and the server administrator · *Owner* = the hospital's decision maker · *DPO* = data protection officer · *Dev* = whoever maintains the repository · *Approver* = the person who approves the production deployment in GitHub.

---

# Part A. Install the server (once)

## A1. Choose and contract the server (Owner, IT)

- A data centre **in the Kingdom**, confirmed **in writing**, for the server, its backups and its snapshots. A Hostinger server is not allowed to hold the hospital's staff data (no site in the Kingdom); it may hold demonstration data only.
- A region id that names the site, e.g. `ksa-riyadh-<provider>`. The same value goes in `DATA_RESIDENCY_REGION` and `PDPL_ALLOWED_REGIONS`.
- Size: 4 vCPU, 16 GB RAM, 200 GB NVMe. The plain **Ubuntu 24.04** image, no control-panel template (no Coolify or similar).
- A public IPv4 address. Ports **22, 80 and 443** open, also in the provider's own firewall.
- The hospital's outbound (egress) IP address, to restrict SSH to it.
- An S3-compatible storage bucket **also in the Kingdom**, for the off-site backup copy (A6).

## A2. DNS (IT)

Create an `A` record `nurse.<hospital-domain>` → the server's IPv4 address (and one for every extra name that should forward to the site). Check from any machine:

```
dig +short nurse.<hospital-domain>        # must print the server's address
```

The certificate cannot be issued until this answers.

## A3. Your account and the deploy key (IT)

On your own computer: `ssh-keygen -t ed25519` (your key) and `ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key` (the key GitHub will use; the private half goes to the Dev in A7, the public half to the server now).

On the server, as root:

```
adduser <you> && usermod -aG sudo <you>
install -d -m 700 -o <you> -g <you> /home/<you>/.ssh
echo 'ssh-ed25519 AAAA… you@laptop' > /home/<you>/.ssh/authorized_keys
chown <you>:<you> /home/<you>/.ssh/authorized_keys && chmod 600 /home/<you>/.ssh/authorized_keys
```

**Open a second terminal and sign in as `<you>` before going on.** The next step turns off root and password sign-in.

## A4. Prepare the server (IT)

Copy the repository's `ops/` folder to the server (`git clone` or `scp -r`), then:

```
sudo ADMIN_USER=<you> DEPLOY_PUBKEY="$(cat deploy_key.pub)" ADMIN_SSH_CIDR=<hospital egress IP>/32 ops/vps/setup-host.sh
```

It updates the system, turns on automatic security updates, allows SSH by key only (no root, fail2ban on), opens only SSH, 80 and 443, installs Docker and PostgreSQL 15 (reachable only from the server and its containers), creates the restricted `deploy` account and installs the scripts in `/opt/nurseapp`. It stops with an error if it cannot make SSH keys-only. It is safe to run again.

After **any** later action in the provider's panel (password reset, plan change) run `sudo /opt/nurseapp/vps/verify-install.sh` again: the provider's image may switch root or password sign-in back on.

## A5. Database and settings files (IT, with the DBA if there is one)

```
sudo SITE_HOST=nurse.<hospital-domain> ACME_EMAIL=it@<hospital-domain> \
     DATA_RESIDENCY_REGION=ksa-riyadh-<provider> /opt/nurseapp/vps/db-init.sh
```

It creates the database, its four database roles with new random passwords, and four settings files in `/etc/nurseapp` (root only, mode `0600`), among them `app.env`, which holds the encryption keys. It refuses to overwrite existing files, because new keys would make stored data unreadable.

**At once: copy all of `/etc/nurseapp` to the hospital's offline key store, in two places** (for example an encrypted USB key in a safe and a password-manager vault). **There is no other copy of these keys.** Without `PDPL_FIELD_ENCRYPTION_KEY` and `DOCUMENT_ENCRYPTION_KEY` no backup can ever be read. A person other than the installer checks that the copy opens.

## A6. Backups (IT)

1. **Make the backup key pair on another computer, never on the server:**

   ```
   gpg --quick-generate-key "AIGH NurseApp backups <it@hospital>" rsa4096 encrypt never
   gpg --armor --export it@hospital > backup.pub
   gpg --armor --export-secret-keys it@hospital > backup-private.asc
   ```

   `backup-private.asc` goes to the offline key store only. `backup.pub` goes to the server: it can lock backups but never open them.

2. **Turn backups on and take the first one:**

   ```
   scp backup.pub <you>@<server>:
   sudo BACKUP_PUBKEY=~/backup.pub /opt/nurseapp/vps/setup-backup.sh
   sudo systemctl start aigh-backup.service
   ```

3. **Off-site copy** to the bucket in the Kingdom. In the bucket, switch **versioning on** and add a rule that **deletes non-current versions after 31 days**. Then on the server:

   ```
   sudo rclone config --config /etc/nurseapp/rclone.conf        # create a remote, e.g. "ksa-backup"
   echo 'RCLONE_REMOTE=ksa-backup:nurseapp-backups' | sudo tee /etc/nurseapp/offsite.env
   sudo chmod 600 /etc/nurseapp/offsite.env /etc/nurseapp/rclone.conf
   sudo systemctl start nurseapp-offsite.service && tail /var/log/aigh-backup.log
   ```

   The log must show success. After this the copy repeats every 5 minutes.

4. **Restore drill:** on a machine other than the server, with the private key, restore a backup and time it. Follow [ops/backup/README.md](../ops/backup/README.md). Do this **before** real data goes in.

## A7. GitHub (Dev)

In the repository settings:

| Where | Name | Value |
|---|---|---|
| Environment `production` | required reviewers; deployment branches: `main` only | the Approver(s) |
| Environment secret | `VPS_SSH_KEY` | the private half of `deploy_key` |
| Environment secret | `VPS_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <server>`, checked on a second channel such as the provider's console |
| Variable | `VPS_HOST` | the server's address or name |
| Variable | `APP_URL` | `https://nurse.<hospital-domain>` |

Also check that the latest `main` is green in CI. Then delete `deploy_key` from your computer once the Dev has it.

## A8. Monitoring (IT)

Create `/etc/nurseapp/monitor.env` (root, mode `0600`):

```
ALERT_EMAILS=it-oncall@hospital.sa,dba@hospital.sa
ALERT_WEBHOOK_URL=        # optional: a Teams or Slack incoming webhook
```

Then `sudo /opt/nurseapp/vps/monitor.sh --test-alert` and confirm **a person** received it. If hospital e-mail is not ready, use the webhook. Also set up an **outside** uptime check on `https://nurse.<hospital-domain>/api/v1/health`: the monitor on the server cannot report the server itself being down.

## A9. Then go to Part B

Do Part B **now** for the settings and the first release. Come back for A10 once the site is live.

## A10. First administrators and hospital data (IT, HR, DPO), after the first release

On the server:

```
sudo /opt/nurseapp/vps/deploy.sh bootstrap
```

It asks, at a hidden prompt, for the names, e-mails and passwords of the first **System Admin** and a hospital-wide **HR Admin**. These must be **two different people**. It refuses to run once any account exists. Both sign in at `https://nurse.<hospital-domain>` and set up their authenticator app.

Then, in the application:

1. HR previews and requests the **hospital baseline import**; the System Admin approves it; it is applied.
2. HR enters the credential requirements (once the Director of Nursing has supplied them), then accounts, employees and contracts.
3. HR reviews the beds and the nurse-to-bed settings in Workforce. QMPS stays *not* counted as a bedside nurse.
4. The DPO records the processing register sign-off (Nursing Administration → Data protection).
5. **Never load the demonstration data on this server.**

## A11. Last checks before the first real user (IT, DPO, Owner)

- [ ] `sudo /opt/nurseapp/vps/verify-install.sh` ends with **READY**; every WARN is fixed or accepted by name.
- [ ] Alerts work: `sudo docker stop nurseapp-edge-caddy-1`, wait 5 minutes, then `sudo docker start nurseapp-edge-caddy-1`. The FAILING and RECOVERED messages reached a person.
- [ ] A release **and a rollback** have both run through the GitHub workflow (`sudo /opt/nurseapp/vps/deploy.sh rollback`).
- [ ] The restore drill passed (A6) and the offline key store was checked by a second person (A5).
- [ ] The hosting contract confirms the data centre, backups and snapshots are in the Kingdom; the DPO has signed off.
- [ ] Owner: **go-live approved**: name, date.

---

# Part B. The release

## B1. Before the release

`db-init.sh` (A5) already wrote `app.env` with the keys, the region, the database address and the site address. Only check and add to it.

1. Sign in to the server and open the settings file:

   ```
   sudo nano /etc/nurseapp/app.env
   ```

2. Set or check these lines (a line that is missing means the built-in default applies):

   | Setting | Value | Why |
   |---|---|---|
   | `LOGIN_THROTTLE_MAX_PER_CLIENT` | `100` | Staff sign in over mobile internet, so many people share one carrier address. The built-in default (20 failed attempts per address in 15 minutes) would lock them out. |
   | `LOGIN_THROTTLE_MAX_PER_ACCOUNT` | `5` (leave) | One account is still locked after 5 wrong passwords. |
   | `MFA_REQUIRED_ROLES` | only if the line already exists: `SYSTEM_ADMIN,HR_ADMIN,SUPERVISOR,NURSING_ADMIN,NURSING_DIRECTOR` | The two new roles must use an authenticator app. If the line is absent, the default already contains all five. Production refuses a list without `SYSTEM_ADMIN` and `HR_ADMIN`. |
   | `SMTP_HOST` and the other `SMTP_*` lines | the hospital's mail account | Without them, approval notices reach people only inside the app, not by e-mail. |
   | `DATA_RESIDENCY_REGION`, `PDPL_ALLOWED_REGIONS` | the region id from A1, **never `local`** | Data residency. `db-init.sh` set the first; check that the second lists the same id. |
   | `CORS_ORIGIN`, `APP_BASE_URL` | `https://nurse.<hospital-domain>` | The site address (set by `db-init.sh`; check). |

3. The file stays readable by root only (mode `0600`). Copy the changed file to the offline key store (the same two places as the original copy).

Do not run `deploy.sh restart` for this: the release in B2 starts the application with the new settings. (`restart` is for later edits.)

## B2. The release (Dev and the approver)

1. The developer merges to `main`. GitHub shows **Deploy (VPS)** waiting for the `production` approval.
2. The approver reads the change list, then approves. Before the hospital is using the site any time is fine. From the second release on, choose a **quiet hour**: a release can restart the web server (Caddy) and the virus scanner (ClamAV) when their images changed, which interrupts the site for a short time.
3. The workflow must finish **green**. It runs, in this order: tests on the exact images, the database migrations (on a new server all of them, including `20261031090000_roster_approval`), `02_grants.sql`, `verify.sql` (every check must say PASS), starts the new colour, checks it and switches the site over.
4. If it fails **before** the switch, nothing changed for users: tell the developer. If it fails **after** the switch and an earlier release exists: on the server run `sudo /opt/nurseapp/vps/deploy.sh rollback`. After the very first release there is nothing to roll back to; tell the developer.

From the second release on, rolling back is safe for the database (migrations only add). Rolling back past the roster approval release would again let a Supervisor publish a roster without the Nursing Director.

## B3. Right after the release

On the server:

```
curl -fsS https://nurse.<hospital-domain>/api/v1/health      # expect {"status":"ok","database":"up"}
sudo /opt/nurseapp/vps/deploy.sh status                       # shows the live colour
sudo /opt/nurseapp/vps/verify-install.sh                      # must end with READY; fix or accept every WARN by name
```

On a new server `verify-install.sh` will report the missing administrators until A10 is done; that is expected. Run it again after A10.

If `app.env` was changed *after* the release, apply it with `sudo /opt/nurseapp/vps/deploy.sh restart`.

In the application (System Admin):

- **Audit → Verify chain** says intact.
- **Nursing Administration → Jobs**: recent runs completed, no `*_PLAINTEXT` warning in System health.

Backups: glance at `/var/log/aigh-backup.log` and confirm the off-site copy is still fresh.

## B4. Role accounts (HR Admin and System Admin, in the application)

Do this after A10 (the first administrators must exist). No SQL is needed. Under the user administration screens:

1. Create at least one **Nursing Director** and one **Nursing Admin** account, each assigned to the units they cover. A grant for the whole hospital needs a **second administrator to approve it**.
2. The Nursing Director must not be the person who normally asks for approval (nobody can approve their own request).
3. **Until a Nursing Director exists, no roster can be published.** Do this before the first roster is due.
4. Each holder of these roles (and every Supervisor) sets up an authenticator app at their next sign-in. HR can reset a lost authenticator.
5. Try the chain once with test data: the Nursing Admin drafts a week and presses *Ask for approval* → the Nursing Director receives the notice → approves → *Publish week* becomes available. Delete the test shifts afterwards.

## B5. What to tell the users

- Supervisors and Nursing Admins now press **Ask for approval** and wait for the Nursing Director before **Publish week** is available. **A Supervisor can no longer publish alone.**
- Changing the drafts inside an approved period withdraws the approval; it has to be asked for again.
- Staff who hold the roles above will be asked to install an authenticator app (for example Google Authenticator or Microsoft Authenticator) the next time they sign in.

## B6. Done when

- [ ] `app.env` checked and copied to the key store.
- [ ] Deploy (VPS) finished green; health answers `ok`; `verify-install.sh` says READY.
- [ ] Audit chain intact; no new warnings in System health.
- [ ] A Nursing Director and a Nursing Admin exist and the chain was tried once.
- [ ] Users told (B5).
- [ ] On a new server: A10 and A11 are done.

## B7. Still open before go-live (not for IT to decide)

Taken from the full list at the top of [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md):

- **A native Arabic speaker** reads the roster approval screens and notices.
- **Credential rules (U2):** the Director of Nursing supplies the real requirements; until then the rules in the system are placeholders.
- **SCFHS agreement (U3):** until it is signed, production looks up no licence with SCFHS (`SCFHS_DRIVER` unset = `off`, D-75) and HR records website checks by hand (D-74).
- **Badge system and Telegram:** set up, or accepted as not connected for go-live.
- **Hospital questions still unanswered:** the 72 unnamed beds, 281 vs 286, ICU Extension, the Assistant Nurse licence, C1, C2 and C5 ([HOSPITAL_OPEN_QUESTIONS.md](HOSPITAL_OPEN_QUESTIONS.md)). The KPI figures use the "for now" values until HR changes them.

## If something goes wrong

| Symptom | First action |
|---|---|
| Site down or health not `ok` after the switch | `sudo /opt/nurseapp/vps/deploy.sh rollback`, then tell the developer. |
| Staff report "too many attempts" at sign-in | Check `LOGIN_THROTTLE_MAX_PER_CLIENT` is `100` and the application was restarted after the change. |
| A Nursing Director cannot approve | They may be the requester themselves, or their assignment does not cover that unit and those dates. |
| *Publish week* stays unavailable | No approved period covers the dates, or the drafts changed after approval (withdrawn). Ask for approval again. |
| Approval e-mails do not arrive | `SMTP_HOST` empty or wrong; notices still appear in the application. |
| A person lost their authenticator | HR resets two-factor for that account; they set up a new one at the next sign-in. |

Logs: `sudo docker logs --since 1h nurseapp-blue-api-1` (use the colour `deploy.sh status` shows); Caddy: `nurseapp-edge-caddy-1`.
