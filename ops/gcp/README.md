# Production on Google Cloud — Dammam, `me-central2` (decision D-49)

> **Alternative layout, not chosen.** Production runs on a single VPS in the Kingdom (D-57, [ops/vps](../vps/README.md)). This folder is kept, tested, in case the hospital later moves to Google Cloud; its Deploy workflow skips itself while `GCP_PROJECT` is unset.

How V04 runs in production and how a release reaches it. The container images, the app-VM runtime and the release scripts in this folder are built and tested locally (see *Verification*); **the Google Cloud commands below have not been run against a real project from this repository** — run them once with the hospital's cloud administrator, in order, and correct anything the console reports.

```
 users ──HTTPS──▶ Regional external HTTPS load balancer (me-central2)
                   · Google-managed certificate · Cloud Armor allowlist
                   · adds X-Client-Ip: {client_ip_address}
                        │  proxy-only subnet ──▶ tcp:8080
                        ▼
 ┌──────────── nurseapp-app (Compute Engine, no public IP) ────────────┐
 │ web (nginx: frontend + /api proxy) ─▶ api ─▶ clamav (clamd)         │
 │ worker (jobs + e-mail dispatcher)      uploads: /srv/nurseapp/storage│
 └──────────────┬───────────────────────────────┬──────────────────────┘
                │ tcp:5432 (VPC only)           │ HA VPN ─▶ hospital SMTP relay
                ▼                               ▼
 nurseapp-db (Compute Engine, PostgreSQL 15)   hospital network
   backup kit (ops/backup) ─▶ Cloud Storage bucket, me-central2
 Egress (freshclam, OS updates): Cloud NAT. Admin access: IAP only.
```

| Piece | Choice (owner, 2026-09-24) |
| :--- | :--- |
| Compute | One Compute Engine VM running the containers with Docker Compose ([`docker-compose.yml`](docker-compose.yml)) |
| Database | PostgreSQL 15, self-managed on its own VM, so [ops/db](../db/README.md) and [ops/backup](../backup/README.md) apply unchanged |
| Releases | GitHub Actions ([`deploy.yml`](../../.github/workflows/deploy.yml)): images built after CI passes on `main`; production changes only after a reviewer approves |

## 1. Data residency (do this first)

Everything is created in `me-central2`. Enforce it for the project so nothing lands elsewhere by mistake:

- Organization policy **`gcp.resourceLocations`** → allow only `in:me-central2-locations` on the project.
- **Cloud Logging** stores logs in a `global` bucket by default, and a bucket's location **cannot be changed after it exists**. Either set the organization's default *before creating the project* — `gcloud logging settings update --organization=<ORG_ID> --storage-location=me-central2` — or, for an existing project, create a regional bucket and send the `_Default` sink to it:
  ```bash
  gcloud logging buckets create nurseapp-logs --location=me-central2 --retention-days=90
  gcloud logging sinks update _Default logging.googleapis.com/projects/$PROJECT/locations/me-central2/buckets/nurseapp-logs
  ```
  The application logs carry identifiers only, never personal data, but they stay in the Kingdom too.
- Artifact Registry, the backup bucket and disk snapshots below all name `me-central2` explicitly.
- `DATA_RESIDENCY_REGION=me-central-2` and `PDPL_ALLOWED_REGIONS=me-central-2` in the app settings (§5); the API refuses to start otherwise.

## 1a. Pre-flight: confirm `me-central2` has what this design needs

Run these before creating anything else; each must succeed. If one fails, stop and review the design (a global load balancer changes the residency picture, §6).

```bash
gcloud compute regions describe me-central2 --format='value(status)'                        # UP
gcloud compute machine-types describe e2-standard-4 --zone=me-central2-a --format='value(name)'
gcloud compute images describe-from-family debian-12 --project=debian-cloud --format='value(name)'
# Regional external Application Load Balancer: the proxy-only subnet in §2 is the real test —
# `--purpose=REGIONAL_MANAGED_PROXY` succeeds only where the regional load balancer is offered.
gcloud certificate-manager certificates list --location=me-central2                          # an empty list, not an error
gcloud compute security-policies list --regions=me-central2                                  # regional Cloud Armor: empty list, not an error
```

