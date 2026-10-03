ALTER TABLE "payments" ADD COLUMN "confirmation_reason" VARCHAR(500),
  ADD COLUMN "received_amount" DECIMAL(14,2);

CREATE TABLE "branch_audit_logs" (
  "id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "actor_employee_id" UUID NOT NULL,
  "actor_role" VARCHAR(50) NOT NULL,
  "action" VARCHAR(80) NOT NULL,
  "entity_type" VARCHAR(50) NOT NULL,
  "entity_id" UUID NOT NULL,
  "reason" VARCHAR(500),
  "before" JSONB,
  "after" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "branch_audit_logs_branch_id_created_at_idx" ON "branch_audit_logs"("branch_id", "created_at");
CREATE INDEX "branch_audit_logs_entity_type_entity_id_idx" ON "branch_audit_logs"("entity_type", "entity_id");
