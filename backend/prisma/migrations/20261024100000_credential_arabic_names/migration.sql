-- Arabic names for credential types and their fields (owner, 2026-10-05: "fix the Arabic labels").
-- The Arabic interface showed every credential type ("National ID", "Passport") and every
-- field label in English. Both get an optional Arabic text, shown when the interface is Arabic
-- (English when it is empty), editable in Credentials -> Catalog like the English one.
-- The data steps touch only the hospital baseline's codes and field keys; the baseline file
-- carries the same texts, so an import and this migration agree.

-- AlterTable
ALTER TABLE "credential_templates" ADD COLUMN "name_ar" VARCHAR(120);
ALTER TABLE "credential_template_fields" ADD COLUMN "label_ar" VARCHAR(100);

UPDATE "credential_templates" AS t SET "name_ar" = v."name_ar"
FROM (VALUES
  ('PASSPORT', 'جواز السفر'),
  ('IQAMA', 'الإقامة (هوية مقيم)'),
  ('NATIONAL_ID', 'الهوية الوطنية'),
  ('HOSPITAL_ID', 'بطاقة هوية المستشفى'),
  ('PROF_LICENSE', 'الترخيص المهني'),
  ('SCFHS', 'ترخيص الهيئة السعودية للتخصصات الصحية'),
  ('EMP_CONTRACT', 'عقد العمل'),
  ('MALPRACTICE', 'تأمين الأخطاء الطبية'),
  ('CLEARANCE', 'تصريح الموظف (اللياقة الطبية والتحقق الأمني)'),
  ('CORE_COMP', 'الكفاءة العامة الأساسية'),
  ('UNIT_COMP', 'الكفاءة الخاصة بالوحدة'),
  ('SEDATION', 'التهدئة الواعية'),
  ('BLS', 'دعم الحياة الأساسي (BLS)'),
  ('ACLS', 'دعم الحياة القلبي المتقدم (ACLS)'),
  ('PALS', 'دعم الحياة المتقدم للأطفال (PALS)'),
  ('NRP', 'برنامج إنعاش حديثي الولادة (NRP)'),
  ('BICSL', 'رخصة المهارات الأساسية لمكافحة العدوى (BICSL)')
) AS v("code", "name_ar")
WHERE t."code" = v."code";

UPDATE "credential_template_fields" AS f SET "label_ar" = v."label_ar"
FROM "credential_templates" AS t, (VALUES
  ('approval_date', 'Approval Date', 'تاريخ الاعتماد'),
  ('assessment_date', 'Assessment Date', 'تاريخ التقييم'),
  ('assigned_unit', 'Assigned Unit', 'الوحدة المكلَّف بها'),
  ('background_check_status', 'Background Check Status', 'حالة التحقق الأمني'),
  ('certificate_number', 'Certificate Number', 'رقم الشهادة'),
  ('certifying_department', 'Certifying Department', 'القسم المانح للشهادة'),
  ('classification', 'Professional Classification', 'التصنيف المهني'),
  ('clearance_form_id', 'Clearance Form ID', 'رقم نموذج التصريح'),
  ('contract_reference', 'Contract ID/Reference No.', 'رقم العقد / المرجع'),
  ('contracting_agency', 'Contracting Agency', 'جهة التعاقد'),
  ('department', 'Department/Cost Center', 'القسم / مركز التكلفة'),
  ('effective_date', 'Effective Date', 'تاريخ السريان'),
  ('employee_id_number', 'Employee ID Number', 'الرقم الوظيفي'),
  ('evaluator_name', 'Evaluator Name', 'اسم المقيِّم'),
  ('expiry_date', 'Expiry Date', 'تاريخ الانتهاء'),
  ('expiry_date', 'Expiry Date (Gregorian/Hijri)', 'تاريخ الانتهاء (ميلادي/هجري)'),
  ('insurance_provider', 'Insurance Provider', 'شركة التأمين'),
  ('iqama_number', 'Iqama Number', 'رقم الإقامة'),
  ('issue_date', 'Issue Date', 'تاريخ الإصدار'),
  ('issuing_board', 'Issuing Board', 'الجهة المُصدِرة'),
  ('issuing_country', 'Issuing Country', 'بلد الإصدار'),
  ('job_title', 'Job Title', 'المسمى الوظيفي'),
  ('license_number', 'License Number', 'رقم الترخيص'),
  ('medical_fitness_status', 'Medical Fitness Status', 'حالة اللياقة الطبية'),
  ('national_id_number', 'National ID Number', 'رقم الهوية الوطنية'),
  ('next_reassessment_date', 'Next Reassessment Due Date', 'موعد إعادة التقييم القادم'),
  ('passport_number', 'Passport Number', 'رقم جواز السفر'),
  ('policy_number', 'Policy Number', 'رقم وثيقة التأمين'),
  ('result', 'Pass/Fail Status', 'النتيجة (ناجح/راسب)'),
  ('scfhs_number', 'SCFHS Registration Number', 'رقم التسجيل في الهيئة السعودية للتخصصات الصحية'),
  ('sponsor', 'Sponsor/Employer Name', 'الكفيل / جهة العمل'),
  ('start_date', 'Start Date', 'تاريخ البدء'),
  ('supervised_cases', 'Supervised Cases Count', 'عدد الحالات تحت الإشراف'),
  ('training_provider', 'Training Facility', 'منشأة التدريب'),
  ('training_provider', 'Training Provider', 'جهة التدريب')
) AS v("key", "label", "label_ar")
WHERE f."template_id" = t."id" AND t."code" IN ('PASSPORT', 'IQAMA', 'NATIONAL_ID', 'HOSPITAL_ID', 'PROF_LICENSE', 'SCFHS', 'EMP_CONTRACT', 'MALPRACTICE', 'CLEARANCE', 'CORE_COMP', 'UNIT_COMP', 'SEDATION', 'BLS', 'ACLS', 'PALS', 'NRP', 'BICSL') AND f."key" = v."key" AND f."label" = v."label";
