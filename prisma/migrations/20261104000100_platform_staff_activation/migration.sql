ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "temporary_password_expires_at" TIMESTAMPTZ(6);

INSERT INTO "roles" ("id", "code", "name", "description", "is_system", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'PLATFORM_STAFF', 'Platform Staff', 'Hỗ trợ hồ sơ và thuê bao nền tảng trong phạm vi cho phép', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description";

ALTER TABLE "registration_applications"
  ADD COLUMN "approved_plan_id" UUID,
  ADD COLUMN "activation_token_hash" VARCHAR(64),
  ADD COLUMN "activation_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "activated_at" TIMESTAMPTZ(6);

UPDATE "registration_applications"
SET "approved_plan_id" = CASE WHEN "requested_plan_id" IS NOT NULL THEN "requested_plan_id" ELSE NULL END,
    "activated_at" = "reviewed_at"
WHERE "status" = 'APPROVED' AND "approved_chain_id" IS NOT NULL;

UPDATE "registration_applications"
SET "status" = 'ACTIVATED'
WHERE "status" = 'APPROVED' AND "approved_chain_id" IS NOT NULL;

CREATE UNIQUE INDEX "registration_applications_activation_token_hash_key"
  ON "registration_applications"("activation_token_hash");
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_approved_plan_id_fkey"
  FOREIGN KEY ("approved_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "business_subscriptions" ADD COLUMN "next_plan_id" UUID;
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_next_plan_id_fkey" FOREIGN KEY ("next_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "registration_checkouts" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
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
  CONSTRAINT "registration_checkouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "registration_checkouts_provider_order_code_key" ON "registration_checkouts"("provider_order_code");
CREATE INDEX "registration_checkouts_application_id_status_created_at_idx" ON "registration_checkouts"("application_id", "status", "created_at");
ALTER TABLE "registration_checkouts" ADD CONSTRAINT "registration_checkouts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "registration_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "registration_checkouts" ADD CONSTRAINT "registration_checkouts_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "platform_support_actions" (
  "id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "application_id" UUID,
  "chain_id" UUID,
  "action" VARCHAR(80) NOT NULL,
  "note" VARCHAR(1000) NOT NULL,
  "details" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_support_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_support_actions_application_id_created_at_idx" ON "platform_support_actions"("application_id", "created_at");
CREATE INDEX "platform_support_actions_chain_id_created_at_idx" ON "platform_support_actions"("chain_id", "created_at");
ALTER TABLE "platform_support_actions" ADD CONSTRAINT "platform_support_actions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_support_actions" ADD CONSTRAINT "platform_support_actions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "registration_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "platform_support_actions" ADD CONSTRAINT "platform_support_actions_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE SET NULL ON UPDATE CASCADE;
