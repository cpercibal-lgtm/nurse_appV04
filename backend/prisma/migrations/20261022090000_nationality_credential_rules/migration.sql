-- Credential types by nationality (owner decision 2026-10-04).
--
-- A credential type now says who it applies to: every nationality (ALL), ONLY the listed
-- ones, or every nationality EXCEPT the listed ones. For an employee a type does not apply
-- to, a requirement of that type counts as OPTIONAL: it can still be recorded but never
-- makes the employee ineligible (backend/src/modules/credentials/nationality-rule.ts).
-- An employee without a listed nationality matches no code: EXCEPT types apply to them,
-- ONLY types do not.
--
-- Saudi nationals carry a National ID instead of an Iqama and need no passport here:
--   PASSPORT and IQAMA  -> EXCEPT SAU (optional for Saudi nationals)
--   NATIONAL_ID (new)   -> ONLY SAU, its number protected like the Iqama number (D-54)
-- The data steps only touch types with those codes, and NATIONAL_ID is created only when
-- the IDENTITY category exists (it comes with the hospital baseline).

-- CreateEnum
CREATE TYPE "NationalityRule" AS ENUM ('ALL', 'ONLY', 'EXCEPT');

-- AlterTable
ALTER TABLE "credential_templates" ADD COLUMN     "nationality_codes" VARCHAR(3)[] DEFAULT ARRAY[]::VARCHAR(3)[],
ADD COLUMN     "nationality_rule" "NationalityRule" NOT NULL DEFAULT 'ALL';

-- ALL lists no nationality; ONLY and EXCEPT list at least one.
ALTER TABLE "credential_templates" ADD CONSTRAINT "chk_credential_templates_nationality"
  CHECK (("nationality_rule" = 'ALL') = (COALESCE(cardinality("nationality_codes"), 0) = 0));

-- The National ID number is sensitive personal data (spec §8.3.1): encrypted per employee
-- and blind-indexed, like the Iqama and passport numbers.
ALTER TABLE "credential_template_fields" DROP CONSTRAINT "chk_template_fields_pdpl";
ALTER TABLE "credential_template_fields" ADD CONSTRAINT "chk_template_fields_pdpl"
  CHECK ("pdpl_category" IS NULL OR ("pdpl_category" IN ('IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID') AND "type" = 'text'));
ALTER TABLE "processing_register" DROP CONSTRAINT "chk_processing_register_category";
ALTER TABLE "processing_register" ADD CONSTRAINT "chk_processing_register_category" CHECK ("data_category" IN ('IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID', 'IDENTITY_SCAN'));
ALTER TABLE "pdpl_identifier_index" DROP CONSTRAINT "chk_pdpl_index_category";
ALTER TABLE "pdpl_identifier_index" ADD CONSTRAINT "chk_pdpl_index_category" CHECK ("category" IN ('IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID'));

-- The register entry for the new category; HR and the DPO review it in Administration -> Data protection.
INSERT INTO "processing_register" ("data_category", "lawful_basis", "purpose", "retention_rule", "updated_at") VALUES
  ('NATIONAL_ID', 'LEGAL_OBLIGATION', 'Identity verification of Saudi national staff (National ID card), in place of the Iqama.', 'Employment plus the legally required period.', CURRENT_TIMESTAMP);

-- Passport and Iqama: optional for Saudi nationals.
UPDATE "credential_templates" SET "nationality_rule" = 'EXCEPT', "nationality_codes" = ARRAY['SAU']::VARCHAR(3)[]
  WHERE "code" IN ('PASSPORT', 'IQAMA') AND "nationality_rule" = 'ALL';

-- National ID: Saudi nationals only. Number, issue date, expiry date (Gregorian/Hijri); the card is uploaded.
INSERT INTO "credential_templates" ("code", "name", "category_code", "description", "has_expiry", "requires_upload", "grace_period_days", "display_order", "is_active", "nationality_rule", "nationality_codes")
SELECT 'NATIONAL_ID', 'National ID', 'IDENTITY', 'Saudi national identity card (in place of the Iqama)', true, true, 0, 2, true, 'ONLY', ARRAY['SAU']::VARCHAR(3)[]
WHERE EXISTS (SELECT 1 FROM "credential_categories" WHERE "code" = 'IDENTITY')
  AND NOT EXISTS (SELECT 1 FROM "credential_templates" WHERE "code" = 'NATIONAL_ID');

INSERT INTO "credential_template_fields" ("template_id", "ordinal", "key", "label", "type", "required", "display_order", "is_issue_date", "is_expiry_date", "pdpl_category")
SELECT t."id", f."ordinal", f."key", f."label", f."type"::"CredentialFieldType", true, f."ordinal", f."is_issue", f."is_expiry", f."pdpl"
FROM "credential_templates" t
CROSS JOIN (VALUES
  (1, 'national_id_number', 'National ID Number', 'text', false, false, 'NATIONAL_ID'),
  (2, 'issue_date', 'Issue Date', 'date', true, false, NULL),
  (3, 'expiry_date', 'Expiry Date (Gregorian/Hijri)', 'date_hijri', false, true, NULL)
) AS f("ordinal", "key", "label", "type", "is_issue", "is_expiry", "pdpl")
WHERE t."code" = 'NATIONAL_ID'
  AND NOT EXISTS (SELECT 1 FROM "credential_template_fields" x WHERE x."template_id" = t."id");
