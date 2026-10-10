# Xác nhận thanh toán #53 và #54

Tài liệu này mô tả contract Backend cho luồng chuyển khoản của Cashier và Manager.
Webhook PayOS, nút **Kiểm tra lại** và xác nhận thủ công đều đi qua cùng một
settlement service.

## Trạng thái mới

- `PaymentStatus.AMOUNT_MISMATCH`: PayOS báo đã nhận tiền nhưng số nhận khác số phải thu.
- `OrderStatus.REQUIRES_ATTENTION`: đơn chờ Manager xử lý thanh toán lệch.

Khi lệch tiền, Backend lưu số PayOS báo vào `payment.receivedAmount`; không dùng
`FAILED`, không cấp số gọi và không đưa đơn xuống Barista.

## Manager xác nhận thủ công

```http
POST /api/v1/payments/{paymentId}/confirm
Authorization: Bearer <manager access token>
Content-Type: application/json

{
  "reason": "Đã kiểm tra tài khoản ngân hàng",
  "receivedAmount": 60000,
  "transactionRef": "optional-reference"
}
```

Quy tắc:

- Chỉ `MANAGER` được gọi.
- Chỉ xác nhận `BANK_TRANSFER`.
- Payment phải là `PENDING` hoặc `AMOUNT_MISMATCH`.
- `reason` dài 3–500 ký tự.
- `receivedAmount` phải lớn hơn hoặc bằng `payment.amount`.
- Phần dư được lưu trong audit dưới tên `changeDue`.

Nhận thiếu trả HTTP 409:

```json
{
  "statusCode": 409,
  "error": "PAYMENT_AMOUNT_INSUFFICIENT",
  "message": "Số tiền thực nhận thấp hơn tổng tiền đơn hàng."
}
```

## Kết quả settlement thành công

Một transaction thực hiện đồng thời:

1. Khoá payment và order.
2. Chuyển payment sang `SUCCESS`.
3. Chuyển order sang `SUBMITTED` và `PAID`.
4. Cấp `callNumber` theo ngày của chi nhánh.
5. Tạo các đơn vị pha chế cho Barista.
6. Tạo mã và URL theo dõi công khai.
7. Tạo `PrintJob` loại `RECEIPT` và `QUEUE_TICKET`.
8. Ghi audit khi Manager xác nhận tay.

Sau khi commit, Backend phát:

- `payment.confirmed`
- `preparation.order.queued`
- `calling.order.queued`

Payload `payment.confirmed` và `preparation.order.queued`:

```json
{
  "paymentId": "uuid",
  "orderId": "uuid",
  "status": "SUCCESS",
  "callNumber": 23,
  "source": "MANAGER_MANUAL"
}
```

`source` có thể là `PAYOS_WEBHOOK`, `PAYOS_RECHECK` hoặc `MANAGER_MANUAL`.

## PayOS báo lệch tiền

Backend cập nhật:

```text
payment.status = AMOUNT_MISMATCH
payment.receivedAmount = số tiền PayOS báo
order.status = REQUIRES_ATTENTION
```

Sau commit, Backend phát `manager.order.attention-required`:

```json
{
  "reason": "PAYMENT_AMOUNT_MISMATCH",
  "orderId": "uuid",
  "paymentId": "uuid",
  "expectedAmount": "50000",
  "receivedAmount": "60000"
}
```

Manager có thể lọc danh sách đơn bằng:

```text
GET /api/v1/manager/orders?status=REQUIRES_ATTENTION
GET /api/v1/manager/orders?paymentRecordStatus=AMOUNT_MISMATCH
```

## Đồng thời và chạy lại

Settlement khoá payment và order trong transaction `Serializable`. Chỉ payment
`PENDING` hoặc `AMOUNT_MISMATCH` được chốt. Một yêu cầu tới sau khi payment đã
`SUCCESS` nhận HTTP 409 với `PAYMENT_ALREADY_SETTLED`; không cấp thêm số gọi,
không tạo lại đơn vị pha chế, tracking token hoặc PrintJob.

Webhook sử dụng idempotency key. Event lỗi tạm thời ở trạng thái `FAILED` được thử
lại khi PayOS gửi lại; event đã `PROCESSED` hoặc `REJECTED` không chạy nghiệp vụ lần hai.

## Deploy Render

Migration `20261010090000_payment_mismatch_attention` chỉ bổ sung hai enum value,
không xoá hoặc sửa dữ liệu cũ. Render chạy migration bằng lệnh hiện có:

```bash
pnpm prisma:migrate:deploy
```

FE cần generate/cập nhật kiểu OpenAPI sau khi Backend deploy để nhận hai enum mới.
