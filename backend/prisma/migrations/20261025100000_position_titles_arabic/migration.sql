-- Arabic titles for the positions (owner, 2026-10-05), shown when the interface is Arabic.
-- Only a position that has no Arabic title yet is filled, so a title HR has entered is kept.
-- HR can change them in Workforce -> Positions.
--   DON: Director of Nursing
--   DEPUTY_DON: Deputy Director of Nursing
--   ADMIN: Administrator
--   NS: Nursing Supervisor
--   ACTING_HEAD: Acting Head Nurse
--   NURSE_EDUCATOR: Clinical Nurse Educator
--   PRACTITIONER: Nurse Practitioner
--   HN: Head Nurse
--   CN: Charge Nurse
--   SN: Staff Nurse
--   PCT: Patient Care Technician
--   TEC: Technician
--   HCA: Healthcare Assistant
--   MW: Midwife
--   AHN: Acting/Assistant Head Nurse
--   CI: Clinical Instructor

UPDATE "positions" AS p SET "title_ar" = v."title_ar", "updated_at" = now()
FROM (VALUES
  ('DON', 'مدير التمريض'),
  ('DEPUTY_DON', 'نائب مدير التمريض'),
  ('ADMIN', 'مسؤول إداري'),
  ('NS', 'مشرف تمريض'),
  ('ACTING_HEAD', 'رئيس تمريض بالإنابة'),
  ('NURSE_EDUCATOR', 'معلم تمريض سريري'),
  ('PRACTITIONER', 'ممرض ممارس'),
  ('HN', 'رئيس تمريض'),
  ('CN', 'ممرض مسؤول المناوبة'),
  ('SN', 'ممرض'),
  ('PCT', 'فني رعاية المرضى'),
  ('TEC', 'فني'),
  ('HCA', 'مساعد رعاية صحية'),
  ('MW', 'قابلة'),
  ('AHN', 'رئيس تمريض بالإنابة أو مساعد'),
  ('CI', 'مدرب سريري')
) AS v ("code", "title_ar")
WHERE p."code" = v."code" AND p."title_ar" IS NULL;
