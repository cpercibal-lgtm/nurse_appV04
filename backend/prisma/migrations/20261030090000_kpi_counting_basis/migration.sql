-- Nurse-to-bed KPIs: what is counted, per the MoH Ada'a indicator profiles the owner supplied on
-- 2026-10-07 (docs/reference/MOH_ADAA_NURSE_TO_BED_KPI.md). Three settings that HR keeps on screen:
--   positions.counts_as_nurse   holders count as nurses (the cards count nurses only, not technicians
--                               or care assistants)
--   units.patient_care_area     nurses rostered here count towards hospital-wide KPI B (the cards
--                               exclude non-patient-care areas)
--   units.inpatient_beds        this unit's beds are the KPI B denominator (hospital operational beds)
--
-- Starting values approved by the owner on 2026-10-07. Rows that do not exist are skipped; a new
-- installation gets the same values from the baseline file. Each value set here gets a
-- POSITION_UPDATED / UNIT_UPDATED audit entry (actor = system) with the value before and after.

-- AlterTable
ALTER TABLE "positions" ADD COLUMN "counts_as_nurse" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "units" ADD COLUMN "inpatient_beds" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "patient_care_area" BOOLEAN NOT NULL DEFAULT true;

-- Licensed nurses on the roster. HD and AHN are deprecated Head Nurse codes kept for history.
-- Not counted: ECG, OT, TEC, PCT, HCA (not nurses); NS (hospital-wide, not one unit's patients);
-- NURSE_EDUCATOR, QMPS (not direct care); DON, DEPUTY_DON, ADMIN; CI; AN until its holders'
-- SCFHS nursing licence is confirmed.
WITH changed AS (
  UPDATE "positions" SET "counts_as_nurse" = true, "updated_at" = now()
  WHERE "code" IN ('SN', 'CN', 'ICN', 'PN', 'SN_ANES', 'MW', 'CH', 'PRACTITIONER', 'HN', 'ACTING_HEAD', 'HD', 'AHN')
  RETURNING "code"
)
SELECT fn_append_audit_entry(
  NULL, 'POSITION_UPDATED', 'position', c."code",
  jsonb_build_object('before', jsonb_build_object('countsAsNurse', false), 'after', jsonb_build_object('countsAsNurse', true),
                     'source', 'Owner approval 2026-10-07 (MoH Ada''a nurse-to-bed indicator profiles)',
                     'migration', '20261030090000_kpi_counting_basis'))
FROM (SELECT "code" FROM changed ORDER BY "code") c;

-- Not patient care: the coordinator posts, the corporate units and the laboratory.
WITH changed AS (
  UPDATE "units" SET "patient_care_area" = false, "updated_at" = now()
  WHERE "code" IN ('ER_COORD', 'OR_COORD', 'LAB', 'NURS_ADMIN', 'HR', 'IC', 'PAT_EXP', 'PAT_AFFAIRS', 'ACADEMIC',
                   'BIZ_CENTER', 'IDARA', 'STORE', 'HOME_CARE')
  RETURNING "id", "code"
)
SELECT fn_append_audit_entry(
  NULL, 'UNIT_UPDATED', 'unit', c."id"::text,
  jsonb_build_object('before', jsonb_build_object('patientCareArea', true), 'after', jsonb_build_object('patientCareArea', false),
                     'source', 'Owner approval 2026-10-07 (MoH Ada''a nurse-to-bed indicator profiles)',
                     'migration', '20261030090000_kpi_counting_basis'))
FROM (SELECT * FROM changed ORDER BY "code") c;

-- Inpatient beds: the hospital's active-bed list without Day Surgery (5A, Cluster) and Day Care,
-- which the hospital also subtracts (286 beds with the 2026-10-07 counts). The hospital reports
-- 358 operational beds; the units holding the other 72 are still to be named, and HR switches them on.
WITH changed AS (
  UPDATE "units" SET "inpatient_beds" = true, "updated_at" = now()
  WHERE "code" IN ('WARD_3A', 'WARD_3B', 'WARD_4A', 'WARD_4B', 'WARD_5B', 'PEDIA', 'OBGYNE', 'SCABU', 'ASU',
                   'ICU_MAIN', 'PICU', 'NICU', 'CCU', 'BURN_ICU', 'REHAB', 'JAIL')
  RETURNING "id", "code"
)
SELECT fn_append_audit_entry(
  NULL, 'UNIT_UPDATED', 'unit', c."id"::text,
  jsonb_build_object('before', jsonb_build_object('inpatientBeds', false), 'after', jsonb_build_object('inpatientBeds', true),
                     'source', 'Owner approval 2026-10-07 (MoH Ada''a nurse-to-bed indicator profiles)',
                     'migration', '20261030090000_kpi_counting_basis'))
FROM (SELECT * FROM changed ORDER BY "code") c;
