-- v17.1 subscription catalog, per-period snapshots, BR-11 keep lists and quota-lock markers.
-- Order matters: snapshot every existing period BEFORE the catalog changes, so a period that is
-- already paid keeps the plan, price, limits and features it was sold with (BR-72, BR-90).

-- 1. One row per billing period. Enforcement reads the row that contains "now".
CREATE TABLE "subscription_periods" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subscription_id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "invoice_id" UUID,
  "plan_id" UUID NOT NULL,
  "plan_code" VARCHAR(50) NOT NULL,
  "plan_name" VARCHAR(100) NOT NULL,
  "monthly_price" INTEGER NOT NULL,
  "plan_max_branches" INTEGER NOT NULL,
  "plan_max_accounts" INTEGER NOT NULL,
  "extra_branches" INTEGER NOT NULL DEFAULT 0,
  "extra_branch_price" INTEGER NOT NULL DEFAULT 0,
  "extra_branch_accounts" INTEGER NOT NULL DEFAULT 8,
  "account_packs" INTEGER NOT NULL DEFAULT 0,
  "account_pack_price" INTEGER NOT NULL DEFAULT 0,
  "account_pack_size" INTEGER NOT NULL DEFAULT 5,
  "branch_limit" INTEGER NOT NULL,
  "account_limit" INTEGER NOT NULL,
  "branding_enabled" BOOLEAN NOT NULL DEFAULT false,
  "multi_branch_comparison_enabled" BOOLEAN NOT NULL DEFAULT false,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "source" VARCHAR(30) NOT NULL,
  "keep_branch_ids" JSONB,
  "keep_account_ids" JSONB,
  "applied_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_periods_range_check" CHECK ("ends_at" > "starts_at")
);
CREATE UNIQUE INDEX "subscription_periods_subscription_id_starts_at_key" ON "subscription_periods"("subscription_id", "starts_at");
CREATE UNIQUE INDEX "subscription_periods_invoice_id_key" ON "subscription_periods"("invoice_id");
CREATE INDEX "subscription_periods_chain_id_starts_at_idx" ON "subscription_periods"("chain_id", "starts_at");
CREATE INDEX "subscription_periods_applied_at_starts_at_idx" ON "subscription_periods"("applied_at", "starts_at");
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "business_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "subscription_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_periods" ADD CONSTRAINT "subscription_periods_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Next-period registration keeps the BR-11 selection and who registered it (BR-74 notice).
ALTER TABLE "business_subscriptions"
  ADD COLUMN "next_keep_branch_ids" JSONB,
  ADD COLUMN "next_keep_account_ids" JSONB,
  ADD COLUMN "next_registered_by_role" VARCHAR(30),
  ADD COLUMN "next_registered_at" TIMESTAMPTZ(6);

-- 3. Quota markers: distinguish "suspended/locked because of the plan limit" from manual actions.
ALTER TABLE "branches" ADD COLUMN "quota_suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "quota_locked_at" TIMESTAMPTZ(6);

-- 4. Backfill the current period of every subscription with the values in force today.
INSERT INTO "subscription_periods" (
  "subscription_id", "chain_id", "plan_id", "plan_code", "plan_name", "monthly_price",
  "plan_max_branches", "plan_max_accounts", "extra_branches", "extra_branch_price", "extra_branch_accounts",
  "account_packs", "account_pack_price", "branch_limit", "account_limit",
  "branding_enabled", "multi_branch_comparison_enabled", "starts_at", "ends_at", "source", "applied_at"
)
SELECT s."id", s."chain_id", p."id", p."code", p."name", ROUND(s."monthly_price")::INTEGER,
  p."max_branches", p."max_accounts", s."active_extra_branches", p."extra_branch_price", p."extra_branch_accounts",
  s."active_account_packs", p."extra_account_pack_price",
  p."max_branches" + s."active_extra_branches",
  p."max_accounts" + s."active_extra_branches" * p."extra_branch_accounts" + s."active_account_packs" * 5,
  p."branding_enabled", p."multi_branch_comparison_enabled",
  s."starts_at", COALESCE(s."pending_starts_at", s."expires_at"), 'LEGACY_BACKFILL', CURRENT_TIMESTAMP
FROM "business_subscriptions" s
JOIN "service_plans" p ON p."id" = s."plan_id"
WHERE COALESCE(s."pending_starts_at", s."expires_at") > s."starts_at"
ON CONFLICT DO NOTHING;

-- An upcoming period that was already paid keeps the plan that was invoiced; it is not applied yet.
INSERT INTO "subscription_periods" (
  "subscription_id", "chain_id", "plan_id", "plan_code", "plan_name", "monthly_price",
  "plan_max_branches", "plan_max_accounts", "extra_branches", "extra_branch_price", "extra_branch_accounts",
  "account_packs", "account_pack_price", "branch_limit", "account_limit",
  "branding_enabled", "multi_branch_comparison_enabled", "starts_at", "ends_at", "source"
)
SELECT s."id", s."chain_id", p."id", p."code", p."name", ROUND(COALESCE(s."pending_monthly_price", p."monthly_price"))::INTEGER,
  p."max_branches", p."max_accounts", s."pending_extra_branches", p."extra_branch_price", p."extra_branch_accounts",
  s."pending_account_packs", p."extra_account_pack_price",
  p."max_branches" + s."pending_extra_branches",
  p."max_accounts" + s."pending_extra_branches" * p."extra_branch_accounts" + s."pending_account_packs" * 5,
  p."branding_enabled", p."multi_branch_comparison_enabled",
  s."pending_starts_at", s."expires_at", 'LEGACY_BACKFILL'
