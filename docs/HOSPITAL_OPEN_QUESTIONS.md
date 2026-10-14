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

## How answers are used

- **A and B:** HR changes them in Workforce (beds, units, positions, flags); no software release is needed.
- **C:** each answer becomes a written rule and a change to the system. Until then the feature stays as it is.
- **D:** a setting change by IT.

## Replies received 2026-10-14

Returned by Zemonette Pantig Magtalas (Nursing Admin / Administrator), signed 2026-10-14. The Director of Nursing has not signed, so the credential and position rules (U2) are still open.

### Answered

| # | Answer | Effect |
|---|---|---|
| A6 | **Yes.** Read as: QMPS counts as a bedside nurse and is rostered on shifts. (The returned file showed "No"; the hospital contact corrected it to "Yes".) | The "for now" value ("not counted") no longer holds. HR sets the QMPS position flag in Workforce; no release is needed. The Nurse to Bed Ratio (QFR-55) rises slightly, so confirm the intent before changing the flag. |
| C3 | **Nursing Director** approves leave. | How leave is recorded was not answered. |
| C6 | **Nursing Director** approves; **Nursing Admin** prepares; **Nursing Admin and Supervisors** publish. | Differs from today, where the supervisor publishes. Needs a written rule and a system change (a Nursing Admin who prepares and publishes, and a Nursing Director approval step). Not built yet. |
| D1 | Staff use their **mobile internet**, so there is no single hospital address or range. | There is nothing to allowlist. Mobile carriers can put unrelated users behind one address, so the 20-failures-per-15-minutes limit per address can lock out unrelated staff. The per-account limit (5 attempts) still protects each login. Proposed: IT raises the per-address limit; the new value is not yet chosen. |

### Not answered

The form was marked "Yes" against questions that cannot be answered with yes or no. These stay open and the "for now" values stay in force: A1 to A5, B1 to B7, C1 and C2.

Partial answers:
- **C4:** "Yes, Yes". On-call is part of the roster and is paid or counted, but the rule was not given.
- **C5:** "Removed it". Unclear whether the legend was removed from the paper roster or the request was dropped. The duty-code meanings are still missing.
