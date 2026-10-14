# Staff import: design (proposed, not built)

Status: **proposal for review**, 14 October 2026. Proposed decision number: **D-72**. Nothing here is built yet.

## 1. Goal

HR loads the hospital's nursing staff from one spreadsheet instead of typing each person into **Nurses → Onboard employee**. Each row becomes exactly what onboarding creates today: the **employee record** and a **Draft first contract**. Nothing else is created: no account, no credentials, no role.

What happens after the import is unchanged: HR uploads each signed contract and submits it, a second administrator approves it (D-30), HR sends the registration invitation, and credentials are recorded and verified as usual.

## 2. The file

**`AIGH_Staff_Import_Template_v3.xlsx`**: the hospital's version 2 with the Salary column removed. It has 1,000 rows (2–1001), 22 data columns and the automatic Check column (W).

| Column | Header | Required | What the importer reads |
|---|---|---|---|
| A | Job Number * | yes | text, ≤ 40, unique ignoring case (E1) |
| B | First Name * | yes | text, ≤ 80 |
| C | Middle Name | | text, ≤ 80 |
| D | Last Name * | yes | text, ≤ 80 |
| E | Nationality * | yes | `Filipino (PHL)` → code in brackets `PHL` |
| F | Contact E-mail * | yes | e-mail, lower-cased |
| G | Mobile Phone | | E.164 after removing spaces, hyphens and brackets (D-35) |
| H | Emergency Contact Phone | | as G |
| I | Unit | | `ICU_MAIN — …` → code before ` — `; empty = Unassigned |
| J | Position | | code before ` — `; empty = SN (E6) |
| K | Job Title | | text, ≤ 120 |
| L | Rank/Grade * | yes | code before ` — ` |
| M | Nursing Specialty * | yes | code before ` — ` |
| N | Job Post Region * | yes | code before ` — ` (`SA-01`) |
| O | Job Post City * | yes | city **name**, looked up within the region → city id |
| P | Facility * | yes | facility **name**, ignoring case and extra spaces → facility id |
| Q | File No. | | text, ≤ 40 |
| R | Marital Status | | Single / Married / Others |
| S | Hire Date | | Excel date → `YYYY-MM-DD` |
| T | Contract Type * | yes | code before ` — ` |
| U | Contract Start * | yes | Excel date |
| V | Contract End * | yes | Excel date, after U (C5) |
| W | Check (automatic) | | **ignored**: the server checks every row itself |

**Recognising the file.** The importer finds the sheet named `Staff` and checks that row 1 holds exactly these 23 headers in this order. Anything else is refused with one message naming the first header that differs, before any row is read.

**Salary.** A file with a `Salary` header (version 2) is **refused**: "This is template version 2. Use version 3, which has no Salary column." This enforces the decision that salary never travels in a spreadsheet. Salary stays an optional field that HR enters in the application.

**Empty rows** are skipped. A row counts as filled if any of A–V has a value; the template's formulas live only in W.

## 3. How it works

```
Browser                                        Server
───────                                        ──────
choose file (.xlsx, ≤ 5 MB)
read sheet "Staff" in the browser
check headers / version
turn rows into plain JSON ───────────────────▶ POST /api/v1/employees/import  {rows, dryRun: true}
                                               validate + resolve codes, per row
show report  ◀──────────────────────────────── CREATE / UNCHANGED / CONFLICT / REJECTED
(nothing written yet)
"Import N staff" (enabled only when no row
 is CONFLICT or REJECTED) ───────────────────▶ same call, dryRun: false, Idempotency-Key
                                               one transaction: every row or none
show result  ◀──────────────────────────────── {created: N, unchanged: M}
```

**The spreadsheet is read in the browser, not on the server.**
- The server never parses an uploaded binary file. Spreadsheet parsers are a common attack surface, and this keeps that risk off the server holding staff data.
- The server needs no new dependency.
- The file is never stored. Only the JSON rows travel, over the existing authenticated API.

The parser is loaded only on the import screen, so the main bundle budget (200 KB gz) is unaffected. The candidate is `read-excel-file` (MIT); the choice is confirmed when building.

**The server repeats every check.** The browser's checks and the template's Check column are conveniences only.

## 4. API

`POST /api/v1/employees/import`

| | |
|---|---|
| Body | `{ templateVersion: 3, dryRun: boolean = true, rows: Row[1..1000] }`. `Row` is the 22 columns as text or ISO dates plus `rowNumber` (the spreadsheet row, for messages). Strict: unknown fields refused. Route body limit 2 MB (the global limit is 1 MB). |
| Permission | The same as onboarding: **HR_ADMIN or SYSTEM_ADMIN**. Every row's unit must be in the caller's scope. A row with no unit (Unassigned) needs system-wide scope, as in onboarding. A Supervisor, Nursing Admin or Nursing Director cannot import. |
| Dry run | Writes nothing. Returns the report. |
| Commit | Requires `Idempotency-Key`. A repeated key replays the stored result and writes nothing again. **All or nothing**: it re-checks every row inside one transaction, and if any row is not CREATE or UNCHANGED it writes nothing and returns `409 STAFF_IMPORT_NOT_CLEAN` with the report. |
| Response | `{ dryRun, totals: {create, unchanged, conflict, rejected}, rows: [{rowNumber, jobNumber, status, problems: [{column, code, message}]}], canImport }` |

