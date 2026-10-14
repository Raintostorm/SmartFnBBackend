# Owner reports and security hardening (v9.2)

Tài liệu này mô tả phần Backend bổ sung cho các yêu cầu #81, #84, #86, #89, #90,
#93, #94, #97, #98 và #99. Phạm vi báo cáo doanh thu dùng cùng một tập dữ liệu:
đơn `COUNTER_PICKUP`, đã thanh toán, theo `paidAt`; đơn huỷ sau thanh toán vẫn nằm trong
doanh thu gộp nhưng khoản hoàn được trừ khỏi doanh thu ròng và không được tính vào số đơn.

## API mới và API đã xác nhận

### #94 — báo cáo theo hình thức thanh toán

```http
GET /api/v1/reports/payment-methods?chainId=<uuid>&branchIds=<uuid>&from=2026-10-01&to=2026-10-31
Authorization: Bearer <owner-access-token>
```

Response trả tổng theo `method` và phần tách theo từng chi nhánh. Mỗi dòng có:

- `grossSettledAmount`: tổng giá trị phải thu;
- `grossReceivedAmount`: số tiền thực nhận;
- `refundAmount`: khoản đã hoặc đang chờ hoàn trong kỳ;
- `netAmount`: giá trị phải thu trừ hoàn;
- `receivedAmount`: tiền thực nhận trừ hoàn;
- `paymentCount`: số khoản thanh toán của đơn không bị huỷ;
- `cancelledAfterPaymentCount`: số khoản thuộc đơn huỷ sau thanh toán.

### #97 — topping bán chạy

```http
GET /api/v1/reports/top-toppings?chainId=<uuid>&branchIds=<uuid>&from=2026-10-01&to=2026-10-31&limit=10
Authorization: Bearer <owner-access-token>
```

Dữ liệu lấy từ snapshot `order_items.selected_options`, không lấy tên hoặc giá hiện tại
của menu. Chỉ option thuộc group code `TOPPING` hoặc `TOPPINGS` được tính. Item bị huỷ
không được tính.

### #98 — giá trị đơn trung bình toàn chuỗi

`GET /api/v1/reports/branch-comparison` nay trả thêm:

```json
{
  "totals": {
    "netRevenue": "950000.00",
    "orderCount": 9,
    "averageOrderValue": "105555.56"
  }
}
```

`averageOrderValue = total netRevenue / total orderCount`. Backend tính trực tiếp để FE
không phải tự chia và không phát sinh sai số giữa các widget.

### #99 — khoản hoàn chờ Owner xử lý

```http
GET /api/v1/payments/refunds?chainId=<uuid>&branchIds=<uuid>&status=PENDING&method=BANK_TRANSFER&from=<ISO>&to=<ISO>&page=1&limit=20
Authorization: Bearer <owner-or-manager-access-token>
```

- Owner chỉ nhìn thấy các chi nhánh thuộc chuỗi được phân quyền.
- Manager chỉ nhìn thấy chi nhánh được gán.
- `status` mặc định là `PENDING`.
- Response có đơn, chi nhánh, payment, refund items và phân trang.
- Truyền một `branchId` ngoài phạm vi trả HTTP 403 trước khi đọc dữ liệu.

### #90 — danh sách doanh nghiệp công khai

Endpoint đã có và không cần đăng nhập:

```http
GET /api/v1/public/restaurant-chains
```

Chỉ trả chuỗi đang hoạt động, chưa bị xoá, cùng số chi nhánh đang hoạt động. API không
trả thông tin subscription, PayOS, nhân viên hoặc dữ liệu nội bộ.

## #84 — chặn tính năng theo gói ở Backend

Hai feature hiện được kiểm tra tại service, không tin trạng thái nút trên FE:

- `BRANDING`: đọc/ghi branding và quản lý poster;
- `MULTI_BRANCH_COMPARISON`: mọi báo cáo Owner có phạm vi từ hai chi nhánh trở lên.

