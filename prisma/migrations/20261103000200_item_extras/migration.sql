ALTER TABLE "menu_items" ADD COLUMN "max_extras" INTEGER NOT NULL DEFAULT 5 CHECK ("max_extras" >= 0);
CREATE TABLE "menu_extras" (
 "id" UUID NOT NULL PRIMARY KEY, "chain_id" UUID NOT NULL REFERENCES "restaurant_chains"("id") ON DELETE RESTRICT,
 "name" VARCHAR(100) NOT NULL, "price" DECIMAL(14,2) NOT NULL CHECK ("price" >= 0),
 "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("chain_id", "name")
);
CREATE TABLE "menu_item_extras" (
 "menu_item_id" UUID NOT NULL REFERENCES "menu_items"("id") ON DELETE CASCADE,
 "extra_id" UUID NOT NULL REFERENCES "menu_extras"("id") ON DELETE RESTRICT,
 "price" DECIMAL(14,2) NOT NULL CHECK ("price" >= 0),
 "max_quantity" INTEGER NOT NULL DEFAULT 3 CHECK ("max_quantity" BETWEEN 1 AND 5),
 PRIMARY KEY ("menu_item_id", "extra_id")
);
CREATE TABLE "branch_menu_extras" (
 "branch_id" UUID NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
 "extra_id" UUID NOT NULL REFERENCES "menu_extras"("id") ON DELETE CASCADE,
 "is_available" BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY ("branch_id", "extra_id")
);
-- Legacy topping options remain untouched until the explicit migration is verified.
