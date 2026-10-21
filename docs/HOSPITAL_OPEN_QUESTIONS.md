# Questions for the hospital

Items the nurse workforce system cannot settle by itself. Each one needs a decision or a fact from the hospital. Until it is answered, the system uses the **"for now"** value, which is shown so nobody mistakes it for a hospital policy. Please write the answer in the last column and return the page to IT.

Prepared 2026-10-08. Sources: the MoH Ada'a indicator cards, the August and September 2026 rosters, the hospital's active-bed list, and the live-server checks.

## A. Needed for the KPI figures (Nurse to Bed Ratio, QFR-55)

| # | Question | Why it matters | For now | Answer |
|---|---|---|---|---|
| A1 | The hospital reports **358 operational beds**; the system counts **286** (16 inpatient units). **Which units hold the other 72 beds?** | The hospital-wide ratio (QFR-55) divides nurses by operational beds. With 72 beds missing, the ratio looks better than it is. | 286 beds | |
| A2 | The active-bed list adds up to **335**. The sheet shows 330 − 44 − 5 = **281**, while 335 − 44 − 5 = **286**. The 5-bed gap equals Day Care's 5 beds. **Was Day Care subtracted twice? Is the figure 281 or 286?** | A difference of 5 beds changes every hospital-wide ratio. | 286 | |
| A3 | **ICU Extension (28 beds):** is it staffed and open, or overflow only? It is not on the active-bed list. | If it is not staffed, its beds should be 0; otherwise the ICU ratio is understated by 28 beds. | 28 beds counted in the ICU area | |
| A4 | **Assistant Nurse (AN):** do its holders have an SCFHS **nursing** licence? | Only nurses with a nursing licence count as "nurses" on the cards. | AN is **not counted** as a nurse | |
| A5 | **ED_ADMIN:** is the name "ED Admission" or "ED Admin" (clerical)? Does it have patient beds? | Decides whether it is a patient-care area (KPI B). | Patient-care area, 7 beds | |
| A6 | **Position QMPS** (Quality Management & Patient Safety Nurse): does it count as a bedside nurse? Is it rostered on shifts? | Counted as a nurse, or not, in the ratio. | Not counted | |

## B. Names and titles that appear in the rosters or unit list

| # | Question | For now | Answer |
|---|---|---|---|
| B1 | **AKU**: what does the name stand for? The system says "Allergy and Kidney Unit". | "Allergy and Kidney Unit", 14 beds | |
| B2 | **RRT**: what does the name stand for? The system says "Respiratory Rehab". | "Respiratory Rehab", 5 beds | |
| B3 | Official English and Arabic titles for **ECG**, **QMPS** and **SN_ANES** (roster spelling "SN ANES"). | "Electrocardiography Technician", "Quality Management & Patient Safety Nurse", "Staff Nurse – Anaesthesia" | |
| B4 | Which unit does the **Non-Invasive Laboratory** belong to? | Not assigned | |
| B5 | What is the **home unit** of the Nursing Supervisor group? | Not assigned | |
| B6 | Should other units sit **under OPD**? Which? | OPD / Dental only | |
| B7 | What do the position codes **AHN** and **CI** stand for, and are they still used? | AHN is deprecated (replaced by Acting Head); CI unchanged | |

## C. Rostering and staff rules we have not been given

The system will not invent these. Please tell us what the hospital's rule is, or that there is none.

| # | Question | Answer |
|---|---|---|
| C1 | **Credential requirements per position:** which credentials (SCFHS licence, BLS, ACLS, etc.) does each position need? Today the rules are per unit, not per position. | |
| C2 | **Floating and rotation:** may a nurse work in another unit than their home unit? Under what limits? Today a nurse is rostered only in their home unit. | |
| C3 | **Leave:** how are annual, sick and other leave recorded, and who approves it? | |
| C4 | **On-call:** is on-call part of the roster? How is it paid or counted? | |
| C5 | The **duty-code legend** used on the paper roster (what each code means). | |
| C6 | The **roster approval chain:** who prepares, who approves, who publishes? Today the supervisor publishes. | |

## D. Network (login protection)

| # | Question | Why it matters | Answer |
|---|---|---|---|
| D1 | Do **all staff reach the system from one public internet address** (a shared hospital connection)? What is that address or range? | The system pauses sign-in after **20 failed attempts per address in 15 minutes**. If everyone shares one address, a handful of mistyped passwords at shift change could block the whole hospital. If so, we raise the limit for that range and rely on the per-account limit (5 attempts). | |

## E. Needed before go-live

Requested 2026-10-17. Each one waits on the hospital or a supplier, not on the software, and some take weeks, so they should start now. Please answer each with the facts asked for (a name, a date, a document), not "Yes".

