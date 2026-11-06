CREATE TYPE "MenuImportStatus" AS ENUM ('PROCESSING', 'WAITING_REVIEW', 'IMPORTED', 'FAILED', 'CANCELLED');

CREATE TABLE "menu_imports" (
  "id" UUID NOT NULL,
  "chain_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "status" "MenuImportStatus" NOT NULL DEFAULT 'PROCESSING',
  "image_urls" JSONB NOT NULL,
  "ocr_text" JSONB,
  "draft" JSONB,
  "result" JSONB,
  "error_reason" VARCHAR(1000),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "imported_at" TIMESTAMPTZ(6),
  "cancelled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "menu_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "menu_imports_chain_id_created_at_idx" ON "menu_imports"("chain_id", "created_at");
CREATE INDEX "menu_imports_status_expires_at_idx" ON "menu_imports"("status", "expires_at");
