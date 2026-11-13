ALTER TABLE "users" ADD COLUMN "email_send_status" "EmailOutboxStatus", ADD COLUMN "email_sent_at" TIMESTAMPTZ(6);

CREATE TABLE "password_reset_audit" (
  "id" UUID NOT NULL,
  "event" VARCHAR(50) NOT NULL,
  "actor_user_id" UUID,
  "subject_user_id" UUID,
  "ip_address" VARCHAR(64),
  "request_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "password_reset_audit_subject_user_id_created_at_idx" ON "password_reset_audit"("subject_user_id", "created_at");
CREATE INDEX "password_reset_audit_actor_user_id_created_at_idx" ON "password_reset_audit"("actor_user_id", "created_at");
ALTER TABLE "password_reset_audit" ADD CONSTRAINT "password_reset_audit_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_reset_audit" ADD CONSTRAINT "password_reset_audit_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
