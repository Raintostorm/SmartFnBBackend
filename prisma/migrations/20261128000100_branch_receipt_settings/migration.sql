-- Store Manager tuỳ biến hoá đơn: wifi, link đánh giá Google Maps, lời nhắn cuối bill (mỗi chi nhánh một dòng).
-- Người sửa được ghi ở branch_audit_logs nên bảng này không giữ khoá tới tài khoản.
CREATE TABLE "branch_receipt_settings" (
    "branch_id" UUID NOT NULL,
    "wifi_name" VARCHAR(32),
    "wifi_password" VARCHAR(63),
    "review_url" VARCHAR(500),
    "footer_note" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_receipt_settings_pkey" PRIMARY KEY ("branch_id")
);

ALTER TABLE "branch_receipt_settings" ADD CONSTRAINT "branch_receipt_settings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
