-- Departments, units and beds (owner decisions, 2026-10-07), from the roster review and the hospital's active-beds list, 2026-10-07.
--
-- 1. Department OPD - Outpatient Department; unit OPD_DENTAL moves into it (from GNSP).
-- 2. Nine units:
--   WARD_3A: Ward 3A – Female Medical (GNSP, 23 beds)
--   WARD_3B: Ward 3B – Male Medical (GNSP, 23 beds)
--   WARD_4A: Ward 4A – Male Surgical (GNSP, 23 beds)
--   WARD_4B: Ward 4B – Female Surgical (GNSP, 23 beds)
--   WARD_5B: Ward 5B – Orthopaedic (GNSP, 23 beds)
--   SCABU: SCABU / Nursery (CRIT, 8 beds)
--   DAY_CARE: Day Care Unit (SURG, 5 beds)
--   DS_CLUSTER: Day Surgery – Cluster (SURG, 21 beds)
--   BLOOD_COLL: Blood Collection Unit (GNSP, 0 beds)
--    The five wards replace INP_WARDS (98 beds), which is deactivated (kept, with its history).
--    SCABU held 8 of NICU's 15 beds; it is special care, not intensive care, so it has no KPI area.
-- 3. BLOOD_BANK is renamed Blood Bank Unit (Blood Collection Unit is a separate unit).
-- 4. Bed counts set to the active beds: PEDIA 15->20, OBGYNE 17->28, ASU 6->8, ICU_MAIN 79->37, PICU 15->8, NICU 15->7, CCU 10->14, BURN_ICU 6->5, REHAB 17->25, JAIL 12->11, DAY_SURG 9->23.
-- 5. Each new unit gets the matrix v4 rules: the 17 credential types Mandatory, every position,
--    no deadline (the decision for every unit, 20261025090000_matrix_v4_requirements).
--
-- Every step is guarded so that what HR has already changed is kept: a unit or department that
-- exists is not created again, a bed count is changed only while it is still the baseline figure,
-- the rename and the move only while the old value is there, and INP_WARDS is deactivated only if
-- no current employee is in it. A database without units (a new installation, the tests) is left
-- alone: the baseline file has the new structure. Each change is audited as on screen (actor =
-- system), bed changes also in the bed-capacity log.

