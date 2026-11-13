-- Keep the earliest inflow if older builds recorded the same payment more than once.
ALTER TABLE cash_ledger_entries DISABLE TRIGGER cash_ledger_entries_no_update_delete;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY payment_id
           ORDER BY occurred_at ASC, id ASC
         ) AS row_number
  FROM cash_ledger_entries
  WHERE direction = 'INFLOW' AND payment_id IS NOT NULL
)
DELETE FROM cash_ledger_entries
WHERE id IN (SELECT id FROM ranked WHERE row_number > 1);

ALTER TABLE cash_ledger_entries ENABLE TRIGGER cash_ledger_entries_no_update_delete;

-- A PayOS webhook, recheck and manual confirmation may race, but a payment is
-- allowed to contribute revenue to the ledger only once.
CREATE UNIQUE INDEX cash_ledger_entries_one_inflow_per_payment
ON cash_ledger_entries (payment_id)
WHERE direction = 'INFLOW' AND payment_id IS NOT NULL;
