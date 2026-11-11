ALTER TABLE "password_setup_tokens" ADD COLUMN "purpose" VARCHAR(30) NOT NULL DEFAULT 'INVITATION';
ALTER TABLE "password_setup_tokens" ADD COLUMN "cancelled_at" TIMESTAMPTZ(6);
ALTER TABLE "password_setup_tokens" ADD COLUMN "request_ip_address" VARCHAR(64);
ALTER TABLE "users" ADD COLUMN "last_password_changed_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "last_password_change_method" VARCHAR(30);

CREATE TABLE "password_reset_requests" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "scope_chain_id" UUID,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "ip_address" VARCHAR(64),
  "user_agent" VARCHAR(500),
  "handled_by_id" UUID,
  "handled_at" TIMESTAMPTZ(6),
  "rejection_note" VARCHAR(1000),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "password_reset_requests_scope_chain_id_status_created_at_idx" ON "password_reset_requests"("scope_chain_id", "status", "created_at");
CREATE INDEX "password_reset_requests_user_id_created_at_idx" ON "password_reset_requests"("user_id", "created_at");
CREATE UNIQUE INDEX "password_reset_requests_one_pending_per_user" ON "password_reset_requests"("user_id") WHERE "status" = 'PENDING';
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "password_reset_attempts" (
  "id" UUID NOT NULL,
  "ip_address" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "password_reset_attempts_ip_address_created_at_idx" ON "password_reset_attempts"("ip_address", "created_at");