FROM "business_subscriptions" s
JOIN "service_plans" p ON p."id" = s."pending_plan_id"
WHERE s."pending_starts_at" IS NOT NULL AND s."expires_at" > s."pending_starts_at"
ON CONFLICT DO NOTHING;

-- 5. Catalog v17.1 (13.1, 31.2). Only rows still holding the bootstrap values are changed; values an
-- administrator configured are kept. Feature flags are never changed here (BASIC on existing
-- installations may have been toggled on deliberately).
UPDATE "service_plans"
SET "monthly_price" = 590000, "max_branches" = 3, "max_accounts" = 30, "description" = 'Chuỗi 2–3 chi nhánh'
WHERE "code" = 'BASIC' AND "monthly_price" = 300000 AND "max_branches" = 2 AND "max_accounts" = 10;

UPDATE "service_plans"
SET "extra_branch_price" = 250000, "extra_branch_enabled" = true, "extra_branch_accounts" = 8
WHERE "code" = 'BASIC' AND "extra_branch_price" IN (0, 250000);

INSERT INTO "service_plans" (
  "id", "code", "name", "description", "monthly_price", "max_branches", "max_accounts", "max_tables",
  "extra_branch_price", "extra_branch_accounts", "extra_account_pack_price", "extra_branch_enabled",
  "branding_enabled", "multi_branch_comparison_enabled", "is_active", "updated_at"
) VALUES
  (gen_random_uuid(), 'STANDARD', 'Tiêu chuẩn', 'Chuỗi 4–6 chi nhánh, cần nhận diện riêng', 1090000, 6, 55, 60,
   220000, 8, 50000, true, true, true, true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'ADVANCED', 'Nâng cao', 'Chuỗi 7–10 chi nhánh', 1690000, 10, 90, 100,
   0, 8, 50000, false, true, true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

UPDATE "service_plans"
SET "extra_branch_price" = 220000, "extra_branch_enabled" = true
WHERE "code" = 'STANDARD' AND "extra_branch_price" = 0;

-- 10 branches is the platform ceiling: the top plan never sells extra branches.
UPDATE "service_plans" SET "extra_branch_enabled" = false, "extra_branch_price" = 0
WHERE "code" = 'ADVANCED' OR "max_branches" >= 10;

-- Trial = BASIC limits, never add-ons (BR-68, 31.2). Only follow BASIC if TRIAL was not customized.
UPDATE "service_plans" t
SET "max_branches" = b."max_branches", "max_accounts" = b."max_accounts"
FROM "service_plans" b
WHERE t."code" = 'TRIAL' AND b."code" = 'BASIC' AND t."max_branches" = 2 AND t."max_accounts" = 10;

UPDATE "service_plans"
SET "extra_branch_enabled" = false, "extra_branch_price" = 0, "extra_account_pack_price" = 0
WHERE "code" = 'TRIAL' OR "monthly_price" <= 0;

-- 6. Refund PDF documents (BR-86, 28.5–28.6): one row per refund, bytes live in object storage.
CREATE TABLE "refund_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "refund_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "status" "ReceiptDocumentStatus" NOT NULL DEFAULT 'PENDING',
  "storage_key" VARCHAR(1000),
  "file_name" VARCHAR(255),
  "mime_type" VARCHAR(100),
  "file_size" INTEGER,
  "checksum" VARCHAR(64),
  "generated_at" TIMESTAMPTZ(6),
  "generation_started_at" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error_message" VARCHAR(1000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refund_documents_refund_id_key" ON "refund_documents"("refund_id");
CREATE INDEX "refund_documents_order_id_idx" ON "refund_documents"("order_id");
CREATE INDEX "refund_documents_branch_id_created_at_idx" ON "refund_documents"("branch_id", "created_at");
CREATE INDEX "refund_documents_status_updated_at_idx" ON "refund_documents"("status", "updated_at");
ALTER TABLE "refund_documents" ADD CONSTRAINT "refund_documents_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_documents" ADD CONSTRAINT "refund_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_documents" ADD CONSTRAINT "refund_documents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Refund slip print log (BR-53): every print / reprint with reason and outcome; never touches refunds.
CREATE TABLE "refund_print_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "refund_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "printed_by_user_id" UUID NOT NULL,
  "printed_by_employee_id" UUID,
  "printed_by_role" VARCHAR(50) NOT NULL,
  "is_reprint" BOOLEAN NOT NULL DEFAULT true,
  "reason" VARCHAR(500),
  "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
  "error_message" VARCHAR(500),
  "printed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_print_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "refund_print_logs_refund_id_created_at_idx" ON "refund_print_logs"("refund_id", "created_at");
CREATE INDEX "refund_print_logs_branch_id_created_at_idx" ON "refund_print_logs"("branch_id", "created_at");
ALTER TABLE "refund_print_logs" ADD CONSTRAINT "refund_print_logs_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
