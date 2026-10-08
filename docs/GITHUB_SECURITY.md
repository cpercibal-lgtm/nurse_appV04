# GitHub repository security

Audit of 2026-10-07: what Git tracks and has ever tracked, the ignore rules, the workflows and the repository settings, with the setup steps. The application's own security review is [SECURITY_REVIEW_2026-10-04.md](SECURITY_REVIEW_2026-10-04.md).

## 1. What the plan allows

The repository is **private** and owned by a **personal account**. On GitHub that decides what is available:

| Feature | Private repository, personal account | Here |
| :--- | :--- | :--- |
| Branch protection for `main` | GitHub **Pro** or higher | §4 (needs Pro) |
| Dependabot alerts, security updates, version updates | Every plan | §5, `.github/dependabot.yml` |
| Secret scanning and push protection | Only with GitHub Team / Enterprise and GitHub Secret Protection | Replaced by the **Secret scan** workflow (gitleaks) |
| Code scanning (CodeQL) | Only with GitHub Team / Enterprise and GitHub Code Security | Template in §6, not switched on |

## 2. Findings

Every line ever committed (245 commits) was searched for private keys, Telegram bot tokens, cloud and GitHub tokens, database addresses with a password, and secret assignments.

| # | Where | Finding | Risk | Action |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Git history: `backend/.mk.cjs`, commits `2dc0d7b` → removed in `a9b5505` (23–24 Sep 2026) | A scratch script with the local `aigh` database password. The repository was public until 4 Oct 2026. | Low: that password works only on the developer computer's own PostgreSQL and is **no longer the current one** | None required. Never reuse it. `.gitignore` has kept dot-scripts out since. |
| 2 | `docker-compose.yml` | Development database with a published default password, port open on every network interface (ClamAV too) | Medium on a shared network | **Fixed**: both ports bound to `127.0.0.1` |
| 3 | `.github/workflows/deploy-vps.yml`, `deploy.yml` | `workflow_run` with `branches: [main]` also matches a CI run of a pull request from a fork whose branch is named `main` | Medium: a fork's code could reach the approval step | **Fixed**: release only after a CI run of a **push** to this repository |
| 4 | `.github/workflows/ci.yml` | No `permissions:`, so the job token had the repository default | Low | **Fixed**: `contents: read` |
| 5 | `.gitignore` | No rules for certificates and SSH keys, database dumps, downloaded MFA recovery codes, editor folders, test output | Medium (accidental commit) | **Fixed** (none of the new rules hides a tracked file) |
| 6 | `backend/.env` (not tracked) | The real settings: database passwords, encryption keys, SMTP, Telegram token | High if committed | Ignored; stage named files only, never `git add -A` |
| 7 | `Assets/` (not tracked, not ignored) | The owner's own folder; `git add -A` would commit it | Medium | Add it to `.git/info/exclude` (local only), §3 |
| 8 | `.env.example`, `ci.yml` (`ci_password`), `docs/reference/…v2_8_7.md` | Example and throw-away CI passwords | None | Keep; they are documented placeholders |
| 9 | Workflows | Actions pinned to major tags (`@v5`), not commit hashes | Low | Dependabot keeps them current; pin third-party actions to hashes when convenient |
| 10 | `.github/workflows/deploy.yml` | Google Cloud release (D-49), inert until `GCP_PROJECT` is set; production is the VPS | Low | Remove it if Google Cloud is no longer planned |

Not found anywhere in the history: private keys, Telegram tokens, cloud, GitHub or API tokens, SMTP passwords, production database passwords. Production secrets live only in `/etc/nurseapp` on the server and in the GitHub `production` environment (deploy key limited to one command, `nurseapp-release`).

## 3. Local safety (each developer computer)

Keep a personal folder out of `git add` without changing the shared `.gitignore`:

```bash
echo "/Assets/" >> .git/info/exclude
```

Before committing, check that nothing secret is staged:

```bash
git diff --cached --name-only
```

## 4. Protect `main` (GitHub Pro)

Install the GitHub CLI once (`winget install --id GitHub.cli`), then sign in:

```bash
gh auth login
```

Merge settings: squash merges only (GitHub signs the squash commit, which the signed-commit rule needs), and delete the branch after the merge:

```bash
gh repo edit cpercibal2018-cmyk/nurse_appV04 --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge
```

