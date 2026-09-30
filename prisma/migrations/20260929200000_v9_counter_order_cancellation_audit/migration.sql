ALTER TABLE "orders"
  ADD COLUMN "cancelled_by_id" UUID,
  ADD COLUMN "cancellation_reason" VARCHAR(500);

CREATE INDEX "orders_cancelled_by_id_idx" ON "orders"("cancelled_by_id");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_cancelled_by_id_fkey"
  FOREIGN KEY ("cancelled_by_id") REFERENCES "employees"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