Google's own list is the "Regional external Application Load Balancer — supported regions" page in the Cloud Load Balancing documentation; check `me-central2` is on it.

## 2. Project, network, firewall

```bash
PROJECT=<project-id>; REGION=me-central2; ZONE=me-central2-a
gcloud config set project $PROJECT
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com iap.googleapis.com \
  logging.googleapis.com certificatemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

gcloud compute networks create nurseapp-vpc --subnet-mode=custom
gcloud compute networks subnets create nurseapp-subnet --network=nurseapp-vpc --region=$REGION \
  --range=10.20.0.0/24 --enable-private-ip-google-access
# The regional load balancer's proxies live in a proxy-only subnet; this is LB_PROXY_SUBNET (§5).
gcloud compute networks subnets create nurseapp-lb-proxy --network=nurseapp-vpc --region=$REGION \
  --range=10.20.8.0/23 --purpose=REGIONAL_MANAGED_PROXY --role=ACTIVE

# Outbound only through Cloud NAT (ClamAV signatures, OS packages); the VMs have no public IP.
gcloud compute routers create nurseapp-router --network=nurseapp-vpc --region=$REGION
gcloud compute routers nats create nurseapp-nat --router=nurseapp-router --region=$REGION \
  --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges

gcloud compute firewall-rules create nurseapp-iap-ssh --network=nurseapp-vpc --direction=INGRESS \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=nurseapp-app,nurseapp-db
gcloud compute firewall-rules create nurseapp-lb-to-web --network=nurseapp-vpc --direction=INGRESS \
  --allow=tcp:8080 --source-ranges=10.20.8.0/23,35.191.0.0/16,130.211.0.0/22 --target-tags=nurseapp-app
gcloud compute firewall-rules create nurseapp-app-to-db --network=nurseapp-vpc --direction=INGRESS \
  --allow=tcp:5432 --source-tags=nurseapp-app --target-tags=nurseapp-db
```

**Hospital network (D-47):** the SMTP relay is inside the hospital. Hospital IT and the cloud administrator connect `nurseapp-vpc` to it with **HA VPN** (or Interconnect), advertise only the relay's address, and let the hospital firewall admit `10.20.0.0/24` to it. Until then e-mail stays off (`SMTP_HOST` empty). Telegram (D-66, which replaced the hospital SMS gateway of D-48) is reached over the internet at `api.telegram.org:443`.

## 3. Registry, service accounts, GitHub identity

```bash
gcloud artifacts repositories create nurseapp --repository-format=docker --location=$REGION
NUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
REPO=percibalvillegas18/nurse_appV04
POOL=projects/$NUM/locations/global/workloadIdentityPools/github

for sa in nurseapp-app-vm nurseapp-db-vm nurseapp-build nurseapp-deploy; do gcloud iam service-accounts create $sa; done
SA() { echo "$1@$PROJECT.iam.gserviceaccount.com"; }

# VMs: pull images, write logs and metrics; the DB VM also writes backups (§4).
gcloud artifacts repositories add-iam-policy-binding nurseapp --location=$REGION --member=serviceAccount:$(SA nurseapp-app-vm) --role=roles/artifactregistry.reader
for sa in nurseapp-app-vm nurseapp-db-vm; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$(SA $sa) --role=roles/logging.logWriter
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$(SA $sa) --role=roles/monitoring.metricWriter
done
# Build: push images. Deploy: SSH through IAP with sudo (OS Login), nothing else.
gcloud artifacts repositories add-iam-policy-binding nurseapp --location=$REGION --member=serviceAccount:$(SA nurseapp-build) --role=roles/artifactregistry.writer
for role in roles/compute.osAdminLogin roles/iap.tunnelResourceAccessor roles/compute.viewer; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$(SA nurseapp-deploy) --role=$role
done
for sa in nurseapp-app-vm nurseapp-db-vm; do
  gcloud iam service-accounts add-iam-policy-binding $(SA $sa) --member=serviceAccount:$(SA nurseapp-deploy) --role=roles/iam.serviceAccountUser
done

# Keyless GitHub Actions sign-in, limited to this repository's main branch.
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github-repo --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"
# Build SA: any job of the repository on main. Deploy SA: only the approved `production` environment job.
gcloud iam service-accounts add-iam-policy-binding $(SA nurseapp-build) --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL/attribute.repository/$REPO"
gcloud iam service-accounts add-iam-policy-binding $(SA nurseapp-deploy) --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/$POOL/subject/repo:$REPO:environment:production"
```