**Per-row status:**
- **CREATE**: a new job number and every check passes.
- **UNCHANGED**: the job number exists and every imported field already holds the same value, so re-importing the same file is safe and changes nothing.
- **CONFLICT**: the job number exists with different values. The import **never overwrites**; HR changes that person in the application. The report names the differing columns without echoing the stored values.
- **REJECTED**: the row fails a rule. It reuses the onboarding error codes: `NATIONALITY_INVALID`, `RANK_GRADE_INACTIVE`, `CITY_NOT_IN_REGION`, `FACILITY_INACTIVE`, `CONTRACT_DATES_INVALID`, `POSITION_REQUIRED`, `SCOPE_NOT_COVERED`, and so on. It adds `DUPLICATE_IN_FILE` (the same job number twice in the file) and `VALUE_NOT_LISTED` (a list value that matches nothing, for example a facility renamed since the file was made).

**Personal data in the response.** The report holds row numbers, job numbers and error codes only: no names, e-mails or phones. The idempotency store keeps the response (`IdempotencyKey.responseBody` must hold no personal data), and the request log already keeps only a keyed hash of the body.

## 5. Server design

- **One code path with onboarding.** Move the body of `onboard()` (`backend/src/modules/nurses/service.ts`) into `onboardInTx(tx, auth, input, requestId)`. Onboarding and the import both call it, so the import can never drift from the onboarding rules: position default E6, job number E1, nationality, rank, specialty, job post, facility, contract type, scope, Hijri conversion, eligibility refresh (L6).
- **Resolve, then validate.** Code-before-dash and `(XXX)` parsing, city name → id within the region, and facility name → id happen first. The result is then checked against the existing `OnboardBody` schema, so the field rules are not written twice.
- **One transaction for the commit.** It holds an advisory lock `employees:import` so two imports cannot interleave, and a timeout of 120 s (the same allowance as the baseline import). It must be measured with 1,000 rows (§8). If it is too slow, the fallback is batching the eligibility refresh, not splitting the transaction.
- **Audit.** Each person gets the usual `EMPLOYEE_ONBOARDED` entry (HIGH). The batch gets one `STAFF_IMPORTED` entry (HIGH) with the counts, the template version, the file's SHA-256 (computed in the browser) and the importer. This answers "who loaded these people, and from which file" without storing the file.

## 6. Screen

Under **Nurses** (HR and System Admin only): **Import staff**.

1. **Choose file.** It downloads nothing and stores nothing. It shows the template version found and the number of filled rows. A wrong file (version 2 with Salary, missing or renamed columns, over 1,000 rows, over 5 MB) is stopped here with one clear message.
2. **Check (dry run).** It shows the totals and a table of rows, filterable by status, with the reason for each problem in plain words and the spreadsheet row number. **Download problems as CSV** gives row number, job number, column and message, with no other personal data.
3. **Import.** The button is enabled only when there are no CONFLICT or REJECTED rows and at least one CREATE. A confirmation step says: "This creates N employees and N Draft contracts. Each contract still needs a second administrator's approval."
4. **Done.** It shows the counts and links to the Draft contracts waiting for submission.

English and Arabic, keyboard accessible, and covered by the axe scan like every other page.

## 7. Limits and rules (summary)

| | |
|---|---|
| Rows per file | 1,000 (the template has exactly 1,000) |
| File size | 5 MB in the browser; request body 2 MB on the server |
| Who | HR_ADMIN or SYSTEM_ADMIN, unit scope per row |
| Overwrites | never (CONFLICT instead) |
| Partial import | never (all or nothing) |
| Contracts | always Draft; four-eyes approval unchanged (D-30) |
| Salary, ID numbers, licences, documents | not imported |
| File stored | no; only its SHA-256 in the audit entry |

## 8. Tests (to be written with the build)

**Backend:**
- A dry run writes nothing.
- A commit creates N employees, N Draft contracts, N `EMPLOYEE_ONBOARDED` entries and 1 `STAFF_IMPORTED` entry.
- A repeated Idempotency-Key replays the result and writes nothing again.
- Re-importing the same file returns only UNCHANGED rows.
- An existing job number with a different value is CONFLICT, and nothing is overwritten.
- A duplicate job number in the file, a city outside its region, an inactive rank and end before start are each REJECTED.
- Rows outside the caller's unit scope are REJECTED, and an Unassigned row needs system-wide scope.
- A Supervisor, Nursing Admin or Nursing Director gets 403.
- One bad row makes the commit write nothing (`409 STAFF_IMPORT_NOT_CLEAN`).
- 1,000 rows complete within the timeout (timed in CI).
- The response holds no names, e-mails or phones.

**Frontend:**
- Header and version recognition, including version 2 refused because of Salary.
- Code parsing: `CODE — Name`, `Name (XXX)`, Excel dates, empty rows skipped.
- The import button stays disabled while any row is not clean.

**End to end:** the smoke test imports the template's fictional example row in Chromium, Firefox and WebKit.

## 9. Documentation to update with the build

- `docs/API.md`: the new route.
- `docs/RBAC.md`: who may import.
- `V04_ARCHITECTURE_PLAN.md`: decision D-72.
- `CHANGELOG.md`.
- The in-app guide and the regenerated user manual: a new HR procedure, "Import staff from the template".
- The template's Instructions sheet: "how to import".

## 10. Open points for the hospital

1. **Approval of the batch.** As proposed, an HR Admin imports directly, and each Draft contract still needs a second administrator. The alternative is to send the whole batch for a second person's approval first, as the baseline import does. That is safer for 1,000 records, but slower.
2. **Lists drift.** Version 3 carries the lists as they were on 5 October 2026. A value renamed or deactivated in the application since then is REJECTED (`VALUE_NOT_LISTED`). Should the application also offer **Download the current template**, generated from the live lists? That is recommended, and is a separate small piece of work.
3. **Updating existing staff.** As proposed, the import only creates people. Changes to existing staff stay in the application, one person at a time, with a reason and an audit entry. Bulk updates would be a separate decision.
