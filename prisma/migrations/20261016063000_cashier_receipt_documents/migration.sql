CREATE TYPE "ReceiptDocumentStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "receipt_documents" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ReceiptDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "storage_key" VARCHAR(1000),
    "file_name" VARCHAR(255),
    "mime_type" VARCHAR(100),
    "file_size" INTEGER,
    "checksum" VARCHAR(64),
    "generated_at" TIMESTAMPTZ(6),
    "error_message" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "receipt_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_documents_order_id_version_key"
ON "receipt_documents"("order_id", "version");

CREATE INDEX "receipt_documents_branch_id_created_at_idx"
ON "receipt_documents"("branch_id", "created_at");

CREATE INDEX "receipt_documents_status_updated_at_idx"
ON "receipt_documents"("status", "updated_at");

ALTER TABLE "receipt_documents"
ADD CONSTRAINT "receipt_documents_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "receipt_documents"
ADD CONSTRAINT "receipt_documents_branch_id_fkey"
FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
