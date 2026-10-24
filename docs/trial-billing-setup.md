# TRIAL 14 ngày và thanh toán gói SmartFnB

## Luồng nghiệp vụ

- Admin duyệt hồ sơ: tạo gói `TRIAL` giá 0 đồng, hạn mức sao chép từ gói `BASIC` đang hoạt động, thời hạn đúng 14 × 24 giờ từ lúc duyệt. Các doanh nghiệp cũ không bị chuyển gói.
- Owner có thể chọn gói trả phí và mở PayOS khi TRIAL còn hạn hoặc đã hết hạn. Khi hết hạn, dữ liệu được giữ và quyền ghi bị chặn; quyền xem gói/thanh toán vẫn mở.
- Chỉ webhook PayOS của **tài khoản merchant SmartFnB** có chữ ký hợp lệ và đúng số tiền mới chuyển TRIAL sang gói trả phí. Thời hạn một tháng bắt đầu ở thời điểm xử lý webhook. Ngày TRIAL còn dư không cộng dồn. Webhook lặp không cộng thêm tháng.
- Email nhắc hạn được xếp ở các ngưỡng 7, 3 và 1 ngày; banner trong web hiện trong 7 ngày cuối. `EmailOutbox` dùng khóa chống gửi trùng giữa nhiều Render instance.

## Cấu hình Render

1. Triển khai BE với migration mới. Cấu hình hiện tại `render:start` chạy `pnpm prisma:migrate:deploy` trước khi mở server. **Không** chạy seed demo để bật tính năng này.
2. Tạo gói trả phí có mã chính xác `BASIC` và trạng thái hoạt động trong trang Admin, nếu chưa có. Hạn mức TRIAL được sao chép từ BASIC khi duyệt hồ sơ; đổi BASIC sau đó sẽ đồng bộ TRIAL ở lần duyệt tiếp theo.
3. Tạo **kênh PayOS riêng cho SmartFnB** để nhận phí nền tảng. Ghi `PLATFORM_PAYOS_CLIENT_ID`, `PLATFORM_PAYOS_API_KEY`, `PLATFORM_PAYOS_CHECKSUM_KEY` vào Render Environment của BE. Không đặt các khóa này trên Vercel/FE, không dùng `PAYOS_MASTER_KEY` hay khóa của nhà hàng để thay thế.
4. Đặt `PLATFORM_PAYOS_WEBHOOK_URL=https://<BE-host>/api/v1/webhooks/payos/platform` (đổi prefix nếu `API_PREFIX` khác). Đặt `PUBLIC_WEB_URL=https://<FE-host>` để PayOS trả Owner về `/owner/plan`.
5. Sau khi BE đã chạy công khai, đăng nhập Admin và gọi `POST /api/v1/admin/platform-billing/confirm-webhook` qua Swagger/API. BE dùng khóa SmartFnB gọi PayOS `confirm-webhook`; PayOS gửi mẫu có chữ ký đến URL ở bước 4. Chỉ khi phản hồi `confirmed: true` mới dùng thanh toán thật.
6. Để email nhắc hạn hoạt động, giữ `TRIAL_REMINDER_JOB_ENABLED=true` và cấu hình `EMAIL_API_KEY`, `EMAIL_FROM` (Resend đã xác thực domain). Nếu thiếu email config, giao diện vẫn nhắc hạn nhưng email sẽ nằm chờ trong outbox.

## Kiểm tra trước khi mở cho khách

- Tạo một hồ sơ thử, duyệt và kiểm tra gói là `TRIAL`, giá 0 đồng, hết hạn sau 14 ngày.
- Thanh toán bằng một giao dịch thử của **tài khoản merchant SmartFnB**. Kiểm tra PayOS gửi webhook, checkout thành `PAID`, Owner được gói đã mua và thời hạn mới bắt đầu lúc xác nhận.
- Gửi lại cùng webhook: thời hạn không thay đổi. Trở về từ PayOS mà không có webhook: gói vẫn là TRIAL.
- Thử khi TRIAL hết hạn: Owner vẫn vào được “Gói của tôi” để thanh toán, còn các thao tác ghi vẫn bị chặn.

Không chạy thanh toán thật chỉ để kiểm thử nếu chưa có quy trình đối soát/hoàn tiền. Nếu PayOS đã thu tiền nhưng webhook trả lỗi, cần kiểm tra giao dịch và xử lý thủ công trước khi thử lại.