No service-account key is ever created.

## 4. The two VMs

```bash
common=(--zone=$ZONE --subnet=nurseapp-subnet --no-address --image-family=debian-12 --image-project=debian-cloud
        --shielded-secure-boot --shielded-vtpm --metadata=enable-oslogin=TRUE --scopes=cloud-platform)
gcloud compute instances create nurseapp-db  "${common[@]}" --machine-type=e2-standard-4 --boot-disk-size=30GB \
  --create-disk=name=nurseapp-db-data,size=200GB,type=pd-ssd,auto-delete=no --service-account=$(SA nurseapp-db-vm) --tags=nurseapp-db
gcloud compute instances create nurseapp-app "${common[@]}" --machine-type=e2-standard-4 --boot-disk-size=50GB \
  --create-disk=name=nurseapp-app-data,size=100GB,type=pd-balanced,auto-delete=no --service-account=$(SA nurseapp-app-vm) --tags=nurseapp-app

# Daily disk snapshots kept in the region (in addition to the database backups).
gcloud compute resource-policies create snapshot-schedule nurseapp-daily --region=$REGION \
  --daily-schedule --start-time=22:00 --max-retention-days=14 --storage-location=$REGION
gcloud compute disks add-resource-policies nurseapp-db-data  --zone=$ZONE --resource-policies=nurseapp-daily
gcloud compute disks add-resource-policies nurseapp-app-data --zone=$ZONE --resource-policies=nurseapp-daily
```

**Database VM** (`gcloud compute ssh nurseapp-db --tunnel-through-iap`):

1. Mount the data disk (e.g. at `/var/lib/postgresql`), install PostgreSQL 15 from the PostgreSQL apt repository.
2. `postgresql.conf`: `listen_addresses = 'localhost,<VM internal IP>'`, `ssl = on`, `password_encryption = scram-sha-256`. `pg_hba.conf`: `hostssl nurseapp_v04 all 10.20.0.0/24 scram-sha-256`; nothing else remote.
3. Create the owner login and database `nurseapp_v04`, then the roles: [ops/db/README.md](../db/README.md) steps 1–4 (`verify.sql` must pass).
4. The backup kit: [ops/backup/README.md](../backup/README.md) (WAL archiving, encrypted nightly base backup at 01:00 Riyadh, restore drill). Copy its encrypted output off the VM to a bucket in the region:
   ```bash
   gcloud storage buckets create gs://$PROJECT-nurseapp-backups --location=$REGION --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets add-iam-policy-binding gs://$PROJECT-nurseapp-backups --member=serviceAccount:$(SA nurseapp-db-vm) --role=roles/storage.objectAdmin
   # after each nightly run (cron / systemd):  gcloud storage rsync -r <kit output dir> gs://$PROJECT-nurseapp-backups/
   ```
   Set a retention policy on the bucket matching the hospital's backup retention.

**App VM** (`gcloud compute ssh nurseapp-app --tunnel-through-iap`):

1. Mount the data disk at `/srv/nurseapp`.
2. Install Docker Engine and the Compose plugin (Docker's Debian repository), then `gcloud auth configure-docker me-central2-docker.pkg.dev` for root (the VM's service account pulls the images).
3. Create the settings files (§5), `chmod 600`, owned by root.

