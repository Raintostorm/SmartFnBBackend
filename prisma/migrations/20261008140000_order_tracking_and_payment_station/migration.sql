ALTER TABLE "payments" ADD COLUMN "station_id" UUID;

CREATE INDEX "payments_station_id_idx" ON "payments"("station_id");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_station_id_fkey"
  FOREIGN KEY ("station_id") REFERENCES "pos_stations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "order_tracking_tokens" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "token_salt" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "terminal_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "last_accessed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "order_tracking_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_tracking_tokens_order_id_key" ON "order_tracking_tokens"("order_id");
CREATE UNIQUE INDEX "order_tracking_tokens_token_hash_key" ON "order_tracking_tokens"("token_hash");
CREATE INDEX "order_tracking_tokens_expires_at_revoked_at_idx"
  ON "order_tracking_tokens"("expires_at", "revoked_at");

ALTER TABLE "order_tracking_tokens"
  ADD CONSTRAINT "order_tracking_tokens_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
