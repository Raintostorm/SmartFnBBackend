ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REQUIRES_ATTENTION';

ALTER TABLE "orders"
ADD COLUMN "attention_at" TIMESTAMPTZ(6),
ADD COLUMN "attention_reason" VARCHAR(100);

CREATE INDEX "orders_attention_at_idx" ON "orders"("attention_at");
