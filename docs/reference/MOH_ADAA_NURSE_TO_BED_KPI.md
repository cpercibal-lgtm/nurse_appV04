# MoH Ada'a — nurse-to-bed indicator profiles

**Source:** two MoH Ada'a "Indicator Profile" cards (Ministry of Health, Ada'a Health), supplied by the owner on 2026-10-07 as screenshots. They settle decision D-11 (the thresholds were "not in the repository") and are the basis of D-70. This page records what the cards say and how the app reads them.

## A. Nurse to Bed Ratio (Critical Areas)

| Item | Card |
|---|---|
| Oversight theme | Quality Failure Regime |
| Description | Average ratio of nurses to beds in three areas (ER, OR, ICU): enough staff for patient needs, safe care, manageable workloads |
| Category / owner | Workforce Management / Deputyship for Therapeutic Services (MoH) |
| Range | Health care provider clusters and facilities |
| Unit / data source | Ratio / health facilities (Ada'a Health Dashboard), electronic system |
| Collection and reporting | Monthly |
| Formula | Average nurses on duty (ICU, ER, OR) / operational beds (ICU, ER, OR) × 100. **Each of the three areas is calculated separately** and coded on a 1–4 scale; the final score is the **average of the three codes**: 1–1.5 Standard, 1.5–2.5 Distress, 2.5–3.5 Failing, 3.5–4 Failed |
| Numerator | Average of nurses on duty. Includes nurses currently employed and in the shift schedule, nurses in ICU, ER and OR. Excludes nurses in non-patient-care areas, nurses not on the shift schedule, nurses in non-critical areas |
| Denominator | Number of operational beds. Includes all active beds; excludes non-active beds |
| Target | ≥ 1:1 (ICU), ≥ 1:2 (ER), ≥ 2:1 (OR) · polarity positive |

| Level | ICU | ER | OR |
|---|---|---|---|
| Standard (code 1) | ≥ 1:1 | ≥ 1:2 | ≥ 2:1 |
| Distress (code 2) | 1:2 | 1:3 | 1:1 |
| Failing (code 3) | 1:3 | 1:4 | 1:2 |
| Failed (code 4) | 1:4 or worse | 1:5 or worse | 1:3 or worse |

## B. Hospital's Nurse to Bed Ratio (Hospital-Wide) — QFR-55

| Item | Card |
|---|---|
| Oversight theme | Quality Failure Regime |
| Description | Average number of nursing staff per operational hospital bed over the reporting period: staffing adequacy, workload, workforce planning |
| Category / owner, range, source | As card A |
| Collection and reporting | Monthly |
| Formula | (Average nurses on duty / operational beds × 100) × 100 — the doubled "× 100" appears on the card; the levels are ratios, which is what the app shows |
| Numerator | Average of nurses on duty. Includes nurses currently employed and in the shift schedule. Excludes nurses in non-patient-care areas and nurses not on the shift schedule |
| Denominator | Number of operational beds. Includes all active beds; excludes non-active beds |
| Target | 1:<6 · polarity positive |

| Level | Beds per nurse |
|---|---|
| Standard | 1:<6 |
| Distress | 1:≥6 to 1:<7 |
| Failing | 1:≥7 to 1:≤9 |
| Failed | 1:>9 |

## How the app reads the cards (D-70)

| Card term | In the app |
|---|---|
| Nurses | Holders of a position with **Nurse (KPI)** on (`positions.counts_as_nurse`). Owner 2026-10-07: SN, CN, ICN, PN, SN_ANES, MW, CH, PRACTITIONER, HN, ACTING_HEAD (and the deprecated HD, AHN). Not counted: ECG, OT, TEC, PCT, HCA, NS, NURSE_EDUCATOR, QMPS, DON, DEPUTY_DON, ADMIN, CI, and **AN until its holders' SCFHS nursing licence is confirmed** |
| On duty, in the shift schedule | Published roster assignments (drafts and cancelled shifts do not count) |
| Average of nurses on duty | Nurses on duty per shift, averaged over the period: one shift, or every shift (3 a day) of a month — the month so far while it runs |
| ICU / ER / OR | The unit's **KPI critical area** (`units.critical_area`): ICU = ICU Main, ICU Extension, NICU, PICU, CCU, Burn ICU; ER = ER Main, ER M&C, UCC, CDU; OR = OR. HDU, ASU, SCABU and PACU are not critical areas |
| Non-patient-care areas (KPI B) | Units with **Patient-care area** off (`units.patient_care_area`): ER_COORD, OR_COORD, LAB and the ten Corporate units. `ED_ADMIN` stays a patient-care area (to confirm: "ED Admission"?) |
| Operational beds (KPI B) | Units with **Inpatient beds** on (`units.inpatient_beds`): the hospital's active-bed list without Day Surgery (5A, Cluster) and Day Care — 3A, 3B, 4A, 4B, 5B, Pediatric, OB/GYN, SCABU, ASU, ICU Main, PICU, NICU, CCU, Burn ICU, Rehab, Jail = 286 beds. The hospital reports 358 operational beds; the units holding the other 72 are to be named by the hospital and switched on by HR |
| Operational beds (KPI A) | The bed counts of the area's active units |
| Between two levels | A ratio between two of the card's levels takes the nearer one (ICU cut-lines 1:1.5, 1:2.5, 1:3.5; ER 1:2.5, 1:3.5, 1:4.5; OR 1.5:1, 0.75:1, 0.417:1). A final score of exactly 1.5, 2.5 or 3.5 takes the better band |
| Beds over a month | The current bed counts (a bed change during the month is not prorated) |

**Open with the hospital:** whether ICU Extension's 28 beds are staffed (it is not on the hospital's active-bed list; if not, set its beds to 0); the units behind the 72 beds; the AN licence; ED_ADMIN's name.
