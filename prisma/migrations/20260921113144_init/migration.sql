-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_completed_by_kitchen_id_fkey";

-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_started_by_kitchen_id_fkey";

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_started_by_kitchen_id_fkey" FOREIGN KEY ("started_by_kitchen_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_completed_by_kitchen_id_fkey" FOREIGN KEY ("completed_by_kitchen_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
