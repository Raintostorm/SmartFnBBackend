CREATE TYPE "PayosChannelStatus" AS ENUM ('LINKED', 'ERROR');

ALTER TABLE "payos_channels"
ADD COLUMN "client_id_last4" VARCHAR(4),
ADD COLUMN "api_key_last4" VARCHAR(4),
ADD COLUMN "status" "PayosChannelStatus" NOT NULL DEFAULT 'LINKED',
ADD COLUMN "last_error" VARCHAR(1000),
ADD COLUMN "last_verified_at" TIMESTAMPTZ(6),
ADD COLUMN "webhook_code" UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX "payos_channels_webhook_code_key" ON "payos_channels"("webhook_code");

CREATE TABLE "payos_channel_audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "chain_id" UUID NOT NULL,
  "channel_id" UUID,
  "actor_user_id" UUID NOT NULL,
  "action" VARCHAR(80) NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "error" VARCHAR(1000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payos_channel_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payos_channel_audit_logs_chain_id_fkey"
    FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "payos_channel_audit_logs_chain_id_created_at_idx"
ON "payos_channel_audit_logs"("chain_id", "created_at");
CREATE INDEX "payos_channel_audit_logs_channel_id_idx"
ON "payos_channel_audit_logs"("channel_id");
