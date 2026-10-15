# Cashier receipt PDF archive

## Mục tiêu

Backend tạo một bản PDF bất biến sau khi đơn tại quầy thanh toán thành công. Cashier, Manager và Owner có quyền trên chi nhánh có thể xem lại hoặc tải PDF từ lịch sử đơn. Đây là **phiếu thanh toán nội bộ**, không phải hóa đơn điện tử theo quy định thuế.

Luồng in nhiệt Bluetooth/ESC-POS hiện có trên Mobile vẫn được giữ nguyên vì nhanh và hoạt động được khi máy in không hỗ trợ PDF. PDF là bản lưu và phương án xem/in lại; Backend không kết nối trực tiếp tới máy in của quán.

## Luồng xử lý

1. Cashier thu tiền mặt, hoặc PayOS/xác nhận tay chuyển khoản thanh toán thành công.
2. Giao dịch thanh toán và đơn được chốt trong transaction như trước.
3. Sau transaction, Backend chụp dữ liệu đã khóa của đơn và sinh PDF phiên bản `1`.
4. PDF được ghi vào local storage khi phát triển hoặc S3-compatible storage trên môi trường deploy.
5. Lỗi sinh/lưu PDF không làm đảo ngược khoản thanh toán. Bản ghi chuyển sang `FAILED` để người dùng gọi API retry.
6. Mobile báo kết quả in vật lý bằng `PRINTED` hoặc `FAILED`; Backend lưu thời điểm hoặc lỗi máy in.

PDF dùng dữ liệu snapshot của `OrderItem`, giá đã chốt, hình thức thanh toán thành công gần nhất, số gọi và QR theo dõi đơn. Cùng một đơn chỉ có một bản phiên bản `1`; các lần gọi đồng thời là idempotent.

## API

Tất cả đường dẫn dưới đây nằm dưới `/api/v1` và cần JWT.

| Method | Path                                                 | Vai trò                 | Ý nghĩa                                      |
| ------ | ---------------------------------------------------- | ----------------------- | -------------------------------------------- |
| `GET`  | `/cashier/orders/:orderId/receipt-document`          | Owner, Manager, Cashier | Lấy trạng thái, metadata và URL tải tạm thời |
| `POST` | `/cashier/orders/:orderId/receipt-document/retry`    | Owner, Manager, Cashier | Sinh lại khi trạng thái là `FAILED`          |
| `GET`  | `/cashier/orders/:orderId/receipt-document/download` | Owner, Manager, Cashier | Tải file khi dùng local storage              |
| `GET`  | `/cashier/orders/:orderId/print-jobs`                | Cashier                 | Xem các lượt in phiếu và phiếu số            |
| `POST` | `/cashier/print-jobs/:printJobId/result`             | Cashier                 | Báo kết quả in vật lý                        |

Ví dụ báo in thành công:

```json
{ "status": "PRINTED" }
```

Ví dụ báo lỗi:

```json
{ "status": "FAILED", "errorMessage": "Không kết nối được máy in Bluetooth" }
```

Kết quả `PRINTED` là trạng thái cuối và không thể đổi ngược thành `FAILED`. Endpoint in lại trả thêm `printJobs` để Mobile lấy đúng ID cần xác nhận.

## Local development

`.env`:

```dotenv
RECEIPT_PDF_ENABLED=true
RECEIPT_STORAGE_PROVIDER=local
RECEIPT_STORAGE_LOCAL_DIR=uploads/receipts
```

Chạy migration và ứng dụng:

```bash
pnpm prisma:migrate:deploy
pnpm start:dev
```

File được lưu dưới `uploads/receipts/` và đã bị `.gitignore` loại khỏi Git. Xóa thư mục này sẽ mất file local nhưng không xóa metadata trong database; khi đó API download trả `404` và cần chuyển bản ghi sang `FAILED`/retry hoặc tạo lại dữ liệu local.

## Render production

Không dùng local storage của Render vì filesystem là tạm thời và file có thể mất khi deploy/restart. Dùng dịch vụ tương thích S3 như AWS S3 hoặc Cloudflare R2.

Thiết lập các biến sau trong Render:

```dotenv
RECEIPT_PDF_ENABLED=true
RECEIPT_STORAGE_PROVIDER=s3
RECEIPT_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
RECEIPT_STORAGE_REGION=auto
RECEIPT_STORAGE_BUCKET=<private-bucket>
RECEIPT_STORAGE_ACCESS_KEY_ID=<secret>
RECEIPT_STORAGE_SECRET_ACCESS_KEY=<secret>
```

Với AWS S3 chuẩn, có thể để `RECEIPT_STORAGE_ENDPOINT` rỗng và đặt region thật, ví dụ `ap-southeast-1`. Bucket phải private. Backend chỉ phát presigned URL có hạn 10 phút; không cấu hình bucket public.

`render.yaml` mặc định để `RECEIPT_PDF_ENABLED=false` nhằm tránh deploy lỗi trước khi nhóm tạo bucket và điền secret. Sau khi điền đủ 5 biến storage, đổi giá trị thành `true` trên Render và redeploy.

## Migration và vận hành

- Migration: `20261016063000_cashier_receipt_documents`.
- Bảng `receipt_documents` giữ trạng thái `PENDING`, `READY`, `FAILED`, checksum SHA-256, kích thước và storage key.
- Không lưu binary PDF trong PostgreSQL.
- Không trả `storageKey` hoặc secret storage cho client.
- Phân quyền luôn kiểm tra phạm vi chi nhánh trước khi trả metadata/file.
- Thanh toán đã thành công không bị thất bại chỉ vì PDF hoặc storage lỗi.

## Việc FE Mobile cần nối

1. Sau khi nhận `printJobs` từ thu tiền hoặc in lại, in theo cách ESC/POS hiện tại.
2. Gọi endpoint `result` cho từng job sau callback thật của thư viện in.
3. Trong lịch sử đơn, gọi `receipt-document`; nếu `READY`, mở `downloadUrl`; nếu `FAILED`, hiện lỗi và nút thử lại.
4. Không tự tạo nội dung PDF khác ở Mobile vì bản lưu phải thống nhất với snapshot Backend.
