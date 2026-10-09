-- V9.1: Owner decides whether a menu item may be grouped into a preparation batch.
ALTER TABLE "menu_items"
ADD COLUMN "allow_batching" BOOLEAN NOT NULL DEFAULT true;

-- V9.1: POS preselects the configured default option in each option group.
ALTER TABLE "menu_options"
ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;
