# IT handover: server steps for this release

For hospital IT and the server administrator. It lists only what has to be done **on the server or in GitHub** for the current version (roster approval chain, two-factor for the new roles, higher sign-in limit). The full tick-box list is [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md); commands are explained in [ops/vps/README.md](../ops/vps/README.md).

Time needed: about 30 minutes, plus the release run. Do it at a **quiet hour**: each release can restart the web server (Caddy) and the virus scanner (ClamAV) when their images changed, which interrupts the site for a short time.

## 1. Before the release (10 minutes)

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
   | `DATA_RESIDENCY_REGION`, `PDPL_ALLOWED_REGIONS` | the region id, **never `local`** | Data residency. |
   | `CORS_ORIGIN`, `APP_BASE_URL` | `https://nurse.<hospital-domain>` | The site address. |

3. The file stays readable by root only (mode `0600`). Copy the changed file to the offline key store (the same two places as the original copy).

Do not run `deploy.sh restart` yet if the release in step 2 follows straight away; the release restarts the application itself.

## 2. The release (Dev and the approver)

1. The developer merges to `main`. GitHub shows **Deploy (VPS)** waiting for the `production` approval.
2. The approver reads the change list, then approves. This should be at the quiet hour agreed above.
3. The workflow must finish **green**. It runs, in this order: tests on the exact images, the database migration `20261031090000_roster_approval`, `02_grants.sql`, `verify.sql` (every check must say PASS), starts the new colour, checks it and switches the site over.
4. If it fails **before** the switch, nothing changed for users: tell the developer. If it fails **after** the switch: on the server run `sudo /opt/nurseapp/vps/deploy.sh rollback`.

The migration only adds (two roles and one table), so rolling back is safe for the database. The older version would again let a Supervisor publish a roster without the Nursing Director.

## 3. Right after the release (10 minutes)

On the server:

```
curl -fsS https://nurse.<hospital-domain>/api/v1/health      # expect {"status":"ok","database":"up"}
sudo /opt/nurseapp/vps/deploy.sh status                       # shows the live colour
sudo /opt/nurseapp/vps/verify-install.sh                      # must end with READY; fix or accept every WARN by name
```

If `app.env` was changed *after* the release, apply it with `sudo /opt/nurseapp/vps/deploy.sh restart`.

In the application (System Admin):

- **Audit → Verify chain** says intact.
- **Nursing Administration → Jobs**: recent runs completed, no `*_PLAINTEXT` warning in System health.

Backups: glance at `/var/log/aigh-backup.log` and confirm the off-site copy is still fresh.

## 4. Role accounts (HR Admin and System Admin, in the application)

No SQL is needed. Under the user administration screens:

1. Create at least one **Nursing Director** and one **Nursing Admin** account, each assigned to the units they cover. A grant for the whole hospital needs a **second administrator to approve it**.
2. The Nursing Director must not be the person who normally asks for approval (nobody can approve their own request).
3. **Until a Nursing Director exists, no roster can be published.** Do this before the first roster is due.
4. Each holder of these roles (and every Supervisor) sets up an authenticator app at their next sign-in. HR can reset a lost authenticator.
5. Try the chain once with test data: the Nursing Admin drafts a week and presses *Ask for approval* → the Nursing Director receives the notice → approves → *Publish week* becomes available. Delete the test shifts afterwards.

## 5. What to tell the users

- Supervisors and Nursing Admins now press **Ask for approval** and wait for the Nursing Director before **Publish week** is available. **A Supervisor can no longer publish alone.**
- Changing the drafts inside an approved period withdraws the approval; it has to be asked for again.
- Staff who hold the roles above will be asked to install an authenticator app (for example Google Authenticator or Microsoft Authenticator) the next time they sign in.

## 6. Done when

- [ ] `app.env` checked and copied to the key store.
- [ ] Deploy (VPS) finished green; health answers `ok`; `verify-install.sh` says READY.
- [ ] Audit chain intact; no new warnings in System health.
- [ ] A Nursing Director and a Nursing Admin exist and the chain was tried once.
- [ ] Users told (section 5).

## 7. Not part of this release, but still open before go-live

Taken from the full list in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md):

- **Restore drill** from the offline backup key, on a machine other than the server (A6).
- **Outside uptime check** on `/api/v1/health`; the monitor on the server cannot report the server itself being down (A8).
- **A native Arabic speaker** reads the roster approval screens and notices.
- Contract confirms in writing that the data centre, backups and snapshots are in the Kingdom (A1).
- The decisions listed at the top of the checklist: credential rules (U2), SCFHS agreement (U3), badge system and Telegram (accept or set up).

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
