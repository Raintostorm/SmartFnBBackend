-- PS-01 / 30.3: follow-up data for "Approved — awaiting activation".
ALTER TABLE "registration_applications"
  ADD COLUMN "activation_sent_at" TIMESTAMPTZ(6),
  ADD COLUMN "activation_last_opened_at" TIMESTAMPTZ(6);

-- Existing applications have no reliable delivery timestamp. Keep this field NULL
-- until Resend confirms delivery of the current activation link.

-- BR-06: chain-level audit trail.
CREATE TABLE "chain_audit_logs" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "actor_role" VARCHAR(50) NOT NULL,
  "action" VARCHAR(80) NOT NULL,
  "entity_type" VARCHAR(50) NOT NULL,
  "entity_id" UUID,
  "reason" VARCHAR(500),
  "before" JSONB,
  "after" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chain_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chain_audit_logs_chain_id_created_at_idx" ON "chain_audit_logs"("chain_id", "created_at");
CREATE INDEX "chain_audit_logs_entity_type_entity_id_idx" ON "chain_audit_logs"("entity_type", "entity_id");
