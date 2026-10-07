# Security policy

This repository holds the AIGH Nursing Workforce Management System, which processes hospital staff personal data.

## Reporting a vulnerability

Do **not** open a public issue, pull request or discussion for a security problem. Write to the maintainer at **nursing_admin@aighnursing.net** with what you found, how to reproduce it and what it could expose. You will get an acknowledgement within 3 working days.

Never include real staff data, passwords or keys in a report: describe them instead.

## Secrets

No password, key or token belongs in this repository. Settings live in `backend/.env` on a developer's computer (ignored by Git) and in `/etc/nurseapp/*.env` on the server; the deploy key and server fingerprint are GitHub environment secrets. Every push and pull request is checked by the **Secret scan** workflow (gitleaks). If a secret is committed anyway, treat it as exposed: change it first, then remove it from the code.

How the repository is protected, and how to set it up: [docs/GITHUB_SECURITY.md](docs/GITHUB_SECURITY.md).
