-- Bootstrap the approved production catalog independently of demo seeding.
-- Preserve any BASIC/TRIAL configuration already managed by an administrator.
BEGIN;

INSERT INTO "service_plans" (
  "id", "code", "name", "description", "monthly_price",
  "max_branches", "max_accounts", "max_tables",
  "branding_enabled", "multi_branch_comparison_enabled", "is_active", "updated_at"
) VALUES (
  gen_random_uuid(), 'BASIC', 'Cơ bản', 'Gói cơ bản cho chuỗi nhỏ', 300000,
  2, 10, 30, false, false, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "service_plans" (
  "id", "code", "name", "description", "monthly_price",
  "max_branches", "max_accounts", "max_tables",
  "branding_enabled", "multi_branch_comparison_enabled", "is_active", "updated_at"
)
SELECT
  gen_random_uuid(), 'TRIAL', 'Dùng thử 14 ngày',
  'Gói dùng thử với hạn mức tương đương BASIC', 0,
  "max_branches", "max_accounts", "max_tables",
  "branding_enabled", "multi_branch_comparison_enabled", true, CURRENT_TIMESTAMP
FROM "service_plans"
WHERE "code" = 'BASIC' AND "is_active" = true
ON CONFLICT ("code") DO NOTHING;

COMMIT;
