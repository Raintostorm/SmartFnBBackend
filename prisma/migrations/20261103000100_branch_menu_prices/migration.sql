-- Additive: existing branches continue using the chain price.
ALTER TABLE "branch_menu_items" ADD COLUMN "price_override" DECIMAL(14,2);
ALTER TABLE "branch_menu_items" ADD CONSTRAINT "branch_menu_items_price_override_nonnegative"
CHECK ("price_override" IS NULL OR "price_override" >= 0);
ALTER TABLE "branch_audit_logs" ALTER COLUMN "actor_employee_id" DROP NOT NULL;
