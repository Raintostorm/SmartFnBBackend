ALTER TABLE "service_plans"
  ADD COLUMN "extra_branch_price" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "extra_branch_accounts" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "extra_account_pack_price" INTEGER NOT NULL DEFAULT 50000,
  ADD COLUMN "extra_branch_enabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "service_plans" SET "extra_branch_price" = 250000, "extra_branch_enabled" = true WHERE "code" = 'BASIC';
UPDATE "service_plans" SET "extra_branch_price" = 220000, "extra_branch_enabled" = true WHERE "code" = 'STANDARD';

ALTER TABLE "business_subscriptions"
  ADD COLUMN "next_extra_branches" INTEGER,
  ADD COLUMN "next_account_packs" INTEGER,
  ADD COLUMN "active_extra_branches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "active_account_packs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pending_plan_id" UUID,
  ADD COLUMN "pending_monthly_price" DECIMAL(14,2),
  ADD COLUMN "pending_extra_branches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pending_account_packs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pending_starts_at" TIMESTAMPTZ(6);

ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_pending_plan_id_fkey"
  FOREIGN KEY ("pending_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "subscription_invoices" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "plan_name" VARCHAR(100) NOT NULL,
  "period_starts_at" TIMESTAMPTZ(6) NOT NULL,
  "period_ends_at" TIMESTAMPTZ(6) NOT NULL,
  "total" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "paid_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "subscription_invoices_chain_id_status_created_at_idx" ON "subscription_invoices"("chain_id", "status", "created_at");
CREATE UNIQUE INDEX "subscription_invoices_one_pending_per_chain_idx" ON "subscription_invoices"("chain_id") WHERE "status" = 'PENDING';
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "business_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "subscription_invoice_lines" (
  "id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "kind" VARCHAR(30) NOT NULL,
  "description" VARCHAR(150) NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  CONSTRAINT "subscription_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "subscription_invoice_lines_invoice_id_idx" ON "subscription_invoice_lines"("invoice_id");
ALTER TABLE "subscription_invoice_lines" ADD CONSTRAINT "subscription_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "subscription_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_invoice_lines" ADD CONSTRAINT "subscription_invoice_lines_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_checkouts" ADD COLUMN "invoice_id" UUID;
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "subscription_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
