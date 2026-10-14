# Documentation

## The authoritative set

| Document | Read it for |
| :--- | :--- |
| [USER_MANUAL.md](USER_MANUAL.md) | **How to use the system**, task by task (generated; also in the app under Guidelines, and as [a PDF](generated/AIGH_Nursing_Workforce_User_Manual_V04.pdf)) |
| [GUIDELINES_COVERAGE.md](GUIDELINES_COVERAGE.md) | The trace behind the user manual: every user-facing task from screen to permission, rule and status |
| [SYSTEM_SPECIFICATION.md](SYSTEM_SPECIFICATION.md) | **What the system must do**: the reference specification plus every owner amendment, clarification, open conflict and REQUIREMENT NOT ESTABLISHED item |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it is built: components, layout, modules, request flow, jobs, tests |
| [RBAC.md](RBAC.md) | Roles, scopes, the permission table (checked against the code by a test), field visibility, separation of duties, PAM, break-glass |
| [SECURITY_REVIEW_2026-10-04.md](SECURITY_REVIEW_2026-10-04.md) | Security review of the whole application: input validation, SQL, admin routes, secrets, XSS, dependencies — findings and fixes |
| [CLINICAL_ELIGIBILITY.md](CLINICAL_ELIGIBILITY.md) | Credentials, the eligibility engine, grace, waivers, policy transitions, reminders |
| [WORKFORCE.md](WORKFORCE.md) | Organisation, employees, contracts, scheduling, attendance |
| [API.md](API.md) | Every endpoint, with permission, scope and source |
| [DATABASE_ARCHITECTURE.md](DATABASE_ARCHITECTURE.md) | Data domains and relationships, database-enforced rules, the audit chain, migrations, **how data enters the database** (bootstrap, baseline import, fixtures) |
| [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md) | The database-first migration: old vs new architecture, steps, data mapping, import process, rollback, validation |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Configuration, processes and jobs, release steps, backups, **known gaps before production**, monitoring |
| [STAFF_IMPORT_DESIGN.md](STAFF_IMPORT_DESIGN.md) | **Proposed, not built**: importing staff from the spreadsheet template (v3), API, screen, limits, tests and open points |
| [IT_HANDOVER.md](IT_HANDOVER.md) | **For hospital IT**: the server steps for the current release (settings, release, checks, role accounts, what to tell users) |
| [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) | **Tick-box checklist for the server**: new installation, every later release, and what the roster approval release needs |
| [MIGRATION.md](MIGRATION.md) | Moving from V03: data, user-visible changes, V03 programme items |
| [SEED_DATA_INVENTORY.md](SEED_DATA_INVENTORY.md) | The complete original seed (organisation, positions, credential catalogue, demo data) as it was before hospital data moved out of TypeScript |
| [CHANGELOG.md](../CHANGELOG.md) | Versions and what changed in each, from the `0.1.0` baseline |
| [CLEANUP_REPORT.md](CLEANUP_REPORT.md) | What the final cleanup removed, moved and kept, and the full validation matrix |
| [V04_ARCHITECTURE_PLAN.md](V04_ARCHITECTURE_PLAN.md) | The plan, the **owner decision record** (§9a, D-1 … D-50) and implementation notes per commit |
| [reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md](reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md) | The original specification, verbatim (never edited) |

## Rule register

| Document | Contents |
| :--- | :--- |
| [FEATURE_MASTER_INVENTORY.md](FEATURE_MASTER_INVENTORY.md) | The **business rule register** (§15: R, E, C, D, L, W, S, N, A rule IDs cited by the code, the tests, the first migration and these documents). Its other sections are the stage-1 feature inventory of V03 and are historical |

## History (stage-1 analysis of V03)

Produced before V04 was built and retired in commit 12 ([CLEANUP_REPORT.md §1.2](CLEANUP_REPORT.md#12-moved)). They describe V03 and the plan for V04, not V04 as built; kept unchanged for traceability.

| Document | Contents |
| :--- | :--- |
| [history/LEGACY_REPOSITORY_INVENTORY.md](history/LEGACY_REPOSITORY_INVENTORY.md) | What V03 contained |
| [history/DUPLICATE_IMPLEMENTATION_MAP.md](history/DUPLICATE_IMPLEMENTATION_MAP.md) | Where V03 implemented the same thing more than once |
| [history/DATABASE_CONSOLIDATION.md](history/DATABASE_CONSOLIDATION.md) | How V03's four schema sources became the V04 schema |
| [history/CLEANUP_PLAN.md](history/CLEANUP_PLAN.md) | What was to happen to each V03 file |

## Keeping the documents true

- `npm run docs:check` (also part of `npm test` and CI) fails on any broken link or heading anchor in these documents.
- `backend/test/docs.test.ts` fails if [RBAC.md](RBAC.md) §3 and the permission table in the code differ.
- The user manual is generated from `frontend/src/modules/guidelines/content` by `npm run docs:manual` (Markdown, workflow images, PDF); `guidelines.test.ts` fails if the generated files and the content differ, or if a Guidelines link points at a page or section that does not exist.
- A new owner decision gets a D-number in the decision record first; the affected documents then cite it.
