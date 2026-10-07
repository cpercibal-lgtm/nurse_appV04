-- Positions from the August and September 2026 roster extraction (AIGH_Position_Reference.md)
-- that were not in the position list (owner, 2026-10-07). The hospital has not yet confirmed what
-- these codes mean: the titles are provisional, each description says where the code was seen and
-- what is unconfirmed, and HR corrects them in Workforce -> Positions. All schedulable and active.
--   ECG: Electrocardiography Technician
--   QMPS: Quality Management & Patient Safety Nurse
--   SN_ANES: Staff Nurse – Anaesthesia
--   ICN: Intensive Care Nurse (provisional)
--   OT: Orthopaedic Plaster Technician (provisional)
--   AN: Assistant Nurse (provisional)
--   PN: Practical Nurse (provisional)
--   HD: HD – title to be confirmed
--   CH: CH – title to be confirmed
--
-- Only a database whose positions have been loaded (the hospital baseline import) gets them; on an
-- empty database (a new installation, the tests) the baseline file, which has the same rows, creates
-- them in the four-eyes import. A position that already exists is left as it is (ON CONFLICT DO
-- NOTHING). Each added position gets a POSITION_CREATED audit entry (actor = system), as on screen.
-- HHC and SOP from the same roster are contract types, not positions; AHN and CI stay as they are.

WITH roster ("code", "title", "title_ar", "tier", "description", "display_order") AS (VALUES
  ('ECG', 'Electrocardiography Technician', 'فني تخطيط القلب', 'Support', 'Roster code ECG (Emergency Department). Title not yet confirmed. Confirm with the hospital and correct it in Workforce -> Positions.', 15),
  ('QMPS', 'Quality Management & Patient Safety Nurse', 'ممرض الجودة وسلامة المرضى', 'Specialist', 'Roster code QMPS (Nursing Administration). The function is Quality Management and Patient Safety; the title (nurse or coordinator) is to be confirmed. Confirm with the hospital and correct it in Workforce -> Positions.', 16),
  ('SN_ANES', 'Staff Nurse – Anaesthesia', 'ممرض التخدير', 'Clinical', 'Roster code "SN ANES" (Intensive Care Unit). Title not yet confirmed. Confirm with the hospital and correct it in Workforce -> Positions.', 17),
  ('ICN', 'Intensive Care Nurse (provisional)', 'ممرض العناية المركزة (مؤقت)', 'Clinical', 'Roster code ICN (Intensive Care Unit). Provisional: it may instead mean Infection Control Nurse. Confirm with the hospital and correct it in Workforce -> Positions.', 18),
  ('OT', 'Orthopaedic Plaster Technician (provisional)', 'فني جبائر العظام (مؤقت)', 'Support', 'Roster code OT (Plaster Unit). Provisional: meaning not confirmed by the roster. Confirm with the hospital and correct it in Workforce -> Positions.', 19),
  ('AN', 'Assistant Nurse (provisional)', 'ممرض مساعد (مؤقت)', 'Support', 'Roster code AN (Diabetic Center, Outpatient Department). Provisional: meaning not confirmed by the roster. Confirm with the hospital and correct it in Workforce -> Positions.', 20),
  ('PN', 'Practical Nurse (provisional)', 'ممرض عملي (مؤقت)', 'Clinical', 'Roster code PN (Intensive Care Unit). Provisional: meaning not confirmed by the roster. Confirm with the hospital and correct it in Workforce -> Positions.', 21),
  ('HD', 'HD – title to be confirmed', 'HD – المسمى قيد التأكيد', 'Support', 'Roster code HD (Plaster Unit). Meaning unknown: temporary title. Confirm with the hospital and correct it in Workforce -> Positions.', 22),
  ('CH', 'CH – title to be confirmed', 'CH – المسمى قيد التأكيد', 'Clinical', 'Roster code CH (Diabetic Center, Rapid Response Team). Meaning unknown: temporary title. Confirm with the hospital and correct it in Workforce -> Positions.', 23)
), added AS (
  INSERT INTO "positions" ("code", "title", "title_ar", "tier", "description", "is_schedulable", "is_active", "display_order", "updated_at")
  SELECT r."code", r."title", r."title_ar", r."tier", r."description", true, true, r."display_order", now()
  FROM roster r
  WHERE EXISTS (SELECT 1 FROM "positions")
  ON CONFLICT ("code") DO NOTHING
  RETURNING "code", "title", "title_ar", "tier", "description", "display_order"
)
SELECT fn_append_audit_entry(
  NULL, 'POSITION_CREATED', 'position', a."code",
  jsonb_build_object(
    'code', a."code", 'title', a."title", 'titleAr', a."title_ar", 'tier', a."tier",
    'description', a."description", 'isSchedulable', true, 'displayOrder', a."display_order",
    'source', 'AIGH_Position_Reference.md (roster August-September 2026); titles provisional',
    'migration', '20261027090000_roster_positions'))
FROM (SELECT * FROM added ORDER BY "display_order") a;
