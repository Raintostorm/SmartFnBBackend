# Cashier – Barista: Màn gọi số và thẻ rung ảo

## 1. Mục tiêu

Luồng này phục vụ đơn mua tại quầy (`COUNTER_PICKUP`):

1. Cashier chốt đơn và nhận thanh toán tiền mặt hoặc PayOS.
2. Backend cấp số gọi theo ngày, tạo mã theo dõi và chuyển đơn vào hàng pha chế.
3. Mobile POS in số gọi kèm QR theo dõi.
4. Màn TV/tablet hiển thị hai cột **Đang pha** và **Mời nhận**.
5. Khi Barista hoàn thành toàn bộ món, TV và điện thoại khách cùng báo nhận món.
6. Khi Barista xác nhận đã giao, số được loại khỏi TV và trang khách chuyển sang **Đã nhận món**.

Màn gọi số là phương thức chính. Trang theo dõi trên điện thoại là phần mở rộng; hệ thống không điều khiển máy rung phần cứng của bên thứ ba.

## 2. Ánh xạ trạng thái

| Trạng thái Backend       | Màn gọi số     | Trang khách  |
| ------------------------ | -------------- | ------------ |
| `SUBMITTED`              | Đang pha       | Đang pha     |
| `PREPARING`              | Đang pha       | Đang pha     |
| `READY`                  | Mời nhận       | Mời nhận món |
| `DELIVERED`, `COMPLETED` | Không hiển thị | Đã nhận món  |
| `CANCELLED`              | Không hiển thị | Đơn đã huỷ   |

## 3. Dữ liệu và bảo mật token

Migration `20261008140000_order_tracking_and_payment_station` thực hiện:

- Thêm `payments.station_id` để PayOS giữ đúng quầy tạo giao dịch và tạo PrintJob sau webhook.
- Thêm bảng `order_tracking_tokens` liên kết một-một với `orders`.
- Chỉ lưu salt và SHA-256 hash của token, không lưu bearer token gốc.
- Token được dựng bằng HMAC-SHA256 từ `orderId`, salt ngẫu nhiên và `ORDER_TRACKING_SECRET`.

Quy tắc token:

- Có hiệu lực tối đa 36 giờ.
- Sau khi giao món, khách còn xem trạng thái cuối trong 30 phút.
- API public giới hạn 30 request/phút/IP và đặt `Cache-Control: no-store`.
- API không trả danh sách món, số tiền, phương thức thanh toán, nhân viên hoặc ID nội bộ.

## 4. API Backend

### Theo dõi đơn công khai

```http
GET /api/v1/public/track/:token
```

Response chính:

```json
{
  "callNumber": 23,
  "status": "READY",
  "displayStatus": "READY_FOR_PICKUP",
  "branch": { "name": "Chi nhánh Quận 1" },
  "branding": {
    "displayName": "Smart F&B",
    "logoUrl": null,
    "primaryColor": "#0F172A"
  },
  "readyAt": "2026-10-08T10:00:00.000Z",
  "updatedAt": "2026-10-08T10:00:00.000Z",
  "pollAfterSeconds": 4
}
```

Mã phản hồi:

- `200`: token hợp lệ.
- `404`: token sai hoặc không tồn tại.
- `410`: token hết hạn hoặc bị thu hồi.
- `429`: gọi quá giới hạn.

### Snapshot màn gọi số

```http
GET /api/v1/public/calling-display/context
Authorization: Bearer <device-token>
```

Response gồm branding, `preparing[]`, `ready[]` và `serverTime`. Mỗi cột giới hạn 30 đơn của ngày kinh doanh hiện tại và đúng chi nhánh đã ghép.

Endpoint cũ `GET /api/v1/public/calling-display/ready-orders` được giữ để tương thích.

### Receipt

```http
GET /api/v1/cashier/orders/:orderId/receipt
```

Response có thêm:

```json
{
  "tracking": {
    "token": "...",
    "url": "https://<web-domain>/t/<token>"
  }
}
```

### PayOS

Request tạo QR cần thêm `stationId`:

```json
{
  "stationId": "uuid",
  "cancelUrl": "https://...",
  "returnUrl": "https://..."
}
```

Khi webhook PayOS hợp lệ:

- Payment chuyển `SUCCESS`.
- Đơn được cấp số gọi và tracking token.
- Món được đưa vào hàng Barista.
- Tạo PrintJob `RECEIPT` và `QUEUE_TICKET` theo station đã lưu.
- Webhook trùng không tạo dữ liệu lần hai.

## 5. Realtime

Màn gọi số dùng Socket.IO namespace `/operations` và phòng của chi nhánh đã ghép.

