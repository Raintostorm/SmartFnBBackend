CREATE TYPE "SubscriptionCheckoutStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'NEEDS_REVIEW');

ALTER TABLE "business_subscriptions"
  ADD COLUMN "trial_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "trial_ends_at" TIMESTAMPTZ(6),
  ADD COLUMN "trial_converted_at" TIMESTAMPTZ(6);

ALTER TABLE "email_outbox" ADD COLUMN "dedupe_key" VARCHAR(150);
CREATE UNIQUE INDEX "email_outbox_dedupe_key_key" ON "email_outbox"("dedupe_key");

CREATE TABLE "subscription_checkouts" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "provider_order_code" VARCHAR(30) NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "status" "SubscriptionCheckoutStatus" NOT NULL DEFAULT 'PENDING',
  "checkout_url" TEXT,
  "payment_link_id" VARCHAR(100),
  "paid_at" TIMESTAMPTZ(6),
  "review_reason" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subscription_checkouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subscription_checkouts_provider_order_code_key" ON "subscription_checkouts"("provider_order_code");
CREATE INDEX "subscription_checkouts_chain_id_status_created_at_idx" ON "subscription_checkouts"("chain_id", "status", "created_at");
CREATE UNIQUE INDEX "subscription_checkouts_one_pending_per_chain_idx" ON "subscription_checkouts"("chain_id") WHERE "status" = 'PENDING';
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
