-- Replace the temporary multi-branch MANAGER model. A MANAGER now uses only Employee.branch_id.
DROP TABLE IF EXISTS "manager_branch_assignments";

-- CUSTOMER and loyalty features are intentionally removed from the current product scope.
DROP TABLE IF EXISTS "loyalty_points";

-- Removing a CUSTOMER user cascades to its customer profile. Reservations and orders are
-- detached by their ON DELETE SET NULL constraints before the columns themselves are removed.
DELETE FROM "users"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'CUSTOMER');

ALTER TABLE "reservations" DROP COLUMN IF EXISTS "customer_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "customer_id";
ALTER TABLE "vouchers" DROP COLUMN IF EXISTS "per_customer_limit";
DROP TABLE IF EXISTS "customers";
DELETE FROM "roles" WHERE "code" = 'CUSTOMER';
DROP TYPE IF EXISTS "CustomerTier";
DROP TYPE IF EXISTS "LoyaltyPointType";

-- OWNER is a non-employee account created by ADMIN.
CREATE TABLE "owners" (
    "id" UUID NOT NULL,
    "owner_code" VARCHAR(50) NOT NULL,
    "user_id" UUID NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "date_of_birth" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "owners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "owner_chain_assignments" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_chain_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "owners_owner_code_key" ON "owners"("owner_code");
CREATE UNIQUE INDEX "owners_user_id_key" ON "owners"("user_id");
CREATE UNIQUE INDEX "owner_chain_assignments_owner_id_chain_id_key"
ON "owner_chain_assignments"("owner_id", "chain_id");
CREATE INDEX "owner_chain_assignments_chain_id_idx"
ON "owner_chain_assignments"("chain_id");
CREATE INDEX "owner_chain_assignments_assigned_by_id_idx"
ON "owner_chain_assignments"("assigned_by_id");

ALTER TABLE "owners"
ADD CONSTRAINT "owners_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_chain_assignments"
ADD CONSTRAINT "owner_chain_assignments_owner_id_fkey"
FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_chain_assignments"
ADD CONSTRAINT "owner_chain_assignments_chain_id_fkey"
FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_chain_assignments"
ADD CONSTRAINT "owner_chain_assignments_assigned_by_id_fkey"
FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