Branch protection: pull request required, the four checks must pass on an up-to-date branch, linear history, no force pushes or deletion, conversations resolved:

```bash
gh api -X PUT repos/cpercibal2018-cmyk/nurse_appV04/branches/main/protection -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "build-and-test" },
      { "context": "fhir-validate" },
      { "context": "images" },
      { "context": "gitleaks" }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

Signed commits:

```bash
gh api -X POST repos/cpercibal2018-cmyk/nurse_appV04/branches/main/protection/required_signatures -H "Accept: application/vnd.github+json"
```

Check the result:

```bash
gh api repos/cpercibal2018-cmyk/nurse_appV04/branches/main/protection
```

Why these values with **one maintainer**: nobody can approve their own pull request, so 1 required approval or "Require review from Code Owners" would block every merge (or force the admin bypass each time). A pull request with passing checks is still required. When a second maintainer joins, add them to `.github/CODEOWNERS`, then set `"required_approving_review_count": 1` and `"require_code_owner_reviews": true`, and `"enforce_admins": true`.

Signing your own commits (optional with squash merges, which GitHub signs):

```bash
git config --global gpg.format ssh
```

```bash
git config --global user.signingkey ~/.ssh/id_ed25519.pub
```

```bash
git config --global commit.gpgsign true
```

```bash
gh ssh-key add ~/.ssh/id_ed25519.pub --type signing --title "signing key"
```

## 5. Dependabot

`.github/dependabot.yml` opens weekly pull requests (Sunday 06:00 Riyadh) for npm (workspace and `ops/e2e`), GitHub Actions and the Docker base images, minor and patch updates grouped.

**Not proposed** (owner decision 2026-10-07, after the first run opened Node 25, `@types/node` 26, TypeScript 7 and nginx 1.31):

| Dependency | Ignored | Why |
| :--- | :--- | :--- |
| Docker `node` | New majors | Production stays on a Node LTS line (22). Odd majors are never LTS. The move to Node 24 is planned work before 22's end of life (April 2027): images, `@types/node`, CI, the VPS, together |
| `@types/node` | New majors | Must match the Node version that runs |
| `typescript` | New majors | TypeScript 7 is the rewritten compiler; upgraded on purpose, with testing |
| Docker `nginx` | Odd minor versions (1.29, 1.31, …) | nginx's odd minors are the mainline line; even minors are stable |

Patch and minor updates of all of them still come. Ignore rules do not hold back **security** updates. If a rule is not honoured (Settings → Code security → Dependabot shows the last run and any configuration error), close the pull request with the comment `@dependabot ignore this major version` (or `minor version` for nginx).

Turn on the alerts and the automatic security fixes:

```bash
gh api -X PUT repos/cpercibal2018-cmyk/nurse_appV04/vulnerability-alerts
```

```bash
gh api -X PUT repos/cpercibal2018-cmyk/nurse_appV04/automated-security-fixes
```

Known and accepted: 4 high advisories in Prisma 7.10's own dependencies (`mysql2`, `deepmerge-ts`), not used by the application; re-check when Prisma is updated. `npm audit --omit=dev` reports none.

## 6. Code scanning (CodeQL) — template

Not available for this private repository on the current plan (§1). With GitHub Team or Enterprise and Code Security switched on (Settings → Advanced Security), save this as `.github/workflows/codeql.yml` and add `analyze (javascript-typescript)` to the required checks:

```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 3 * * 0"
permissions:
  contents: read
  security-events: write
jobs:
  analyze:
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        language: [javascript-typescript, actions]
    steps:
      - uses: actions/checkout@v5
      - uses: github/codeql-action/init@v4
        with:
          languages: ${{ matrix.language }}
          queries: security-extended
      - uses: github/codeql-action/analyze@v4
        with:
          category: "/language:${{ matrix.language }}"
```

## 7. Secret scanning

GitHub's secret scanning and push protection need GitHub Secret Protection for a private repository (§1). Until then the **Secret scan** workflow (`.github/workflows/secret-scan.yml`, gitleaks) checks the commits of every push to `main` and every pull request, and fails the check when it finds one. If the repository ever gets Secret Protection, switch it on under Settings → Advanced Security → Secret Protection and Push protection, and keep the workflow as a second line.

If a secret is found: change it where it is used first (server settings, GitHub secrets), then remove it from the code. Rewriting Git history does not un-expose a secret that was already pushed.
