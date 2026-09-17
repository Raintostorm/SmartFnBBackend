-- CreateTable
CREATE TABLE "manager_branch_assignments" (
    "id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_branch_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manager_branch_assignments_manager_id_branch_id_key"
ON "manager_branch_assignments"("manager_id", "branch_id");

CREATE INDEX "manager_branch_assignments_branch_id_idx"
ON "manager_branch_assignments"("branch_id");

CREATE INDEX "manager_branch_assignments_assigned_by_id_idx"
ON "manager_branch_assignments"("assigned_by_id");

-- AddForeignKey
ALTER TABLE "manager_branch_assignments"
ADD CONSTRAINT "manager_branch_assignments_manager_id_fkey"
FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "manager_branch_assignments"
ADD CONSTRAINT "manager_branch_assignments_branch_id_fkey"
FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "manager_branch_assignments"
ADD CONSTRAINT "manager_branch_assignments_assigned_by_id_fkey"
FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
