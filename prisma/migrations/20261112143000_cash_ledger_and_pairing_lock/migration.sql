CREATE TYPE "CashLedgerDirection" AS ENUM ('INFLOW', 'OUTFLOW');
CREATE TYPE "CashLedgerSourceType" AS ENUM ('CASH_PAYMENT', 'PAYOS_WEBHOOK', 'PAYOS_RECHECK', 'MANUAL_CONFIRMATION', 'REFUND');

ALTER TABLE "pos_stations"
  ADD COLUMN "pairing_failed_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pairing_locked_until" TIMESTAMPTZ(6);

CREATE TABLE "cash_ledger_entries" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "order_id" UUID,
  "payment_id" UUID,
  "refund_id" UUID,
  "direction" "CashLedgerDirection" NOT NULL,
  "source_type" "CashLedgerSourceType" NOT NULL,
  "source_id" VARCHAR(100) NOT NULL,
  "payment_method" "PaymentMethod",
  "amount" DECIMAL(14,2) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cash_ledger_entries_source_type_source_id_key" ON "cash_ledger_entries"("source_type", "source_id");
CREATE INDEX "cash_ledger_entries_branch_id_occurred_at_idx" ON "cash_ledger_entries"("branch_id", "occurred_at");
CREATE INDEX "cash_ledger_entries_chain_id_occurred_at_idx" ON "cash_ledger_entries"("chain_id", "occurred_at");

ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_entries_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_cash_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cash_ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cash_ledger_entries_no_update_delete
BEFORE UPDATE OR DELETE ON "cash_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_cash_ledger_mutation();
