-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'SERVING', 'PAID', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ServingTaskStatus" AS ENUM ('WAITING', 'CLAIMED', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkSessionStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderItemStatus" ADD VALUE 'QUEUED';
ALTER TYPE "OrderItemStatus" ADD VALUE 'OUT_OF_STOCK';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'SUBMITTED';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "cancellation_reason" VARCHAR(500),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_by_id" UUID,
ADD COLUMN     "queued_at" TIMESTAMPTZ(6),
ADD COLUMN     "ready_at" TIMESTAMPTZ(6),
ADD COLUMN     "selected_options" JSONB,
ADD COLUMN     "served_at" TIMESTAMPTZ(6),
ADD COLUMN     "served_by_waiter_id" UUID,
ADD COLUMN     "unavailable_at" TIMESTAMPTZ(6),
ADD COLUMN     "unavailable_by_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "created_by_waiter_id" UUID,
ADD COLUMN     "submitted_at" TIMESTAMPTZ(6),
ADD COLUMN     "table_session_id" UUID;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "table_session_id" UUID,
ALTER COLUMN "order_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "restaurant_tables" ADD COLUMN     "height" DECIMAL(10,2),
ADD COLUMN     "position_x" DECIMAL(10,2),
ADD COLUMN     "position_y" DECIMAL(10,2),
ADD COLUMN     "width" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "table_adjacencies" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "adjacent_table_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_adjacencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" UUID NOT NULL,
    "session_code" VARCHAR(50) NOT NULL,
    "branch_id" UUID NOT NULL,
    "reservation_id" UUID,
    "opened_by_waiter_id" UUID NOT NULL,
    "closed_by_waiter_id" UUID,
    "guest_count" INTEGER NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "payment_status" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "guest_name" VARCHAR(150),
    "guest_phone" VARCHAR(20),
    "note" VARCHAR(500),
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_session_tables" (
    "table_session_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "table_session_tables_pkey" PRIMARY KEY ("table_session_id","table_id")
);

-- CreateTable
CREATE TABLE "branch_menu_items" (
    "branch_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "remaining_portions" INTEGER,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_menu_items_pkey" PRIMARY KEY ("branch_id","menu_item_id")
);

-- CreateTable
CREATE TABLE "work_sessions" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "WorkSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_start" TIMESTAMPTZ(6),
    "scheduled_end" TIMESTAMPTZ(6),
    "checked_in_at" TIMESTAMPTZ(6),
    "checked_out_at" TIMESTAMPTZ(6),
    "is_unscheduled" BOOLEAN NOT NULL DEFAULT false,
    "auto_closed" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serving_tasks" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "ServingTaskStatus" NOT NULL DEFAULT 'WAITING',
    "claimed_by_waiter_id" UUID,
    "served_by_waiter_id" UUID,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "served_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "serving_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "table_adjacencies_branch_id_idx" ON "table_adjacencies"("branch_id");

-- CreateIndex
CREATE INDEX "table_adjacencies_adjacent_table_id_idx" ON "table_adjacencies"("adjacent_table_id");

-- CreateIndex
CREATE UNIQUE INDEX "table_adjacencies_table_id_adjacent_table_id_key" ON "table_adjacencies"("table_id", "adjacent_table_id");

-- CreateIndex
CREATE UNIQUE INDEX "table_sessions_session_code_key" ON "table_sessions"("session_code");

-- CreateIndex
CREATE UNIQUE INDEX "table_sessions_reservation_id_key" ON "table_sessions"("reservation_id");

-- CreateIndex
CREATE INDEX "table_sessions_branch_id_status_idx" ON "table_sessions"("branch_id", "status");

-- CreateIndex
CREATE INDEX "table_sessions_opened_by_waiter_id_opened_at_idx" ON "table_sessions"("opened_by_waiter_id", "opened_at");

-- CreateIndex
CREATE INDEX "table_session_tables_table_id_released_at_idx" ON "table_session_tables"("table_id", "released_at");

-- CreateIndex
CREATE INDEX "branch_menu_items_branch_id_is_enabled_is_available_idx" ON "branch_menu_items"("branch_id", "is_enabled", "is_available");

-- CreateIndex
CREATE INDEX "branch_menu_items_updated_by_id_idx" ON "branch_menu_items"("updated_by_id");

