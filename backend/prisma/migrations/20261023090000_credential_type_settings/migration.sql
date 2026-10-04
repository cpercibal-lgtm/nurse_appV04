-- Credential type settings from the hospital's credential requirements matrix
-- (AIGH_Credential_Requirements_Matrix.xlsx, sheet "Credential types"; owner, 2026-10-04).
--
-- Grace days after expiry while a renewal is in progress (0 = none). NATIONAL_ID is not in
-- the matrix and keeps 0 until HR sets it. CLEARANCE does not expire, so it keeps 0.
--
-- SCFHS checks: only a type with a field holding the SCFHS registration number can be checked
-- (D-64, catalog.ts assertScfhsRules), which is the SCFHS licence. It is checked and suspended
-- at once when SCFHS reports it suspended or revoked; every other type stays unchecked.
--
-- Only types with these codes are touched. Eligibility follows: the 00:05 daily transition
-- re-evaluates every nurse (jobs/daily-transition.ts, step 5).

UPDATE "credential_templates" AS t SET "grace_period_days" = v."grace"
FROM (VALUES
  ('PASSPORT', 90),
  ('IQAMA', 30),
  ('HOSPITAL_ID', 30),
  ('PROF_LICENSE', 60),
  ('SCFHS', 60),
  ('EMP_CONTRACT', 0),
  ('MALPRACTICE', 60),
  ('CLEARANCE', 0),
  ('CORE_COMP', 60),
  ('UNIT_COMP', 60),
  ('SEDATION', 60),
  ('BLS', 60),
  ('ACLS', 60),
  ('PALS', 60),
  ('NRP', 60),
  ('BICSL', 60)
) AS v("code", "grace")
WHERE t."code" = v."code";

UPDATE "credential_templates" AS t SET "scfhs_enabled" = TRUE, "scfhs_auto_suspend" = TRUE
WHERE t."code" = 'SCFHS'
  AND EXISTS (SELECT 1 FROM "credential_template_fields" f WHERE f."template_id" = t."id" AND f."pdpl_category" = 'SCFHS_REG');
