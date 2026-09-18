ALTER TABLE "order_items"
ADD COLUMN "started_by_kitchen_id" UUID,
ADD COLUMN "completed_by_kitchen_id" UUID;

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_started_by_kitchen_id_fkey"
FOREIGN KEY ("started_by_kitchen_id") REFERENCES "employees"("id") ON DELETE SET NULL,
ADD CONSTRAINT "order_items_completed_by_kitchen_id_fkey"
FOREIGN KEY ("completed_by_kitchen_id") REFERENCES "employees"("id") ON DELETE SET NULL;

CREATE INDEX "order_items_started_by_kitchen_id_idx" ON "order_items"("started_by_kitchen_id");
CREATE INDEX "order_items_completed_by_kitchen_id_idx" ON "order_items"("completed_by_kitchen_id");