Gói không có tính năng nhận HTTP 403:

```json
{
  "statusCode": 403,
  "error": "PLAN_FEATURE_NOT_ENABLED",
  "feature": "BRANDING",
  "message": "Gói hiện tại không hỗ trợ nhận diện thương hiệu."
}
```

Việc kiểm tra feature dùng gói đã đăng ký kể cả khi gói hết hạn, để giữ nguyên quyền đọc
theo BR-09. Các lệnh ghi vẫn bị `BranchAccessService` chặn khi gói hết hạn hoặc tạm ngưng.

## #81 — đổi QR sang tiền mặt

Trước khi thu tiền mặt, Cashier huỷ PayOS payment `PENDING` qua API PayOS rồi mới chạy
transaction thu tiền. Payment QR được đánh dấu bằng lý do ổn định
`PAYOS_CANCELLED_SWITCH_TO_CASH`.

Nếu webhook PayOS vẫn báo tiền về sau khi đơn đã được trả bằng tiền mặt:

1. không thanh toán hoặc đưa món vào pha lần hai;
2. ghi nhận khoản PayOS thực nhận;
3. tạo đúng một refund `PENDING`, source `LATE_PAYMENT`;
4. phát `manager.order.attention-required` và `refund.pending` với reason
   `PAYMENT_RECEIVED_AFTER_SWITCH_TO_CASH`.

Webhook lặp được chặn bằng idempotency hiện có; refund có `sourceReference` duy nhất.

## #86 — giới hạn thử setup password

Migration:

```text
prisma/migrations/20261014160000_password_setup_attempt_lock/migration.sql
```

Backend lưu hash của setup token, số lần sai và thời điểm khoá. Lần sai thứ năm khóa token
15 phút và trả HTTP 429 với mã `PASSWORD_SETUP_ATTEMPTS_EXCEEDED`. Thiết lập thành công
xóa bản ghi attempt. Không lưu token gốc.

Render chạy migration thông qua `pnpm run render:build`; không chạy SQL thủ công.

## #89 — cấu hình Render

`render.yaml` khai báo worker hết hạn QR chạy trong tiến trình NestJS:

```env
PAYMENT_EXPIRY_JOB_ENABLED=true
PAYMENT_EXPIRY_JOB_INTERVAL_MS=60000
PAYMENT_EXPIRY_BATCH_SIZE=100
```

Các secret vẫn phải nhập trong Render Environment, không commit:

```env
DATABASE_URL=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
PAYOS_MASTER_KEY=
ORDER_TRACKING_SECRET=
EMAIL_API_KEY=
EMAIL_FROM=
CORS_ORIGIN=
REALTIME_CORS_ORIGINS=
PUBLIC_WEB_URL=
```

Lưu ý: filesystem của Render Free là tạm thời. Logo/menu/poster nằm dưới `UPLOAD_DIR`
sẽ mất sau restart hoặc deploy nếu service không có persistent disk. Demo lâu dài phải mount
Render persistent disk vào `UPLOAD_DIR` hoặc chuyển asset sang object storage; không coi thư
mục local của container là nơi lưu bền vững.

## #93 — ranh giới tenant

Các API mới không nhận kết quả chỉ dựa trên ID client gửi lên:

- reports lấy giao của `branchIds` với danh sách Owner được truy cập;
- refunds từ chối branch ngoài scope;
- Manager luôn bị giới hạn về `Employee.branchId`;
- PayOS webhook kiểm tra chain của payment trùng chain của webhook channel;
- branding/poster kiểm tra chain access trước khi đọc hoặc ghi.

## Kiểm tra trước khi merge

```bash
pnpm prisma:generate
pnpm typecheck
pnpm test
pnpm prisma:validate
```

Kết quả tại thời điểm hoàn thành: `158/158` test qua; TypeScript và Prisma validation qua.