## 5. Settings on the app VM

| File | Contents |
| :--- | :--- |
| `/etc/nurseapp/deploy.env` | `REGISTRY=me-central2-docker.pkg.dev/<project>/nurseapp` and `LB_PROXY_SUBNET=10.20.8.0/23` |
| `/etc/nurseapp/migrate.env` | `MIGRATION_DATABASE_URL=postgresql://nurseapp_migration:<pw>@<db-ip>:5432/nurseapp_v04?sslmode=require` and `DATABASE_URL=` the same (only the release step reads this file) |
| `/etc/nurseapp/app.env` | Everything in [`.env.example`](../../.env.example) for production: `DATABASE_URL` = `nurseapp_runtime` (with `?sslmode=require`), `JWT_SECRET`, `MFA_ENCRYPTION_KEY`, `DOCUMENT_ENCRYPTION_KEY`, `PDPL_FIELD_ENCRYPTION_KEY` and `PDPL_BLIND_INDEX_PEPPER` (four different `openssl rand -base64 32` values; all also stored with the backup keys), `CORS_ORIGIN` = the public URL, `DATA_RESIDENCY_REGION=me-central-2`, `PDPL_ALLOWED_REGIONS=me-central-2`, the SMTP settings (D-47) and `BREAK_GLASS_ALERT_EMAILS`. `NODE_ENV`, `JOBS_MODE`, `TRUST_PROXY`, `UPLOAD_SCANNER` and `CLAMAV_HOST` are set by the Compose file |

Passwords are URL-encoded if they contain `@ : / ? # %`. The API and worker refuse to start in production if `DATABASE_URL` can change the schema, if the scanner is not ClamAV, or if the region is not in the Kingdom.

## 6. Load balancer

