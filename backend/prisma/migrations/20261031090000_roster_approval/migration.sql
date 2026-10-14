-- Roster approval chain (D-71, hospital reply C6 of 2026-10-14): the Nursing Admin
-- prepares, the Nursing Director approves, the Nursing Admin and Supervisors publish.

ALTER TYPE "AppRole" ADD VALUE IF NOT EXISTS 'NURSING_ADMIN';
ALTER TYPE "AppRole" ADD VALUE IF NOT EXISTS 'NURSING_DIRECTOR';

CREATE TYPE "RosterApprovalStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Withdrawn');

CREATE TABLE "roster_approvals" (
    "id" SERIAL NOT NULL,
    "unit_id" INTEGER NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "status" "RosterApprovalStatus" NOT NULL DEFAULT 'Pending',
    "requested_by_id" INTEGER NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMPTZ,
    "note" TEXT,

    CONSTRAINT "roster_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_roster_approvals_window" CHECK ("to_date" >= "from_date" AND "to_date" - "from_date" < 94),
    CONSTRAINT "chk_roster_approvals_decision" CHECK (
      ("status" = 'Pending' AND "decided_by_id" IS NULL AND "decided_at" IS NULL)
      OR ("status" IN ('Approved', 'Rejected') AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)
      OR "status" = 'Withdrawn'),
    CONSTRAINT "chk_roster_approvals_four_eyes" CHECK ("decided_by_id" IS NULL OR "decided_by_id" <> "requested_by_id"),
    CONSTRAINT "chk_roster_approvals_reject_note" CHECK ("status" <> 'Rejected' OR (note IS NOT NULL AND char_length(btrim(note)) >= 5)),
    CONSTRAINT "chk_roster_approvals_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500)
);

CREATE INDEX "roster_approvals_unit_id_status_idx" ON "roster_approvals"("unit_id", "status");

ALTER TABLE "roster_approvals" ADD CONSTRAINT "roster_approvals_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
