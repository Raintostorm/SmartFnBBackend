# Đối chiếu việc FE Web chờ BE (11/10/2026)

Tài liệu này ghi trạng thái triển khai phía Backend theo danh sách FE Web gửi ngày
11/10/2026. Phạm vi ưu tiên là luồng Cashier, Barista và Manager hỗ trợ hai vai trò này.

## Đã triển khai

| Mục           | Thay đổi chính                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #47, #72      | Báo cáo Manager/Owner dùng cùng tập đơn đã thanh toán; đơn huỷ sau thanh toán không còn làm tăng số đơn; AOV tính từ doanh thu sau hoàn; phân rã theo giờ và phương thức thanh toán đồng nhất. |
| #42           | Render/Docker luôn chạy migration nhưng chỉ chạy demo seed khi `RUN_DEMO_SEED=true`; mặc định không ghi đè dữ liệu.                                                                            |
| #45, #50, #61 | QR có `expiresAt`; hỗ trợ `EXPIRED` và `REQUIRES_ATTENTION`; tiền về sau khi QR hết hạn không đẩy món xuống Barista và được đưa vào luồng cần xử lý.                                           |
| #51           | Phát realtime khi chốt đơn, huỷ thanh toán và huỷ đơn; màn Manager không phải chờ lần tải lại định kỳ cho các thao tác này.                                                                    |
| #27           | Manager có thể đổi tên, bật/tắt và cập nhật máy in của quầy bằng `PATCH /stations/:stationId`.                                                                                                 |
| #28           | Manager liệt kê màn khách/màn gọi số bằng `GET /display-devices`, gồm quầy, lần thấy gần nhất, hạn token và thời điểm thu hồi.                                                                 |
| #48, #52      | Chi tiết đơn trả tiền khách đưa, tiền thối, hạn QR và thông tin quầy.                                                                                                                          |
| #60           | Lỗi thanh toán dùng mã ổn định trong trường `error`, gồm `PAYMENT_ALREADY_SETTLED` và `PAYMENT_AMOUNT_INSUFFICIENT`.                                                                           |
| #62, #63, #64 | Danh sách nhân viên có `lastLoginAt`, trạng thái lời mời và hạn lời mời; có thể huỷ lời mời; `phone: null` xoá số điện thoại.                                                                  |
| #65, #66      | Đơn cần xử lý có `attentionAt`, `attentionReason`; `GET /manager/orders` hỗ trợ `sortBy` và `sortOrder`.                                                                                       |
| #68, #69, #70 | Thu hồi thiết bị ngắt socket đang nối; lỗi token/mã ghép phân biệt rõ; mã ghép công khai giới hạn 10 yêu cầu/phút/IP và tự dọn mã hết hạn/đã dùng.                                             |
| #71           | Context màn gọi số trả `counts.preparing`, `counts.ready` và `pageLimit`, nên FE tính đúng `+N số khác`.                                                                                       |
| #73           | Khoản hoàn trả thông tin người yêu cầu và người hoàn (id, tên, email, vai trò).                                                                                                                |
| #29           | `maxTables` không còn bắt buộc khi tạo gói; BE tự dùng giá trị tương thích `1` cho cột dữ liệu cũ.                                                                                             |

Token màn hình có hạn 30 ngày. Migration hiện có sẽ đặt hạn 30 ngày kể từ lúc ghép
cho thiết bị cũ; thiết bị mới luôn nhận hạn khi ghép.

## Chủ ý chưa đổi

- #49: chưa bỏ đơn `PENDING`, vì Mobile POS hiện dùng bản nháp trong lúc dựng giỏ.
  Chỉ đổi khi FE Mobile cùng chuyển contract để tránh làm hỏng Cashier.
- #55: chưa bỏ snapshot giỏ trong DB và chưa đổi tên sự kiện realtime, vì đây là cơ chế
  khôi phục màn hình sau thu ngân sau mất kết nối. Có thể bổ sung tên sự kiện mới theo
  hướng tương thích ngược ở một đợt riêng.
- #59: BE tiếp tục cho Manager/Owner xác nhận chuyển khoản tay và xử lý huỷ/hoàn khi
  gói hết hạn. Đây là thao tác khắc phục dữ liệu/tiền, không phải tạo giao dịch mới;
  FE nên cho phép cùng chính sách.

## Cấu hình Render

- Chạy `pnpm render:build` khi build và `pnpm render:start` khi start.
- Không đặt `RUN_DEMO_SEED=true` trên môi trường dùng chung hoặc production.
- Sau deploy, migration được áp dụng tự động trước khi ứng dụng khởi động.
- Các biến PayOS và `PAYOS_MASTER_KEY` vẫn phải đặt trong Environment của Render;
  không lưu khoá thật trong repository.

## Kiểm tra

- `pnpm prisma validate`
- `pnpm typecheck`
- `pnpm test` (139 test)
