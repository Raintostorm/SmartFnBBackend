CREATE TYPE "RefundApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

CREATE TABLE "refund_approval_requests" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "RefundApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "order_item_ids" JSONB NOT NULL DEFAULT '[]',
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "reason_code" VARCHAR(50) NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "requested_by_employee_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_user_id" UUID,
    "reviewed_by_employee_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" VARCHAR(500),
    "completed_by_user_id" UUID,
    "completed_by_employee_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "refund_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "refund_approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refund_approval_requests_branch_id_status_requested_at_idx" ON "refund_approval_requests"("branch_id", "status", "requested_at");
CREATE INDEX "refund_approval_requests_order_id_status_idx" ON "refund_approval_requests"("order_id", "status");
ALTER TABLE "refund_approval_requests" ADD CONSTRAINT "refund_approval_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "roles" SET "name" = 'Store Manager' WHERE "code" = 'MANAGER';
