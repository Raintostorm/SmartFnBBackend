-- Platform onboarding, subscriptions, finance, and secure Owner password setup.
CREATE TYPE "RegistrationApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "BusinessSubscriptionStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED');
CREATE TYPE "SubscriptionEventType" AS ENUM ('CREATED', 'RENEWED', 'UPGRADED', 'DOWNGRADED', 'SUSPENDED', 'REACTIVATED');
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "WalletLedgerEntryType" AS ENUM ('PAYMENT_CREDIT', 'SERVICE_FEE', 'WITHDRAWAL', 'REFUND', 'ADJUSTMENT');
CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'TRANSFERRED', 'TRANSFER_FAILED');
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "service_plans" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "monthly_price" DECIMAL(14,2) NOT NULL,
    "max_branches" INTEGER NOT NULL,
    "max_accounts" INTEGER NOT NULL,
    "max_tables" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "service_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "registration_applications" (
    "id" UUID NOT NULL,
    "application_code" VARCHAR(50) NOT NULL,
    "business_name" VARCHAR(150) NOT NULL,
    "tax_code" VARCHAR(50),
    "representative_name" VARCHAR(150) NOT NULL,
    "representative_email" VARCHAR(255) NOT NULL,
    "representative_phone" VARCHAR(20) NOT NULL,
    "headquarters_address" VARCHAR(500),
    "requested_plan_id" UUID,
    "status" "RegistrationApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" VARCHAR(1000),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "approved_chain_id" UUID,
    "owner_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "registration_applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_subscriptions" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "BusinessSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "monthly_price" DECIMAL(14,2) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "suspended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "business_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_subscription_events" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "type" "SubscriptionEventType" NOT NULL,
    "from_plan_id" UUID,
    "to_plan_id" UUID,
    "changed_by_id" UUID,
    "effective_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(1000),
    CONSTRAINT "business_subscription_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_branding" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "display_name" VARCHAR(150) NOT NULL,
    "logo_url" VARCHAR(500),
    "primary_color" VARCHAR(7) NOT NULL DEFAULT '#0F172A',
    "secondary_color" VARCHAR(7) NOT NULL DEFAULT '#FFFFFF',
    "accent_color" VARCHAR(7) NOT NULL DEFAULT '#22C55E',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "business_branding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_wallets" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "held_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "business_wallets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_ledger_entries" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "branch_id" UUID,
    "type" "WalletLedgerEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "reference_type" VARCHAR(50),
    "reference_id" VARCHAR(100),
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "WithdrawalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "bank_name" VARCHAR(150) NOT NULL,
    "bank_account_name" VARCHAR(150) NOT NULL,
    "bank_account_number" VARCHAR(50) NOT NULL,
    "rejection_reason" VARCHAR(1000),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "bank_transaction_code" VARCHAR(100),
    "transfer_failure_reason" VARCHAR(1000),
    "transferred_by_id" UUID,
    "transferred_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_finance_configs" (
    "id" VARCHAR(30) NOT NULL,
    "payment_fee_rate" DECIMAL(7,6) NOT NULL,
    "holding_period_days" INTEGER NOT NULL,
    "minimum_withdrawal_amount" DECIMAL(14,2) NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "platform_finance_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_setup_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_setup_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "recipient" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "template" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_plans_code_key" ON "service_plans"("code");
CREATE UNIQUE INDEX "registration_applications_application_code_key" ON "registration_applications"("application_code");
CREATE UNIQUE INDEX "registration_applications_approved_chain_id_key" ON "registration_applications"("approved_chain_id");
CREATE UNIQUE INDEX "registration_applications_owner_user_id_key" ON "registration_applications"("owner_user_id");
CREATE INDEX "registration_applications_status_created_at_idx" ON "registration_applications"("status", "created_at");
CREATE INDEX "registration_applications_business_name_idx" ON "registration_applications"("business_name");
CREATE INDEX "registration_applications_representative_email_idx" ON "registration_applications"("representative_email");
CREATE UNIQUE INDEX "business_subscriptions_chain_id_key" ON "business_subscriptions"("chain_id");
CREATE INDEX "business_subscriptions_status_expires_at_idx" ON "business_subscriptions"("status", "expires_at");
CREATE INDEX "business_subscriptions_plan_id_idx" ON "business_subscriptions"("plan_id");
CREATE INDEX "business_subscription_events_subscription_id_effective_at_idx" ON "business_subscription_events"("subscription_id", "effective_at");
CREATE INDEX "business_subscription_events_changed_by_id_idx" ON "business_subscription_events"("changed_by_id");
CREATE UNIQUE INDEX "business_branding_chain_id_key" ON "business_branding"("chain_id");
CREATE UNIQUE INDEX "business_wallets_chain_id_key" ON "business_wallets"("chain_id");
CREATE INDEX "business_wallets_status_idx" ON "business_wallets"("status");
CREATE INDEX "wallet_ledger_entries_wallet_id_created_at_idx" ON "wallet_ledger_entries"("wallet_id", "created_at");
CREATE INDEX "wallet_ledger_entries_branch_id_created_at_idx" ON "wallet_ledger_entries"("branch_id", "created_at");
CREATE INDEX "wallet_ledger_entries_reference_type_reference_id_idx" ON "wallet_ledger_entries"("reference_type", "reference_id");
CREATE INDEX "withdrawal_requests_status_created_at_idx" ON "withdrawal_requests"("status", "created_at");
CREATE INDEX "withdrawal_requests_wallet_id_created_at_idx" ON "withdrawal_requests"("wallet_id", "created_at");
CREATE INDEX "withdrawal_requests_requested_by_id_idx" ON "withdrawal_requests"("requested_by_id");
CREATE UNIQUE INDEX "password_setup_tokens_token_hash_key" ON "password_setup_tokens"("token_hash");
CREATE INDEX "password_setup_tokens_user_id_used_at_idx" ON "password_setup_tokens"("user_id", "used_at");
CREATE INDEX "password_setup_tokens_expires_at_idx" ON "password_setup_tokens"("expires_at");
CREATE INDEX "email_outbox_status_created_at_idx" ON "email_outbox"("status", "created_at");

ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_requested_plan_id_fkey" FOREIGN KEY ("requested_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_approved_chain_id_fkey" FOREIGN KEY ("approved_chain_id") REFERENCES "restaurant_chains"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_subscription_events" ADD CONSTRAINT "business_subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "business_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_subscription_events" ADD CONSTRAINT "business_subscription_events_from_plan_id_fkey" FOREIGN KEY ("from_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_subscription_events" ADD CONSTRAINT "business_subscription_events_to_plan_id_fkey" FOREIGN KEY ("to_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_subscription_events" ADD CONSTRAINT "business_subscription_events_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_branding" ADD CONSTRAINT "business_branding_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_wallets" ADD CONSTRAINT "business_wallets_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "business_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "business_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_transferred_by_id_fkey" FOREIGN KEY ("transferred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "platform_finance_configs" ADD CONSTRAINT "platform_finance_configs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_setup_tokens" ADD CONSTRAINT "password_setup_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "service_plans" (
    "id", "code", "name", "description", "monthly_price",
    "max_branches", "max_accounts", "max_tables", "updated_at"
) VALUES (
    '00000000-0000-4000-8000-000000000010', 'STARTER', 'Starter',
    'Default plan created with the platform-admin module', 0,
    1, 10, 30, CURRENT_TIMESTAMP
);

INSERT INTO "platform_finance_configs" (
    "id", "payment_fee_rate", "holding_period_days", "minimum_withdrawal_amount", "updated_at"
) VALUES ('DEFAULT', 0.020000, 3, 100000, CURRENT_TIMESTAMP);
