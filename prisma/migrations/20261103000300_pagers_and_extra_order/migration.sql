ALTER TABLE orders ADD COLUMN pager_number INTEGER CHECK (pager_number BETWEEN 1 AND 999),
 ADD COLUMN pager_notified_at TIMESTAMPTZ;
-- A completed/cancelled order retains its history while automatically releasing the number.
CREATE UNIQUE INDEX orders_open_branch_pager_unique ON orders (branch_id, pager_number)
 WHERE pager_number IS NOT NULL AND payment_status = 'PAID' AND type = 'COUNTER_PICKUP'
 AND status IN ('SUBMITTED', 'PREPARING', 'READY');
ALTER TABLE menu_item_extras ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
