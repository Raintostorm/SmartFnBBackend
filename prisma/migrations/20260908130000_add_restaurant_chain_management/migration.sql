-- CreateEnum
CREATE TYPE "RestaurantChainStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BranchAreaType" AS ENUM ('DINING', 'KITCHEN', 'BAR', 'CASHIER', 'PICKUP');

-- CreateEnum
CREATE TYPE "BranchAreaStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "restaurant_chains" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "logo_url" VARCHAR(500),
    "email" VARCHAR(255),
    "phone" VARCHAR(20),
    "website" VARCHAR(500),
    "tax_code" VARCHAR(50),
    "headquarters_address" VARCHAR(500),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'VND',
    "status" "RestaurantChainStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "restaurant_chains_pkey" PRIMARY KEY ("id")
);

-- Preserve existing branch records by assigning them to the platform's default chain.
INSERT INTO "restaurant_chains" (
    "id",
    "code",
    "name",
    "updated_at"
) VALUES (
    '00000000-0000-4000-8000-000000000001',
    'SMART_FNB',
    'Smart F&B Chain',
    CURRENT_TIMESTAMP
);

-- AlterTable
ALTER TABLE "branches"
ADD COLUMN "chain_id" UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';

-- CreateTable
CREATE TABLE "branch_operating_hours" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "open_time" VARCHAR(5),
    "close_time" VARCHAR(5),
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_operating_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_operating_hours_day_of_week_check" CHECK ("day_of_week" BETWEEN 0 AND 6)
);

-- CreateTable
CREATE TABLE "branch_special_hours" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "open_time" VARCHAR(5),
    "close_time" VARCHAR(5),
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_special_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_areas" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "type" "BranchAreaType" NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 1,
    "status" "BranchAreaStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "branch_areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_chains_code_key" ON "restaurant_chains"("code");
CREATE INDEX "restaurant_chains_status_idx" ON "restaurant_chains"("status");
CREATE INDEX "branches_chain_id_status_idx" ON "branches"("chain_id", "status");
CREATE UNIQUE INDEX "branch_operating_hours_branch_id_day_of_week_key" ON "branch_operating_hours"("branch_id", "day_of_week");
CREATE INDEX "branch_operating_hours_branch_id_idx" ON "branch_operating_hours"("branch_id");
CREATE UNIQUE INDEX "branch_special_hours_branch_id_date_key" ON "branch_special_hours"("branch_id", "date");
CREATE INDEX "branch_special_hours_branch_id_date_idx" ON "branch_special_hours"("branch_id", "date");
CREATE UNIQUE INDEX "branch_areas_branch_id_code_key" ON "branch_areas"("branch_id", "code");
CREATE INDEX "branch_areas_branch_id_type_status_idx" ON "branch_areas"("branch_id", "type", "status");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_chain_id_fkey"
FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "branch_operating_hours" ADD CONSTRAINT "branch_operating_hours_branch_id_fkey"
FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_special_hours" ADD CONSTRAINT "branch_special_hours_branch_id_fkey"
FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_areas" ADD CONSTRAINT "branch_areas_branch_id_fkey"
FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
