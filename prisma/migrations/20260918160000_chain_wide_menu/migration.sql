-- Menu becomes chain-wide: a category belongs to a restaurant chain, not a branch.
-- Which branch actually sells an item stays in "branch_menu_items".

-- Step 1: add the new column and derive it from each category's current branch.
ALTER TABLE "menu_categories" ADD COLUMN "chain_id" UUID;

UPDATE "menu_categories" AS mc
SET "chain_id" = b."chain_id"
FROM "branches" AS b
WHERE b."id" = mc."branch_id";

-- Step 2: merge categories that collide inside one chain, keeping the oldest.
-- Per-branch duplicates of the same category name become a single chain category.
WITH ranked AS (
    SELECT
        "id",
        FIRST_VALUE("id") OVER (
            PARTITION BY "chain_id", "name"
            ORDER BY "created_at", "id"
        ) AS keep_id
    FROM "menu_categories"
)
UPDATE "menu_items" AS mi
SET "category_id" = r.keep_id
FROM ranked AS r
WHERE mi."category_id" = r."id"
  AND r."id" <> r.keep_id;

WITH ranked AS (
    SELECT
        "id",
        FIRST_VALUE("id") OVER (
            PARTITION BY "chain_id", "name"
            ORDER BY "created_at", "id"
        ) AS keep_id
    FROM "menu_categories"
)
DELETE FROM "menu_categories" AS mc
USING ranked AS r
WHERE mc."id" = r."id"
  AND r."id" <> r.keep_id;

ALTER TABLE "menu_categories" ALTER COLUMN "chain_id" SET NOT NULL;

-- Step 3: swap the branch constraints for chain ones.
ALTER TABLE "menu_categories" DROP CONSTRAINT "menu_categories_branch_id_fkey";
DROP INDEX "menu_categories_branch_id_name_key";
DROP INDEX "menu_categories_branch_id_is_active_display_order_idx";
ALTER TABLE "menu_categories" DROP COLUMN "branch_id";

CREATE UNIQUE INDEX "menu_categories_chain_id_name_key" ON "menu_categories"("chain_id", "name");
CREATE INDEX "menu_categories_chain_id_is_active_display_order_idx" ON "menu_categories"("chain_id", "is_active", "display_order");

ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