| # | Who | What we need | Why it matters | Answer |
|---|---|---|---|---|
| E1 | Owner, IT | **The server.** The provider's name, the data centre's city, and the contract clause that says the server, its backups and its snapshots stay in the Kingdom. Also an S3-compatible storage bucket in the Kingdom for the off-site backup copy. Size: 4 vCPU, 16 GB RAM, 200 GB disk, Ubuntu 24.04 ([IT_HANDOVER.md A1](IT_HANDOVER.md#a1-choose-and-contract-the-server-owner-it)). | Staff personal data may only be stored in the Kingdom. Nothing can go live without this server. | |
| E2 | Director of Nursing | **Credential rules (C1, U2), signed.** For each position: which credentials it needs (SCFHS licence, BLS, ACLS, …), whether each is required or optional, and how many days a nurse may keep working after one expires. | The system decides who may be rostered from these rules. Today they are placeholders, not hospital policy, so on day one it could block nurses who are allowed to work, or clear nurses who are not. | |
| E3 | Owner | **SCFHS agreement (U3).** Who at the hospital is applying, the date the request went to SCFHS, and, when SCFHS gives it, their API documentation. | Live licence checks need it. Until it is signed, licences are checked by hand on the SCFHS website and recorded in the app (D-74); the live server looks up none with SCFHS (`SCFHS_DRIVER` unset = `off`, D-75), because the simulated registry used for demonstrations would report every real licence as "not found". | |
| E4 | IT | **Badge system.** The vendor and product name and a contact. Can it send clock-ins over HTTPS in our format ([API.md §2.10](API.md#210-attendance-modulesattendance--implemented-in-commit-8-read-side), `POST /api/v1/attendance/events`)? If not, what can it give: a file export, a database view, or its own API? | Missed-shift alerts compare the roster with clock-ins. Without them those screens stay empty; everything else works. The answer decides whether connecting it is a setting or a small piece of software (B-15). | |
| E5 | IT, with a hospital account | **Telegram bot.** Create it with @BotFather from a hospital-owned account (not a person's), give the token to IT by hand or a password manager (never e-mail), and have the CEO and the IT Director each start a chat with the bot ([DEPLOYMENT.md §2.3](DEPLOYMENT.md#23-telegram-replaces-sms)). | Telegram replaces SMS for alerts, including the alert when the emergency (break-glass) account signs in. Without a bot, alerts stay inside the system. About 10 minutes. | |

If E3 (SCFHS) or E4 (badge system) is not ready at go-live, the Owner can accept it in writing as "not connected at launch" ([DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md#before-you-start-what-is-still-open)); it is connected after go-live. E1 and E2 cannot be accepted that way.

## How answers are used

- **A and B:** HR changes them in Workforce (beds, units, positions, flags); no software release is needed.
- **C:** each answer becomes a written rule and a change to the system. Until then the feature stays as it is.
- **D:** a setting change by IT.
- **E:** E1 and E5 are set up by IT ([IT_HANDOVER.md](IT_HANDOVER.md)); E2 is entered by HR in Credentials → Requirements; E3 needs a small piece of software once SCFHS's API documentation arrives; E4 needs one only if the badge system cannot send our format.

## Replies received 2026-10-14

Returned by Zemonette Pantig Magtalas (Nursing Admin / Administrator), signed 2026-10-14. The Director of Nursing has not signed, so the credential and position rules (U2) are still open.

### Answered

| # | Answer | Effect |
|---|---|---|
| A6 | **QMPS is not a bedside nurse.** (The returned file showed "No"; the hospital contact first said "Yes", then confirmed QMPS is not a bedside nurse.) | Matches the "for now" value (not counted in the Nurse to Bed Ratio, QFR-55). No change to the QMPS position flag in Workforce. |
| C3 | **Nursing Director** approves leave. | How leave is recorded was not answered. |
| C6 | **Nursing Director** approves; **Nursing Admin** prepares; **Nursing Admin and Supervisors** publish. | Differs from today, where the supervisor publishes. Needs a written rule and a system change (a Nursing Admin who prepares and publishes, and a Nursing Director approval step). **Built since** (D-71, roster approval chain). |
| D1 | Staff use their **mobile internet**, so there is no single hospital address or range. | There is nothing to allowlist. Mobile carriers can put unrelated users behind one address, so the 20-failures-per-15-minutes limit per address can lock out unrelated staff. The per-account limit (5 attempts) still protects each login. The setting is `LOGIN_THROTTLE_MAX_PER_CLIENT` (default 20); the recommended value is **100**, set by IT in `/etc/nurseapp/app.env` (see `ops/vps/README.md`). |

### Not answered

The form was marked "Yes" against questions that cannot be answered with yes or no. These stay open and the "for now" values stay in force: A1 to A5, B1 to B7, C1 and C2.

Partial answers:
- **C4:** "Yes, Yes". On-call is part of the roster and is paid or counted, but the rule was not given.
- **C5:** "Removed it". Unclear whether the legend was removed from the paper roster or the request was dropped. The duty-code meanings are still missing.
