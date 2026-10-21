-- D-74: append-only human observations, distinct from simulated/live lookups.
ALTER TABLE scfhs_verification_log
  ADD COLUMN manual_checked_at TIMESTAMPTZ,
  ADD COLUMN manual_notes TEXT,
  ADD COLUMN evidence_document_id INTEGER REFERENCES document_versions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP CONSTRAINT scfhs_log_driver,
  DROP CONSTRAINT scfhs_log_request_type,
  ADD CONSTRAINT scfhs_log_driver CHECK (driver IN ('mock', 'live', 'manual')),
  ADD CONSTRAINT scfhs_log_request_type CHECK (request_type IN ('MANUAL', 'ON_SUBMIT', 'SCHEDULED', 'WEBSITE')),
  ADD CONSTRAINT scfhs_log_manual_fields CHECK (
    CASE WHEN driver = 'manual' THEN
      request_type = 'WEBSITE' AND manual_checked_at IS NOT NULL AND manual_checked_at <= requested_at
      AND manual_notes IS NOT NULL AND char_length(btrim(manual_notes)) BETWEEN 10 AND 1000
      AND evidence_document_id IS NOT NULL AND actor_user_id IS NOT NULL
      AND action = 'NONE' AND matched IS NULL
    ELSE request_type <> 'WEBSITE' AND manual_checked_at IS NULL AND manual_notes IS NULL AND evidence_document_id IS NULL END
  );

CREATE FUNCTION fn_guard_scfhs_website_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.driver = 'manual' OR (TG_OP = 'UPDATE' AND NEW.driver = 'manual') THEN
      RAISE EXCEPTION 'Website check records are append-only';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.driver = 'manual' AND NOT EXISTS (
    SELECT 1 FROM document_versions d WHERE d.id = NEW.evidence_document_id
      AND d.credential_id = NEW.credential_id AND d.scan_status = 'CLEAN' AND d.erased_at IS NULL
  ) THEN RAISE EXCEPTION 'Website check evidence must be clean and belong to the credential'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scfhs_website_check_guard BEFORE INSERT OR UPDATE OR DELETE ON scfhs_verification_log
  FOR EACH ROW EXECUTE FUNCTION fn_guard_scfhs_website_check();