DO $$
DECLARE
  r RECORD;
  v_id INTEGER;
  v_opd INTEGER;
  v_rules INTEGER := 0;
  v_n INTEGER;
  v_units TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "units") THEN
    RETURN;
  END IF;

  -- 1. The Outpatient Department, and OPD / Dental moved into it.
  SELECT "id" INTO v_opd FROM "departments" WHERE "code" = 'OPD';
  IF v_opd IS NULL THEN
    INSERT INTO "departments" ("code", "name", "description", "updated_at")
    VALUES ('OPD', 'Outpatient Department', 'Outpatient clinics', now())
    RETURNING "id" INTO v_opd;
    PERFORM fn_append_audit_entry(NULL, 'DEPARTMENT_CREATED', 'department', v_opd::text,
      jsonb_build_object('code', 'OPD', 'name', 'Outpatient Department', 'description', 'Outpatient clinics', 'migration', '20261029090000_units_restructure'));
  END IF;
  FOR r IN
    SELECT u."id", d."code" AS "dept" FROM "units" u JOIN "departments" d ON d."id" = u."department_id"
    WHERE u."code" = 'OPD_DENTAL' AND d."code" = 'GNSP'
  LOOP
    UPDATE "units" SET "department_id" = v_opd, "updated_at" = now() WHERE "id" = r."id";
    PERFORM fn_append_audit_entry(NULL, 'UNIT_UPDATED', 'unit', r."id"::text,
      jsonb_build_object('before', jsonb_build_object('departmentCode', r."dept"), 'after', jsonb_build_object('departmentCode', 'OPD'),
                         'reason', 'OPD / Dental is a unit of the Outpatient Department', 'migration', '20261029090000_units_restructure'));
  END LOOP;

  -- 2. New units, each with its initial bed log and the matrix rules.
  FOR r IN
    SELECT * FROM (VALUES
      ('WARD_3A', 'Ward 3A – Female Medical', 'Female medical ward (roster 3A)', 'GNSP', 23, NULL::text),
      ('WARD_3B', 'Ward 3B – Male Medical', 'Male medical ward (roster 3B)', 'GNSP', 23, NULL::text),
      ('WARD_4A', 'Ward 4A – Male Surgical', 'Male surgical ward (roster 4A)', 'GNSP', 23, NULL::text),
      ('WARD_4B', 'Ward 4B – Female Surgical', 'Female surgical ward (roster 4B)', 'GNSP', 23, NULL::text),
      ('WARD_5B', 'Ward 5B – Orthopaedic', 'Orthopaedic ward (roster 5B)', 'GNSP', 23, NULL::text),
      ('SCABU', 'SCABU / Nursery', 'Special care baby unit and nursery', 'CRIT', 8, NULL::text),
      ('DAY_CARE', 'Day Care Unit', 'Day care beds', 'SURG', 5, NULL::text),
      ('DS_CLUSTER', 'Day Surgery – Cluster', 'Day surgery beds of the health cluster', 'SURG', 21, NULL::text),
      ('BLOOD_COLL', 'Blood Collection Unit', 'Blood collection', 'GNSP', 0, NULL::text)
    ) AS v ("code", "name", "description", "dept", "beds", "critical_area")
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM "units" WHERE "code" = r."code");
    INSERT INTO "units" ("code", "name", "description", "department_id", "bed_count", "critical_area", "updated_at")
    SELECT r."code", r."name", r."description", d."id", r."beds", r."critical_area"::"CriticalArea", now()
    FROM "departments" d WHERE d."code" = r."dept" AND d."is_active"
    RETURNING "id" INTO v_id;
    CONTINUE WHEN v_id IS NULL;
    INSERT INTO "bed_capacity_logs" ("unit_id", "previous_count", "new_count", "reason")
    VALUES (v_id, 0, r."beds", 'New unit: ' || 'Active beds from the hospital''s active-beds list, 2026-10-07 (owner approval)');
    PERFORM fn_append_audit_entry(NULL, 'UNIT_CREATED', 'unit', v_id::text,
      jsonb_build_object('code', r."code", 'name', r."name", 'description', r."description", 'departmentCode', r."dept",
                         'bedCount', r."beds", 'criticalArea', r."critical_area", 'migration', '20261029090000_units_restructure'));
    INSERT INTO "credential_requirements" ("template_id", "unit_id", "position_code", "policy_status")
    SELECT t."id", v_id, NULL, 'MANDATORY'::"PolicyStatus"
    FROM "credential_templates" t WHERE t."code" IN ('PASSPORT', 'IQAMA', 'NATIONAL_ID', 'HOSPITAL_ID', 'PROF_LICENSE', 'SCFHS', 'EMP_CONTRACT', 'MALPRACTICE', 'CLEARANCE', 'CORE_COMP', 'UNIT_COMP', 'SEDATION', 'BLS', 'ACLS', 'PALS', 'NRP', 'BICSL') AND t."is_active"
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_rules := v_rules + v_n;
    v_units := v_units || r."code";
    v_id := NULL;
  END LOOP;
  IF v_rules > 0 THEN
    PERFORM fn_append_audit_entry(NULL, 'REQUIREMENTS_BULK_SET', 'credential_requirement', NULL,
      jsonb_build_object('created', v_rules, 'updated', 0, 'policyStatus', 'MANDATORY', 'positionCode', NULL, 'units', to_jsonb(v_units),
                         'source', 'Matrix v4 decision (every type Mandatory in every unit) applied to the new units', 'migration', '20261029090000_units_restructure'),
      NULL, 'HIGH');
  END IF;

  -- 3. Blood Bank renamed.
  FOR r IN SELECT "id" FROM "units" WHERE "code" = 'BLOOD_BANK' AND "name" = 'Blood Bank' LOOP
    UPDATE "units" SET "name" = 'Blood Bank Unit', "updated_at" = now() WHERE "id" = r."id";
    PERFORM fn_append_audit_entry(NULL, 'UNIT_UPDATED', 'unit', r."id"::text,
      jsonb_build_object('before', jsonb_build_object('name', 'Blood Bank'), 'after', jsonb_build_object('name', 'Blood Bank Unit'), 'migration', '20261029090000_units_restructure'));
  END LOOP;

  -- 4. Active beds.
  FOR r IN
    SELECT u."id", v."old", v."new" FROM (VALUES
      ('PEDIA', 15, 20),
      ('OBGYNE', 17, 28),
      ('ASU', 6, 8),
      ('ICU_MAIN', 79, 37),
      ('PICU', 15, 8),
      ('NICU', 15, 7),
      ('CCU', 10, 14),
      ('BURN_ICU', 6, 5),
      ('REHAB', 17, 25),
      ('JAIL', 12, 11),
      ('DAY_SURG', 9, 23)
    ) AS v ("code", "old", "new")
    JOIN "units" u ON u."code" = v."code" AND u."bed_count" = v."old"
  LOOP
    UPDATE "units" SET "bed_count" = r."new", "updated_at" = now() WHERE "id" = r."id";
    INSERT INTO "bed_capacity_logs" ("unit_id", "previous_count", "new_count", "reason") VALUES (r."id", r."old", r."new", 'Active beds from the hospital''s active-beds list, 2026-10-07 (owner approval)');
    PERFORM fn_append_audit_entry(NULL, 'BED_CAPACITY_CHANGED', 'unit', r."id"::text,
      jsonb_build_object('previous', r."old", 'next', r."new", 'reason', 'Active beds from the hospital''s active-beds list, 2026-10-07 (owner approval)', 'migration', '20261029090000_units_restructure'));
  END LOOP;

  -- 5. INP_WARDS retired: its five wards are units now.
  FOR r IN
    SELECT u."id" FROM "units" u WHERE u."code" = 'INP_WARDS' AND u."is_active"
      AND NOT EXISTS (SELECT 1 FROM "employees" e WHERE e."unit_id" = u."id" AND e."deleted_at" IS NULL)
  LOOP
    UPDATE "units" SET "is_active" = false, "updated_at" = now() WHERE "id" = r."id";
    PERFORM fn_append_audit_entry(NULL, 'UNIT_UPDATED', 'unit', r."id"::text,
      jsonb_build_object('before', jsonb_build_object('isActive', true), 'after', jsonb_build_object('isActive', false),
                         'reason', 'Replaced by the wards WARD_3A, WARD_3B, WARD_4A, WARD_4B and WARD_5B', 'migration', '20261029090000_units_restructure'));
  END LOOP;
END $$;
