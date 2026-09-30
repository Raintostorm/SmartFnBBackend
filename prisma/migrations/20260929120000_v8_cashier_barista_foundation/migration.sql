ALTER TYPE "OrderType" ADD VALUE IF NOT EXISTS 'COUNTER_PICKUP';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "OrderItemStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';

CREATE TYPE "PaymentProvider" AS ENUM ('CASH', 'PAYOS', 'MANUAL');
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'REJECTED', 'FAILED');
CREATE TYPE "PrintDocumentType" AS ENUM ('RECEIPT', 'QUEUE_TICKET');

ALTER TABLE "orders"
ADD COLUMN "created_by_cashier_id" UUID,
ADD COLUMN "delivered_by_id" UUID,
ADD COLUMN "paid_at" TIMESTAMPTZ(6),
ADD COLUMN "ready_at" TIMESTAMPTZ(6),
ADD COLUMN "delivered_at" TIMESTAMPTZ(6),
ADD COLUMN "business_date" DATE,
ADD COLUMN "call_number" INTEGER;

ALTER TABLE "payments"
ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "provider_order_code" VARCHAR(100),
ADD COLUMN "provider_transaction_id" VARCHAR(255),
ADD COLUMN "checkout_url" VARCHAR(1000),
ADD COLUMN "qr_code" TEXT,
ADD COLUMN "expires_at" TIMESTAMPTZ(6),
ADD COLUMN "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN "tendered_amount" DECIMAL(14,2),
ADD COLUMN "change_amount" DECIMAL(14,2);

ALTER TABLE "invoices"
ALTER COLUMN "table_session_id" DROP NOT NULL,
ADD COLUMN "order_id" UUID;

CREATE TABLE "menu_option_groups" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "code" VARCHAR(50) NOT NULL,
  "is_required" BOOLEAN NOT NULL DEFAULT false,
  "min_selections" INTEGER NOT NULL DEFAULT 0,
  "max_selections" INTEGER NOT NULL DEFAULT 1,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "menu_option_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "menu_options" (
  "id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "code" VARCHAR(50) NOT NULL,
  "price_delta" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "menu_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "menu_item_option_groups" (
  "menu_item_id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "menu_item_option_groups_pkey" PRIMARY KEY ("menu_item_id", "group_id")
);

CREATE TABLE "branch_menu_options" (
  "branch_id" UUID NOT NULL,
  "option_id" UUID NOT NULL,
  "is_available" BOOLEAN NOT NULL DEFAULT true,
  "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "branch_menu_options_pkey" PRIMARY KEY ("branch_id", "option_id")
);

CREATE TABLE "order_item_units" (
  "id" UUID NOT NULL,
  "order_item_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "started_by_id" UUID,
  "completed_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "order_item_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "branch_daily_sequences" (
  "branch_id" UUID NOT NULL,
  "business_date" DATE NOT NULL,
  "next_number" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "branch_daily_sequences_pkey" PRIMARY KEY ("branch_id", "business_date")
);

CREATE TABLE "payment_webhook_events" (
  "id" UUID NOT NULL,
  "payment_id" UUID,
  "provider" "PaymentProvider" NOT NULL,
  "idempotency_key" VARCHAR(255) NOT NULL,
  "provider_order_code" VARCHAR(100),
  "signature_valid" BOOLEAN NOT NULL DEFAULT false,
  "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
  "payload" JSONB NOT NULL,
  "error_message" VARCHAR(1000),
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "print_jobs" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "type" "PrintDocumentType" NOT NULL,
  "printed_by_id" UUID NOT NULL,
  "is_reprint" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(500),
  "printed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_display_sessions" (
  "id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "active_order_id" UUID,
  "device_name" VARCHAR(150),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "customer_display_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "menu_option_groups_chain_id_code_key" ON "menu_option_groups"("chain_id", "code");
CREATE INDEX "menu_option_groups_chain_id_is_active_display_order_idx" ON "menu_option_groups"("chain_id", "is_active", "display_order");
CREATE UNIQUE INDEX "menu_options_group_id_code_key" ON "menu_options"("group_id", "code");
CREATE INDEX "menu_options_group_id_is_active_display_order_idx" ON "menu_options"("group_id", "is_active", "display_order");
CREATE INDEX "menu_item_option_groups_group_id_idx" ON "menu_item_option_groups"("group_id");
CREATE INDEX "branch_menu_options_branch_id_is_available_idx" ON "branch_menu_options"("branch_id", "is_available");
CREATE INDEX "branch_menu_options_updated_by_id_idx" ON "branch_menu_options"("updated_by_id");
CREATE UNIQUE INDEX "order_item_units_order_item_id_sequence_key" ON "order_item_units"("order_item_id", "sequence");
CREATE INDEX "order_item_units_status_created_at_idx" ON "order_item_units"("status", "created_at");
CREATE UNIQUE INDEX "orders_branch_id_business_date_call_number_key" ON "orders"("branch_id", "business_date", "call_number");
CREATE INDEX "orders_created_by_cashier_id_idx" ON "orders"("created_by_cashier_id");
CREATE UNIQUE INDEX "payments_provider_order_code_key" ON "payments"("provider_order_code");
CREATE UNIQUE INDEX "payment_webhook_events_provider_idempotency_key_key" ON "payment_webhook_events"("provider", "idempotency_key");
CREATE INDEX "payment_webhook_events_provider_order_code_idx" ON "payment_webhook_events"("provider_order_code");
CREATE INDEX "payment_webhook_events_status_received_at_idx" ON "payment_webhook_events"("status", "received_at");
CREATE UNIQUE INDEX "invoices_order_id_key" ON "invoices"("order_id");
CREATE INDEX "print_jobs_order_id_printed_at_idx" ON "print_jobs"("order_id", "printed_at");
CREATE INDEX "print_jobs_branch_id_printed_at_idx" ON "print_jobs"("branch_id", "printed_at");
CREATE UNIQUE INDEX "customer_display_sessions_token_hash_key" ON "customer_display_sessions"("token_hash");
CREATE INDEX "customer_display_sessions_branch_id_revoked_at_expires_at_idx" ON "customer_display_sessions"("branch_id", "revoked_at", "expires_at");

ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_cashier_id_fkey" FOREIGN KEY ("created_by_cashier_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivered_by_id_fkey" FOREIGN KEY ("delivered_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_options" ADD CONSTRAINT "menu_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "menu_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "menu_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_menu_options" ADD CONSTRAINT "branch_menu_options_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_menu_options" ADD CONSTRAINT "branch_menu_options_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "menu_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_menu_options" ADD CONSTRAINT "branch_menu_options_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "branch_daily_sequences" ADD CONSTRAINT "branch_daily_sequences_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printed_by_id_fkey" FOREIGN KEY ("printed_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_display_sessions" ADD CONSTRAINT "customer_display_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_display_sessions" ADD CONSTRAINT "customer_display_sessions_active_order_id_fkey" FOREIGN KEY ("active_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "roles" ("id", "code", "name", "description", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), 'BARISTA', 'Barista', 'Nhân viên pha chế', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "code" = 'BARISTA');