| Event                     | Ý nghĩa                                     |
| ------------------------- | ------------------------------------------- |
| `calling.order.queued`    | Đơn vừa thanh toán, vào cột Đang pha        |
| `calling.order.preparing` | Barista bắt đầu pha                         |
| `calling.order.ready`     | Tất cả món hoàn thành, chuyển sang Mời nhận |
| `calling.order.delivered` | Đã giao cho khách, loại khỏi TV             |

REST snapshot vẫn là nguồn khôi phục sau tải lại hoặc mất socket. Web gọi lại snapshot mỗi 5 giây làm phương án dự phòng.

## 6. FE Web

### Màn gọi số

```text
/display/call
```

- Tự tạo mã ghép loại `CALLING_DISPLAY`.
- Manager nhập mã để gắn màn hình vào chi nhánh.
- Lưu device token trong localStorage của trình duyệt màn hình.
- Hiển thị branding và hai cột Đang pha/Mời nhận.
- Có nút bật âm thanh do trình duyệt yêu cầu tương tác người dùng trước khi phát âm.
- Socket cập nhật nhanh, polling 5 giây dùng để tự phục hồi.

### Trang theo dõi khách

```text
/t/:token
```

- Không cần đăng nhập.
- Polling theo `pollAfterSeconds` từ Backend.
- Nút **Bấm để bật thông báo** mở quyền phát âm và yêu cầu Wake Lock nếu trình duyệt hỗ trợ.
- Khi `READY`, trang đổi màu, phát âm và gọi `navigator.vibrate` trên thiết bị hỗ trợ.
- iPhone Safari có thể phát âm nhưng không hỗ trợ rung web.
- Khi `DELIVERED` hoặc `CANCELLED`, trang dừng polling.

## 7. FE Mobile Cashier

- Gửi `stationId` khi tạo PayOS QR.
- Sau thanh toán tiền mặt, lấy tracking URL ngay từ response.
- Sau PayOS, khi polling thấy đơn đã `PAID`, gọi receipt để lấy tracking URL.
- Hiện QR theo dõi trên màn hình thành công và phiếu số.
- QR PayOS dùng để thanh toán; QR tracking chỉ xuất hiện sau khi đã thanh toán.
- Khi xem lại/in lại đơn, Mobile dùng lại URL hiện tại, không sinh token mới.

## 8. Biến môi trường

Backend local:

```dotenv
PUBLIC_WEB_URL=http://localhost:8443
ORDER_TRACKING_SECRET=replace_with_an_independent_random_secret_at_least_32_characters
```

Backend Render:

```dotenv
PUBLIC_WEB_URL=https://<domain-fe-web>
ORDER_TRACKING_SECRET=<secret-random-rieng-toi-thieu-32-ky-tu>
```

Không dùng lại `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PAYOS_MASTER_KEY`, API Key hoặc Checksum Key.

Nếu đổi `ORDER_TRACKING_SECRET`, toàn bộ QR tracking đang còn hiệu lực sẽ không dùng được; vì vậy phải giữ nguyên secret qua các lần deploy.

## 9. Trình tự deploy

1. Đặt `PUBLIC_WEB_URL` và `ORDER_TRACKING_SECRET` trên Render.
2. Deploy Backend; `render:start` chạy Prisma migration trước khi khởi động API.
3. Deploy FE Web để route `/display/call` và `/t/:token` có địa chỉ công khai.
4. Build/deploy Mobile mới vì API tạo PayOS đã yêu cầu `stationId`.
5. Ghép màn gọi số lại nếu trình duyệt TV chưa có device token.

## 10. Kịch bản kiểm thử tích hợp

### Tiền mặt

1. Cashier tạo và thanh toán đơn bằng tiền mặt.
2. Xác nhận có số gọi và QR tracking.
3. TV đưa số vào Đang pha.
4. Quét QR bằng điện thoại.
5. Barista bắt đầu và hoàn thành toàn bộ món.
6. TV chuyển số sang Mời nhận; điện thoại đổi trạng thái và phát báo.
7. Barista bấm Đã giao; TV bỏ số và điện thoại hiện Đã nhận món.

### PayOS

1. Cashier chọn quầy và tạo QR PayOS.
2. Thanh toán test và chờ webhook thành công.
3. Xác nhận đơn có số gọi, tracking QR và hai PrintJob.
4. Thực hiện phần Barista giống luồng tiền mặt.

### Trường hợp lỗi

- Token sai trả `404`.
- Token hết hạn trả `410`.
- Quá 30 request/phút/IP trả `429`.
- Device token màn gọi số sai hoặc đã thu hồi bị từ chối.
- Web tải lại hoặc socket mất kết nối vẫn khôi phục đúng hai cột từ snapshot.

## 11. Kiểm tra tự động đã chạy

- Backend: build thành công, Prisma schema hợp lệ, 114/114 test pass.
- FE Web: production build thành công, 368/368 test pass.
- FE Mobile: TypeScript pass; ESLint không có error, còn ba warning cũ trong `src/i18n/index.ts`.
