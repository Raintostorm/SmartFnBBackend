CREATE TABLE "display_posters" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "image_url" VARCHAR(500) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0 CHECK ("sort_order" >= 0),
  "duration_seconds" INTEGER NOT NULL DEFAULT 8 CHECK ("duration_seconds" BETWEEN 3 AND 60),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "display_posters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "display_posters_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "display_posters_chain_id_deleted_at_enabled_sort_order_idx" ON "display_posters"("chain_id", "deleted_at", "enabled", "sort_order");
