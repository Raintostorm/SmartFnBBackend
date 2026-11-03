ALTER TABLE "users" ADD COLUMN "staff_invitation_state" VARCHAR(20);
ALTER TABLE "users" ADD CONSTRAINT "users_staff_invitation_state_check"
  CHECK ("staff_invitation_state" IS NULL OR "staff_invitation_state" IN ('PENDING', 'ACCEPTED', 'CANCELLED'));
ALTER TABLE "branch_audit_logs" ALTER COLUMN "actor_employee_id" DROP NOT NULL;
-- Preserve legacy active accounts. Existing inactive email invitations remain usable.
UPDATE "users" u SET "staff_invitation_state" = 'PENDING'
FROM "roles" r WHERE r.id = u.role_id AND r.code IN ('MANAGER','CASHIER','BARISTA')
  AND u.status = 'INACTIVE' AND u.email_verified_at IS NULL
  AND EXISTS (SELECT 1 FROM "password_setup_tokens" t WHERE t.user_id=u.id AND t.used_at IS NULL);
