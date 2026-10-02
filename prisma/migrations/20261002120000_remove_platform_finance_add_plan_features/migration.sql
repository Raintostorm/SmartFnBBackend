-- Remove the platform-held wallet and withdrawal workflow. PayOS channels and
-- direct business payment records are intentionally unaffected.
DROP TABLE IF EXISTS "withdrawal_requests";
DROP TABLE IF EXISTS "wallet_ledger_entries";
DROP TABLE IF EXISTS "business_wallets";
DROP TABLE IF EXISTS "platform_finance_configs";

DROP TYPE IF EXISTS "WithdrawalRequestStatus";
DROP TYPE IF EXISTS "WalletLedgerEntryType";
DROP TYPE IF EXISTS "WalletStatus";

-- PA-04: feature entitlements managed as part of each service plan.
ALTER TABLE "service_plans"
ADD COLUMN "branding_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "multi_branch_comparison_enabled" BOOLEAN NOT NULL DEFAULT false;