A **regional** external HTTPS load balancer in `me-central2`, so TLS ends in the Kingdom (a global load balancer terminates at Google's edge, which can be abroad). Confirm with the cloud administrator that the regional external Application Load Balancer and Certificate Manager regional certificates are available in `me-central2`; if not, stop and review residency before using a global one.

```bash
gcloud compute instance-groups unmanaged create nurseapp-app-ig --zone=$ZONE
gcloud compute instance-groups unmanaged add-instances nurseapp-app-ig --zone=$ZONE --instances=nurseapp-app
gcloud compute instance-groups set-named-ports nurseapp-app-ig --zone=$ZONE --named-ports=http:8080
gcloud compute health-checks create http nurseapp-hc --region=$REGION --port=8080 --request-path=/healthz
gcloud compute backend-services create nurseapp-be --region=$REGION --load-balancing-scheme=EXTERNAL_MANAGED \
  --protocol=HTTP --port-name=http --health-checks=nurseapp-hc --health-checks-region=$REGION \
  --custom-request-header='X-Client-Ip:{client_ip_address}'
gcloud compute backend-services add-backend nurseapp-be --region=$REGION --instance-group=nurseapp-app-ig --instance-group-zone=$ZONE
gcloud compute url-maps create nurseapp-lb --region=$REGION --default-service=nurseapp-be
# Certificate for the hospital's host name (e.g. nurse.<hospital-domain>), proved by a DNS record:
HOST=<nurse.hospital-domain>
gcloud certificate-manager dns-authorizations create nurseapp-dns --domain=$HOST --location=$REGION
gcloud certificate-manager dns-authorizations describe nurseapp-dns --location=$REGION --format='value(dnsResourceRecord)'
#   → add that CNAME record in the hospital's DNS, then:
gcloud certificate-manager certificates create nurseapp-cert --domains=$HOST --dns-authorizations=nurseapp-dns --location=$REGION
gcloud certificate-manager certificates describe nurseapp-cert --location=$REGION --format='value(managed.state)'   # wait for ACTIVE
gcloud compute target-https-proxies create nurseapp-https --region=$REGION --url-map=nurseapp-lb --url-map-region=$REGION \
  --certificate-manager-certificates=projects/$PROJECT/locations/$REGION/certificates/nurseapp-cert
gcloud compute addresses create nurseapp-ip --region=$REGION --network-tier=PREMIUM
gcloud compute forwarding-rules create nurseapp-443 --region=$REGION --load-balancing-scheme=EXTERNAL_MANAGED \
  --network=nurseapp-vpc --address=nurseapp-ip --target-https-proxy=nurseapp-https --target-https-proxy-region=$REGION --ports=443
gcloud compute addresses describe nurseapp-ip --region=$REGION --format='value(address)'
#   → an A record for $HOST pointing at this address in the hospital's DNS
```

The `X-Client-Ip` header is how the API learns the user's real address (sign-in limits, session history): nginx accepts it only from `LB_PROXY_SUBNET`. **Recommended:** a Cloud Armor regional security policy on `nurseapp-be` that allows only the hospital's public egress addresses (and any approved remote-access ranges); the application is for hospital staff.

## 7. GitHub

- Repository **variables** (Settings → Secrets and variables → Actions → Variables): `GCP_PROJECT`, `GCP_WIF_PROVIDER` (`projects/<num>/locations/global/workloadIdentityPools/github/providers/github-repo`), `GCP_BUILD_SA`, `GCP_DEPLOY_SA`, `GCP_ZONE` (`me-central2-a`), `GCP_APP_VM` (`nurseapp-app`), `GCP_DB_VM` (`nurseapp-db`), `DB_NAME` (`nurseapp_v04`), `APP_URL` (`https://<host>`). No secrets are needed.
- Environment **`production`** (Settings → Environments) with **required reviewers** and "deployment branches: `main` only". Until `GCP_PROJECT` is set the Deploy workflow skips itself.

## 8. A release

Every merge to `main` → CI → **Deploy** builds `api`, `migrate` and `web` tagged with the commit and pushes them to Artifact Registry → waits for approval → then, over IAP:

1. app VM: `deploy.sh pull <sha>` and `deploy.sh migrate <sha>` (`prisma migrate deploy` as `nurseapp_migration`);
2. DB VM: `db-release.sh nurseapp_v04` (`02_grants.sql`, then `verify.sql` — any FAIL stops the release before the new version starts);
3. app VM: `deploy.sh up <sha>` (waits until healthy, records the release);
4. a health check through the public URL.

**First release only:** after step 3, create the first administrators: `sudo docker compose -f /opt/nurseapp/gcp/docker-compose.yml exec api node dist/cli/bootstrap.js` (with `REGISTRY`, `TAG` and `LB_PROXY_SUBNET` exported), then the baseline import ([DEPLOYMENT.md §4](../../docs/DEPLOYMENT.md#first-installation-empty-database)).

**Operations on the app VM:** `sudo /opt/nurseapp/gcp/deploy.sh status`; `… rollback` restarts the previous images (migrations are forward-only, so only while the schema change is backward compatible); logs in Cloud Logging (`resource.type="gce_instance"`, container name in the labels).

## Verification (what was tested, 2026-09-24)

Locally with Docker, against a PostgreSQL 15 container standing in for the DB VM: images built; roles applied; `deploy.sh migrate` (migrations as `nurseapp_migration`); `02_grants.sql` + `verify.sql` all PASS; `deploy.sh up` with this Compose file — API and worker started in production mode as `nurseapp_runtime` (start-up guards and residency passed), jobs ran, nginx served the app and proxied `/api`; a browser sign-in through nginx with the Content-Security-Policy in force (no console errors, session survived a reload); `X-Client-Ip` honoured only from a trusted proxy address and a forged `X-Forwarded-For` ignored; `deploy.sh up` of a second tag and `rollback`. ClamAV started but could not download signatures in the test environment. Not tested: anything in Google Cloud itself (§1–§7) and the Deploy workflow's run.