-- CreateIndex
CREATE INDEX "work_sessions_employee_id_status_idx" ON "work_sessions"("employee_id", "status");

-- CreateIndex
CREATE INDEX "work_sessions_branch_id_status_checked_in_at_idx" ON "work_sessions"("branch_id", "status", "checked_in_at");

-- CreateIndex
CREATE UNIQUE INDEX "serving_tasks_order_item_id_key" ON "serving_tasks"("order_item_id");

-- CreateIndex
CREATE INDEX "serving_tasks_branch_id_status_available_at_idx" ON "serving_tasks"("branch_id", "status", "available_at");

-- CreateIndex
CREATE INDEX "serving_tasks_claimed_by_waiter_id_status_idx" ON "serving_tasks"("claimed_by_waiter_id", "status");

-- CreateIndex
CREATE INDEX "order_items_status_queued_at_idx" ON "order_items"("status", "queued_at");

-- CreateIndex
CREATE INDEX "order_items_served_by_waiter_id_idx" ON "order_items"("served_by_waiter_id");

-- CreateIndex
CREATE INDEX "orders_table_session_id_placed_at_idx" ON "orders"("table_session_id", "placed_at");

-- CreateIndex
CREATE INDEX "orders_created_by_waiter_id_idx" ON "orders"("created_by_waiter_id");

-- CreateIndex
CREATE INDEX "payments_table_session_id_status_idx" ON "payments"("table_session_id", "status");

-- AddForeignKey
ALTER TABLE "table_adjacencies" ADD CONSTRAINT "table_adjacencies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_adjacencies" ADD CONSTRAINT "table_adjacencies_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_adjacencies" ADD CONSTRAINT "table_adjacencies_adjacent_table_id_fkey" FOREIGN KEY ("adjacent_table_id") REFERENCES "restaurant_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_opened_by_waiter_id_fkey" FOREIGN KEY ("opened_by_waiter_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_closed_by_waiter_id_fkey" FOREIGN KEY ("closed_by_waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_session_tables" ADD CONSTRAINT "table_session_tables_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_session_tables" ADD CONSTRAINT "table_session_tables_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_menu_items" ADD CONSTRAINT "branch_menu_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_menu_items" ADD CONSTRAINT "branch_menu_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_menu_items" ADD CONSTRAINT "branch_menu_items_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_waiter_id_fkey" FOREIGN KEY ("created_by_waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_served_by_waiter_id_fkey" FOREIGN KEY ("served_by_waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unavailable_by_id_fkey" FOREIGN KEY ("unavailable_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serving_tasks" ADD CONSTRAINT "serving_tasks_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serving_tasks" ADD CONSTRAINT "serving_tasks_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serving_tasks" ADD CONSTRAINT "serving_tasks_claimed_by_waiter_id_fkey" FOREIGN KEY ("claimed_by_waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serving_tasks" ADD CONSTRAINT "serving_tasks_served_by_waiter_id_fkey" FOREIGN KEY ("served_by_waiter_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain constraints that Prisma cannot express in the schema.
ALTER TABLE "table_adjacencies"
ADD CONSTRAINT "table_adjacencies_distinct_tables_check"
CHECK ("table_id" <> "adjacent_table_id");

ALTER TABLE "table_sessions"
ADD CONSTRAINT "table_sessions_guest_count_check"
CHECK ("guest_count" > 0);

ALTER TABLE "branch_menu_items"
ADD CONSTRAINT "branch_menu_items_remaining_portions_check"
CHECK ("remaining_portions" IS NULL OR "remaining_portions" >= 0);

ALTER TABLE "payments"
ADD CONSTRAINT "payments_exactly_one_payable_check"
CHECK (("order_id" IS NOT NULL) <> ("table_session_id" IS NOT NULL));

-- A physical table and an employee can participate in only one active session at a time.
CREATE UNIQUE INDEX "table_session_tables_one_active_session_per_table_key"
ON "table_session_tables"("table_id")
WHERE "released_at" IS NULL;

CREATE UNIQUE INDEX "work_sessions_one_active_session_per_employee_key"
ON "work_sessions"("employee_id")
WHERE "status" = 'ACTIVE';
