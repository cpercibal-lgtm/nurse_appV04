-- Position titles confirmed by the owner on 2026-10-07 for six of the nine roster positions added by
-- 20261027090000_roster_positions:
--   ICN: Intensive Care Nurse
--   OT: Orthopaedic Plaster Technician
--   AN: Assistant Nurse
--   PN: Practical Nurse
--   CH: Community Health Nurse
--   HD: Head Nurse (inactive, replaced by HN)
-- HD means Head Nurse, which HN already is: HD is deactivated and points to HN (as AHN -> ACTING_HEAD),
-- so the dropdowns show one Head Nurse. ECG, QMPS and SN_ANES are unchanged.
--
-- A row is changed only while it still has the provisional title from that migration, so a title HR
-- has already corrected in Workforce -> Positions is kept; HD is deactivated only if no current
-- employee holds it (the live database has none) and HN exists and is active. Each change gets a POSITION_UPDATED audit entry
-- (actor = system) with the values before and after, as on screen. On an empty database (a new
-- installation, the tests) nothing matches: the baseline file has the confirmed rows.

WITH confirmed ("code", "old_title", "title", "title_ar", "tier", "description", "is_active", "replaced_by", "display_order") AS (VALUES
  ('ICN', 'Intensive Care Nurse (provisional)', 'Intensive Care Nurse', 'ممرض العناية المركزة', 'Clinical', 'Roster code ICN (Intensive Care Unit). Title confirmed by the owner, 2026-10-07.', true, NULL, 18),
  ('OT', 'Orthopaedic Plaster Technician (provisional)', 'Orthopaedic Plaster Technician', 'فني جبائر العظام', 'Support', 'Roster code OT (Plaster Unit). Title confirmed by the owner, 2026-10-07.', true, NULL, 19),
  ('AN', 'Assistant Nurse (provisional)', 'Assistant Nurse', 'ممرض مساعد', 'Support', 'Roster code AN (Diabetic Center, Outpatient Department). Title confirmed by the owner, 2026-10-07.', true, NULL, 20),
  ('PN', 'Practical Nurse (provisional)', 'Practical Nurse', 'ممرض عملي', 'Clinical', 'Roster code PN (Intensive Care Unit). Title confirmed by the owner, 2026-10-07.', true, NULL, 21),
  ('CH', 'CH – title to be confirmed', 'Community Health Nurse', 'ممرض صحة المجتمع', 'Clinical', 'Roster code CH (Diabetic Center; the RRT roster). Title confirmed by the owner, 2026-10-07.', true, NULL, 23),
  ('HD', 'HD – title to be confirmed', 'Head Nurse', 'رئيس تمريض', 'Management', 'Roster code HD means Head Nurse (owner, 2026-10-07). Deprecated — migrate to HN.', false, 'HN', 97)
), "before" AS (
  SELECT p.* FROM "positions" p JOIN confirmed c ON c."code" = p."code"
), changed AS (
  UPDATE "positions" p
  SET "title" = c."title", "title_ar" = c."title_ar", "tier" = c."tier", "description" = c."description",
      "is_active" = c."is_active", "replaced_by" = c."replaced_by", "display_order" = c."display_order", "updated_at" = now()
  FROM confirmed c
  WHERE p."code" = c."code" AND p."title" = c."old_title"
    AND (c."is_active" OR NOT EXISTS (SELECT 1 FROM "employees" e WHERE e."position_code" = p."code" AND e."deleted_at" IS NULL))
    AND (c."replaced_by" IS NULL OR EXISTS (SELECT 1 FROM "positions" r WHERE r."code" = c."replaced_by" AND r."is_active"))
  RETURNING p."code", p."title", p."title_ar", p."tier", p."description", p."is_active", p."replaced_by", p."display_order"
)
SELECT fn_append_audit_entry(
  NULL, 'POSITION_UPDATED', 'position', a."code",
  jsonb_build_object(
    'before', jsonb_build_object('title', b."title", 'titleAr', b."title_ar", 'tier', b."tier", 'description', b."description",
                                 'isActive', b."is_active", 'replacedBy', b."replaced_by", 'displayOrder', b."display_order"),
    'after', jsonb_build_object('title', a."title", 'titleAr', a."title_ar", 'tier', a."tier", 'description', a."description",
                                'isActive', a."is_active", 'replacedBy', a."replaced_by", 'displayOrder', a."display_order"),
    'source', 'Owner confirmation 2026-10-07',
    'migration', '20261028090000_position_titles_confirmed'))
FROM (SELECT c.* FROM changed c ORDER BY c."display_order") a
JOIN "before" b ON b."code" = a."code";
