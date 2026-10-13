ALTER TYPE "PrintJobStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED');
CREATE TYPE "RefundMethod" AS ENUM ('CASH', 'BANK_TRANSFER');
CREATE TYPE "RefundSource" AS ENUM ('MANAGER_CANCELLATION', 'LATE_PAYMENT');

CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "method" "RefundMethod" NOT NULL,
    "source" "RefundSource" NOT NULL DEFAULT 'MANAGER_CANCELLATION',
    "source_reference" VARCHAR(255),
    "reason" VARCHAR(500) NOT NULL,
    "requested_by_user_id" UUID,
    "requested_by_employee_id" UUID,
    "requested_by_role" VARCHAR(50) NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_by_user_id" UUID,
    "completed_by_employee_id" UUID,
    "completed_by_role" VARCHAR(50),
    "completed_at" TIMESTAMPTZ(6),
    "cancellation_date" DATE NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refund_items" (
    "id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "refund_amount" DECIMAL(14,2) NOT NULL,
    "is_wastage" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "refund_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refunds_order_id_status_idx" ON "refunds"("order_id", "status");
CREATE INDEX "refunds_payment_id_status_idx" ON "refunds"("payment_id", "status");
CREATE INDEX "refunds_cancellation_date_status_idx" ON "refunds"("cancellation_date", "status");
CREATE UNIQUE INDEX "refunds_source_reference_key" ON "refunds"("source_reference");
CREATE UNIQUE INDEX "refund_items_order_item_id_key" ON "refund_items"("order_item_id");
CREATE INDEX "refund_items_refund_id_idx" ON "refund_items"("refund_id");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
