-- National ID grace days (owner, 2026-10-05): 30 days after expiry while a renewal is in
-- progress, like the Resident ID (Iqama) it replaces for Saudi nationals. Only the type with
-- this code is touched; the 00:05 daily transition re-evaluates every nurse.

UPDATE "credential_templates" SET "grace_period_days" = 30 WHERE "code" = 'NATIONAL_ID';
