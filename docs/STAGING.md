# Staging deployment and manual SCFHS acceptance

Staging is a separate VPS containing synthetic data only. Never copy production databases, documents, keys or backups into it. The workflow does not provision a server or create GitHub settings.

## Set up once

1. Prepare a separate VPS and DNS using [the VPS guide](../ops/vps/README.md), including host setup, database roles, ClamAV, settings and a restricted deploy account. Use distinct database passwords, encryption keys and deploy keys. Configure its hostname and HTTPS for this staging server. The normal runtime configuration and region checks still apply.
2. In GitHub Settings → Environments, create **staging**, restrict deployment branches to **main**, and set any required reviewers. Keep production settings in its own environment.
3. Add the following **environment-scoped** settings under staging. Every value must identify the staging server; do not reuse production credentials. Verify the SSH host key against the provider console before saving it.

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `STAGING_VPS_HOST` | Staging hostname or IPv4 address, without a username or port |
| Variable | `STAGING_APP_URL` | HTTPS origin, such as `https://stage.example.test` (optional port; no credentials or path) |
| Secret | `STAGING_VPS_SSH_KEY` | Private key for the staging restricted deploy account |
| Secret | `STAGING_VPS_KNOWN_HOSTS` | Verified staging SSH known_hosts entry |

4. After the first successful release, bootstrap separate staging administrator/HR accounts using the VPS guide and enter synthetic test records through the application. The development fixture command refuses production-mode databases; do not bypass that guard or load real employee data.

## Release

After this workflow is merged, open Actions → **Deploy (staging)** → **Run workflow**, choosing **main**. It releases the commit selected by that dispatch, not a later moving branch head. A dispatch from any other branch is skipped.

Missing staging settings or an invalid destination fails before image building or SSH. Production-named settings are never used as a fallback. The workflow builds the API, migration and web images once, runs the existing browser/accessibility and release-path harness on those images, bundles them with a manifest, and sends them to the restricted staging SSH command. The server applies migrations, database grants and verification, then switches blue/green. A public health check must pass. The deployment concurrency group is separate from production.

A green workflow proves the scripted release checks; it does not complete the following human acceptance checks. Record the deployed commit, testers, time and outcomes in your release record.

## Manual SCFHS acceptance

Use synthetic employees in two different units and separate test accounts: an HR administrator in scope, an HR administrator outside scope, a supervisor, an employee, and a System Admin who can elevate.

- [ ] Confirm `/api/v1/health` is healthy and the deployed commit contains migration `20261102090000_scfhs_website_checks`.
- [ ] As scoped HR, open Credentials → SCFHS. Upload a synthetic website-check PDF/image through Evidence and select a clean file belonging to this credential.
- [ ] Record an observed status, past check time and notes. Confirm a new history entry shows **Manual website check**, its observation and recording times, recorder user ID, notes and evidence link.
- [ ] Confirm credential status, document review status and eligibility match their values immediately before saving the observation. Saving an observation does not approve, suspend or revoke a credential.
- [ ] With a System Admin, inspect Audit and confirm `SCFHS_WEBSITE_CHECK_RECORDED` refers to the credential, log and evidence. Verify the audit chain is intact.
- [ ] Record a correction as another observation. Confirm the earlier entry remains and there is no edit/delete action.
- [ ] Try an absent/unclean/erased file or a file from another credential, and a future check time. Confirm the request is rejected without a new observation.
- [ ] Confirm out-of-scope HR, supervisors, employees and a non-elevated System Admin cannot record observations or read the SCFHS history. Confirm out-of-scope HR and supervisors cannot open evidence. The credential's holder retains their existing own-document access.
- [ ] Elevate the System Admin and confirm recording works in scope.
- [ ] Run the separate **Run simulated check** action. Confirm history labels it **Simulated registry** and the manual entry remains distinct. Confirm simulated adverse results never suspend a credential or change eligibility.
- [ ] Repeat the recording/history/evidence journey in Arabic and confirm the right-to-left layout and translated labels are usable.

## Rollback

Use the existing [VPS rollback procedure](../ops/vps/README.md#6-releases-github-actions-bluegreen) on the staging server. Migrations remain forward-only. Confirm health, the displayed workflow and stored history after the switch. Keep staging and production release records separate.
