# Staff import: design (D-72)

Status: **decided and built**, 14 October 2026 (decision **D-72**). The owner chose: HR imports directly (no batch approval), the application offers **Download the current template**, and the import only creates people (section 10). Where the build differs from the first proposal, this page describes the build.

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
turn rows into plain JSON ───────────────────▶ POST /api/v1/employees/import/check  {rows}
                                               resolve names + validate, per row
show report  ◀──────────────────────────────── CREATE / UNCHANGED / CONFLICT / REJECTED
(nothing written yet)
"Import N staff" (enabled only when no row
 is CONFLICT or REJECTED) ───────────────────▶ POST /api/v1/employees/import, Idempotency-Key
                                               one transaction: every row or none
show result  ◀──────────────────────────────── {created: N, unchanged: M}
```

**The spreadsheet is read in the browser, not on the server.**
- The server never parses an uploaded binary file. Spreadsheet parsers are a common attack surface, and this keeps that risk off the server holding staff data.
- The server needs no new dependency.
- The file is never stored. Only the JSON rows travel, over the existing authenticated API.

The reader is loaded only on the import screen. It is `fflate` (zip, about 8 KB gzipped) plus a small XML reader for the few cell shapes a sheet uses (`frontend/src/modules/nurses/staff-import/xlsx.ts`, with tests on files written by openpyxl and re-saved with shared strings as Excel does). A spreadsheet library was tried first: `exceljs` is about 238 KB gzipped, over the 150 KB per-chunk budget that `scripts/check-bundle-size.mjs` enforces. The browser also turns the list values into codes (`CODE — Name` → `CODE`, `Filipino (PHL)` → `PHL`, Excel dates → `YYYY-MM-DD`); city and facility names are resolved on the server.

**The server repeats every check.** The browser's checks and the template's Check column are conveniences only.

## 4. API

`POST /api/v1/employees/import/check` (writes nothing) and `POST /api/v1/employees/import` (the import). A dry-run flag on one route was the first idea; two routes are needed because the import requires an Idempotency-Key and the check must not.

| | |
|---|---|
| Body | `{ templateVersion: 3, fileSha256, rows: Row[1..1000] }`. `Row` is the 22 columns as text (codes, city and facility names, ISO dates) plus `rowNumber` (the spreadsheet row, for messages). Strict: unknown fields refused, so a `salary` field is a 400. Body limit 3 MB for these two routes (1 MB everywhere else); the web server allows the import 180 s. |
| Permission | The same as onboarding: **HR_ADMIN or SYSTEM_ADMIN**. Every row's unit must be in the caller's scope. A row with no unit (Unassigned) needs system-wide scope, as in onboarding. A Supervisor, Nursing Admin or Nursing Director cannot import. |
| Check | Writes nothing. Returns the report. |
| Commit | Requires `Idempotency-Key`. A repeated key replays the stored result and writes nothing again. **All or nothing**: it re-checks every row inside one transaction, and if any row is not CREATE or UNCHANGED it writes nothing and returns `409 STAFF_IMPORT_NOT_CLEAN` with the report. |
| Response | Check: `{ totals: {create, unchanged, conflict, rejected}, canImport, rows: [{rowNumber, jobNumber, status, problems: [{column, code, message}]}] }`. Import: 201 `{ totals, created: [{rowNumber, employeeId, contractId}], rows }`; 422 `NOTHING_TO_IMPORT` when every row is already there. Also `GET /api/v1/employees/import/lists` for the template download. |

**Per-row status:**
- **CREATE**: a new job number and every check passes.
- **UNCHANGED**: the job number exists and every imported field already holds the same value, so re-importing the same file is safe and changes nothing.
- **CONFLICT**: the job number exists with different values. The import **never overwrites**; HR changes that person in the application. The report names the differing columns without echoing the stored values.
- **REJECTED**: the row fails a rule. It reuses the onboarding error codes: `NATIONALITY_INVALID`, `RANK_GRADE_INACTIVE`, `CITY_NOT_IN_REGION`, `FACILITY_INACTIVE`, `CONTRACT_DATES_INVALID`, `POSITION_REQUIRED`, `SCOPE_NOT_COVERED`, and so on. It adds `DUPLICATE_IN_FILE` (the same job number twice in the file, any case), `VALUE_NOT_LISTED` (a unit, city or facility that matches nothing, for example one renamed since the file was made) and `INVALID_VALUE` (a field rule of onboarding, such as a missing name or an e-mail that is not one). A row lists every field problem at once (missing or malformed values); list values (rank, specialty, contract type and so on) are checked once the fields are valid.

**Personal data in the response.** The report holds row numbers, job numbers and error codes only: no names, e-mails or phones. The idempotency store keeps the response (`IdempotencyKey.responseBody` must hold no personal data), and the request log already keeps only a keyed hash of the body.

## 5. Server design

- **One code path with onboarding.** Move the body of `onboard()` (`backend/src/modules/nurses/service.ts`) into `onboardInTx(tx, auth, input, requestId)`. Onboarding and the import both call it, so the import can never drift from the onboarding rules: position default E6, job number E1, nationality, rank, specialty, job post, facility, contract type, scope, Hijri conversion, eligibility refresh (L6).
- **Resolve, then validate.** Code-before-dash and `(XXX)` parsing, city name → id within the region, and facility name → id happen first. The result is then checked against the existing `OnboardBody` schema, so the field rules are not written twice.
- **One transaction for the commit.** It holds an advisory lock `employees:import` so two imports cannot interleave, and a timeout of 120 s (the same allowance as the baseline import). Measured: 1,000 rows in about 23 s on a development machine (test `imports 1,000 rows in one transaction`). The check runs in memory against master data loaded once, so it stays fast; only the import writes row by row.
- **Audit.** Each person gets the usual `EMPLOYEE_ONBOARDED` entry (HIGH). The batch gets one `STAFF_IMPORTED` entry (HIGH) with the counts, the template version, the file's SHA-256 (computed in the browser) and the importer. This answers "who loaded these people, and from which file" without storing the file.

## 6. Screen

Under **Nurses** (HR and System Admin only): **Import staff**.

0. **Download the current template** (optional, recommended): version 3 with today's lists (section 10).
1. **Choose file.** Nothing is uploaded and nothing is stored: the file is read in the browser. It shows the file name and the number of people found. A wrong file (version 2 with Salary, missing or renamed columns, over 1,000 rows, over 5 MB) is stopped here with one clear message.
2. **Check.** It runs at once. It shows the totals and a table of rows (New, Already there, Conflict, Problem), filterable by status, with the reason for each problem in plain words and the spreadsheet row number. **Download problems as CSV** gives row number, job number, column and message, with no other personal data.
3. **Import.** The button is enabled only when there are no CONFLICT or REJECTED rows and at least one CREATE. A confirmation step says: "This creates N employees and N Draft contracts. Each contract still needs a second administrator's approval."
4. **Done.** It shows the count and the next steps: upload and submit each contract, second-administrator approval, then the registration invitations.

English and Arabic, built from the same Ant Design components as the other screens. The browser smoke test does not open the import drawer yet (section 8).

## 7. Limits and rules (summary)

| | |
|---|---|
| Rows per file | 1,000 (the template has exactly 1,000) |
| File size | 5 MB in the browser; request body 3 MB on the server; the web server allows the import 180 s |
| Who | HR_ADMIN or SYSTEM_ADMIN, unit scope per row |
| Overwrites | never (CONFLICT instead) |
| Partial import | never (all or nothing) |
| Contracts | always Draft; four-eyes approval unchanged (D-30) |
| Salary, ID numbers, licences, documents | not imported |
| File stored | no; only its SHA-256 in the audit entry |

## 8. Tests

**Backend** (`backend/test/staff-import.test.ts`, 8 tests):
- The check writes nothing and reports every row: a duplicate job number in the file (any case), a city outside its region, an unknown facility, a bad e-mail, end before start, and missing required fields (every problem named, by column).
- The response holds no names, e-mails or phones.
- The import creates the employees, their Draft contracts, an `EMPLOYEE_ONBOARDED` entry each and one `STAFF_IMPORTED` entry. A repeated Idempotency-Key replays the result. The same file again reports only *Already there*, and importing it gives `NOTHING_TO_IMPORT`.
- An existing job number with different values is CONFLICT naming the columns (not the values), and nothing is overwritten.
- One bad row makes the import write nothing (`409 STAFF_IMPORT_NOT_CLEAN`, with the report).
- Scope: rows in another unit or Unassigned are refused for a unit-scoped HR Admin. A Supervisor, Nursing Admin and Nursing Director get 403.
- Version 2 (or a `salary` field) and more than 1,000 rows are refused.
- The live lists, with units limited to the caller's scope.
- 1,000 rows in one transaction (about 23 s locally).

**Frontend** (`frontend/src/modules/nurses/staff-import/template.test.ts`, 8 tests):
- Reading a filled file as written by openpyxl and as re-saved with shared strings (the way Excel saves): codes from `CODE — Name` and `Name (CODE)`, Excel dates, numeric job numbers, escaped characters, empty rows skipped.
- Version 2 refused because of Salary; a wrong header names the column; an empty template, a non-`.xlsx` file, more than 1,000 people and files over 5 MB are refused.
- **Download the current template**: the Lists sheet and the drop-down names are rebuilt (new regions included, old values gone), and the Staff sheet with its notes, drop-downs and Check column is byte-for-byte unchanged.

**By hand, in a real browser (Chromium, local)**: download the current template, fill it, upload a file with problems (Import stays disabled, each problem named), upload the corrected file, import 2 people. A generated template was also opened in LibreOffice: its drop-downs use the new lists, and the Check column says OK or names the problem.

**Not yet:** the CI smoke test (Chromium, Firefox, WebKit) does not open the import screen.

## 9. Documentation updated with the build

- `docs/API.md`: the new route.
- `docs/RBAC.md`: who may import.
- `V04_ARCHITECTURE_PLAN.md`: decision D-72.
- `CHANGELOG.md`.
- The in-app guide and the regenerated user manual: a new HR procedure, "Import staff from the template".
- The template's Instructions sheet: "how to import".

## 10. Decisions (owner, 14 October 2026)

1. **Approval of the batch: direct import.** An HR Admin or System Admin imports directly. Each Draft contract still needs a second administrator's approval (D-30), so nobody can be rostered from an import alone.
2. **Download the current template: yes.** The import screen builds the file from version 3 itself. Only its Lists sheet and drop-down ranges are replaced with today's values, so the notes, drop-downs, City-follows-Region and the Check column stay exactly as in the hospital's file. Units are those in the user's scope. The live lists come from `GET /api/v1/employees/import/lists`.
3. **Create only.** Existing staff are never changed by the import: same details → *Already there*; different details → *Conflict*, to be edited in the application one person at a time.
