ALTER TABLE "menu_items" ADD COLUMN "allow_batching" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "menu_options" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;
