-- Changing the dates of an approved contract (owner request 2026-10-15): HR asks, a different HR
-- administrator approves, and only then do the contract's dates change. A Draft is still edited in
-- place (PATCH /contracts/:id/dates). Every request is kept with the period it replaced.

CREATE TYPE "ContractDateChangeStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Withdrawn');

CREATE TABLE "contract_date_changes" (
    "id" SERIAL NOT NULL,
    "contract_id" INTEGER NOT NULL,
    "from_start_date" DATE NOT NULL,
    "from_end_date" DATE NOT NULL,
    "to_start_date" DATE NOT NULL,
    "to_end_date" DATE NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "ContractDateChangeStatus" NOT NULL DEFAULT 'Pending',
    "requested_by_id" INTEGER NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" INTEGER,
    "decided_at" TIMESTAMPTZ,
    "note" VARCHAR(500),

    CONSTRAINT "contract_date_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_contract_date_changes_period" CHECK ("to_end_date" > "to_start_date"),
    CONSTRAINT "chk_contract_date_changes_changed" CHECK ("to_start_date" <> "from_start_date" OR "to_end_date" <> "from_end_date"),
    CONSTRAINT "chk_contract_date_changes_reason" CHECK (char_length(btrim("reason")) >= 5),
    CONSTRAINT "chk_contract_date_changes_decision" CHECK (
      ("status" = 'Pending' AND "decided_by_id" IS NULL AND "decided_at" IS NULL)
      OR ("status" <> 'Pending' AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
    -- Four eyes (as D-30): the requester never approves or rejects their own request; they may withdraw it.
    CONSTRAINT "chk_contract_date_changes_four_eyes" CHECK ("status" NOT IN ('Approved', 'Rejected') OR "decided_by_id" <> "requested_by_id"),
    CONSTRAINT "chk_contract_date_changes_reject_note" CHECK ("status" <> 'Rejected' OR ("note" IS NOT NULL AND char_length(btrim("note")) >= 5))
);

-- At most one open request per contract.
CREATE UNIQUE INDEX "contract_date_changes_one_pending" ON "contract_date_changes"("contract_id") WHERE "status" = 'Pending';
CREATE INDEX "contract_date_changes_contract_id_idx" ON "contract_date_changes"("contract_id");

ALTER TABLE "contract_date_changes" ADD CONSTRAINT "contract_date_changes_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_date_changes" ADD CONSTRAINT "contract_date_changes_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_date_changes" ADD CONSTRAINT "contract_date_changes_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
