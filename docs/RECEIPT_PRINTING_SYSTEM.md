# Hệ thống lưu và in phiếu thanh toán Cashier

## 1. Phạm vi

Hệ thống phục vụ đơn `COUNTER_PICKUP` của Cashier và gồm hai luồng bổ trợ nhau:

1. **In vận hành tại quầy:** Mobile tạo nội dung phù hợp máy in nhiệt và gửi qua Bluetooth/ESC-POS. Luồng này ưu tiên tốc độ và có thể tiếp tục dùng trong mạng nội bộ.
2. **Lưu PDF bất biến:** Backend sinh PDF từ dữ liệu đơn đã thanh toán, lưu vào kho file bền vững và cho phép xem/in lại từ lịch sử.

Backend không điều khiển máy in Bluetooth trực tiếp. Mobile chịu trách nhiệm giao tiếp phần cứng và báo kết quả in về Backend. PDF là phiếu thanh toán nội bộ, không thay thế hóa đơn điện tử hợp pháp.

## 2. Thành phần

| Thành phần               | Trách nhiệm                                                                |
| ------------------------ | -------------------------------------------------------------------------- |
| Cashier Mobile           | Tạo đơn, thu tiền, in nhiệt, báo kết quả in, mở PDF lịch sử                |
| Payment services         | Chốt tiền mặt, PayOS hoặc xác nhận tay theo cùng một luồng thanh toán      |
| Receipt document service | Chụp snapshot đơn, điều phối sinh PDF, quản lý trạng thái và retry         |
| PDF renderer             | Kết xuất tiếng Việt, món, tùy chọn, tiền thanh toán, số gọi và QR theo dõi |
| Receipt storage          | Ghi/đọc local khi phát triển hoặc S3-compatible storage khi production     |
| PostgreSQL               | Lưu metadata PDF và nhật ký các lượt in; không lưu binary PDF              |
| Manager/Owner Web        | Tra cứu đơn trong phạm vi được phép và mở PDF đã lưu                       |

## 3. Luồng tổng thể

```text
Cashier Mobile
    |
    | thanh toán tiền mặt / tạo QR
    v
Backend Payment Flow -----> PostgreSQL
    |                         - Order = PAID
    |                         - Payment = SUCCESS
    |                         - PrintJob = PENDING
    |
    | sau khi transaction thành công
    v
Receipt Document Service
    |---- chụp dữ liệu đơn đã khóa
    |---- tạo QR theo dõi đơn
    |---- sinh PDF phiên bản 1
    v
Local storage (dev) hoặc S3/R2 (Render)
    |
    v
ReceiptDocument = READY

Cashier Mobile ---- Bluetooth/ESC-POS ----> Máy in nhiệt
    |
    +---- POST kết quả PRINTED/FAILED ----> PrintJob
```

PDF được tạo sau khi transaction thanh toán đã commit. Vì vậy lỗi font, tạo QR hoặc storage không được phép đảo ngược khoản thanh toán của khách.

## 4. Dữ liệu và trạng thái

### ReceiptDocument

Mỗi đơn có tối đa một tài liệu ở từng `version`. Phiên bản hiện tại là `1`.

| Trạng thái | Ý nghĩa                                           |
| ---------- | ------------------------------------------------- |
| `PENDING`  | Đã tạo metadata và đang/chưa bắt đầu kết xuất     |
| `READY`    | PDF đã lưu thành công và có thể tải               |
| `FAILED`   | Kết xuất hoặc lưu file thất bại; giữ lỗi để retry |

Thông tin lưu gồm `storageKey`, tên file, MIME type, kích thước, checksum SHA-256, thời điểm sinh và lỗi gần nhất. Binary không được lưu trong PostgreSQL.

### PrintJob

Mỗi lần cần in phiếu thanh toán hoặc phiếu số tạo một `PrintJob`.

| Trạng thái  | Ý nghĩa                                              |
| ----------- | ---------------------------------------------------- |
| `PENDING`   | Mobile chưa báo kết quả                              |
| `PRINTED`   | Máy in xác nhận thành công; có `printedAt`           |
| `FAILED`    | In thất bại; có `errorMessage`, có thể thử in lại    |
| `CANCELLED` | Job bị hủy theo nghiệp vụ và không được cập nhật lại |

`PRINTED` là trạng thái cuối. Xử lý cập nhật dùng điều kiện trạng thái để tránh một request lỗi chạy đồng thời ghi đè kết quả in thành công.

## 5. Snapshot PDF

PDF lấy dữ liệu đã chốt trên đơn, không đọc lại giá hiện tại từ menu:

- mã đơn, thời gian thanh toán và số gọi;
- thương hiệu, chi nhánh, địa chỉ và điện thoại;
- Cashier tạo đơn;
- tên món, số lượng, đơn giá, tùy chọn và ghi chú;
- tổng tiền, hình thức thanh toán, tiền khách đưa và tiền thừa;
- QR theo dõi trạng thái nhận món nếu đơn có tracking token;
- cảnh báo đây là phiếu thanh toán nội bộ.

Nhờ vậy, việc Owner đổi tên món hoặc giá sau này không làm thay đổi nội dung phiếu cũ.

## 6. API contract

Base path: `/api/v1`.

| Method | Endpoint                                             | Chức năng                          |
| ------ | ---------------------------------------------------- | ---------------------------------- |
| `GET`  | `/cashier/orders/:orderId/receipt-document`          | Trạng thái, metadata và URL tải    |
| `POST` | `/cashier/orders/:orderId/receipt-document/retry`    | Thử tạo lại tài liệu lỗi           |
| `GET`  | `/cashier/orders/:orderId/receipt-document/download` | Stream PDF khi dùng local storage  |
| `GET`  | `/cashier/orders/:orderId/print-jobs`                | Danh sách lượt in của đơn          |
| `POST` | `/cashier/print-jobs/:printJobId/result`             | Mobile báo `PRINTED` hoặc `FAILED` |
| `POST` | `/cashier/orders/:orderId/reprint`                   | Tạo job in lại có lý do audit      |

Cashier chỉ thao tác đơn và job thuộc chi nhánh được gán. Manager và Owner được xem PDF sau khi `BranchAccessService` xác nhận phạm vi chi nhánh/chuỗi.

## 7. Idempotency và xử lý chạy đồng thời

- Unique key `(orderId, version)` ngăn tạo nhiều metadata cho cùng bản PDF.
- Storage key chứa checksum nội dung; hai worker cùng sinh một tài liệu sẽ ghi cùng bytes.
- Nếu một worker lỗi sau khi worker khác đã hoàn thành, trạng thái `READY` không bị đổi ngược thành `FAILED`.
- Kết quả in dùng cập nhật có điều kiện. Báo `PRINTED` lặp lại là idempotent; không cho đổi `PRINTED` sang `FAILED`.
- Retry không tạo version mới và không thay đổi snapshot nghiệp vụ của đơn.

## 8. Phân quyền và bảo mật

- Mọi endpoint tài liệu đều cần JWT.
- Service kiểm tra loại đơn, trạng thái đã thanh toán và quyền truy cập chi nhánh.
- Bucket production phải private.
- Backend không trả `storageKey`, access key hoặc secret key cho client.
- Với S3/R2, client nhận presigned URL hết hạn sau 10 phút.
- File local được stream qua endpoint có kiểm tra JWT và gửi `Cache-Control: private, no-store`.
- Checksum SHA-256 hỗ trợ phát hiện nội dung file không khớp metadata.

## 9. Triển khai

### Local

```dotenv
RECEIPT_PDF_ENABLED=true
RECEIPT_STORAGE_PROVIDER=local
RECEIPT_STORAGE_LOCAL_DIR=uploads/receipts
```

Thư mục `uploads/` nằm ngoài Git. Cách này chỉ dành cho phát triển và test.

### Render

Render có filesystem tạm thời nên production phải dùng S3 hoặc R2:

```dotenv
RECEIPT_PDF_ENABLED=true
RECEIPT_STORAGE_PROVIDER=s3
RECEIPT_STORAGE_ENDPOINT=https://<endpoint>
RECEIPT_STORAGE_REGION=auto
RECEIPT_STORAGE_BUCKET=<private-bucket>
RECEIPT_STORAGE_ACCESS_KEY_ID=<secret>
RECEIPT_STORAGE_SECRET_ACCESS_KEY=<secret>
```

`render.yaml` để tính năng ở trạng thái tắt cho đến khi người quản lý Render điền đủ storage secret. Bật tính năng trước khi có bucket sẽ làm environment validation từ chối khởi động, tránh âm thầm lưu PDF vào ổ đĩa tạm.

## 10. Hành vi khi có lỗi

| Sự cố                              | Hành vi                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| PDF renderer lỗi                   | Thanh toán vẫn thành công; document chuyển `FAILED`     |
| S3/R2 tạm mất kết nối              | Document chuyển `FAILED`; người dùng retry sau          |
| Máy in Bluetooth mất kết nối       | Mobile báo PrintJob `FAILED`; PDF vẫn có thể xem/in lại |
| Mobile gửi kết quả hai lần         | Request thành công lặp lại được xử lý idempotent        |
| Người dùng khác chi nhánh truy cập | Backend từ chối trước khi trả metadata hoặc file        |
| Render restart                     | File không mất vì nằm trong bucket ngoài Render         |

## 11. Trách nhiệm tích hợp của FE

- Mobile tiếp tục dùng ESC/POS cho in tại quầy.
- Mobile lấy `printJobs` trong response thanh toán/in lại và báo kết quả thật của từng job.
- Màn lịch sử gọi API receipt document; hiển thị tải/in khi `READY`, nút thử lại khi `FAILED`, và thông báo cấu hình khi `DISABLED`.
- Web Manager/Owner chỉ dùng URL Backend trả về, không ghép URL bucket hoặc tự truy cập storage.
- FE không tự sinh một bản PDF khác để lưu lịch sử, tránh sai khác với snapshot của Backend.

## 12. Giới hạn hiện tại

- Chỉ áp dụng cho đơn Cashier `COUNTER_PICKUP` đã thanh toán.
- Chưa phải hệ thống hóa đơn điện tử có chữ ký số/mã cơ quan thuế.
- Chưa có worker nền riêng; PDF được sinh sau luồng xác nhận thanh toán và lỗi được tách khỏi kết quả thanh toán.
- Chưa có chính sách xóa/lưu trữ dài hạn theo năm; cần chốt với Owner trước khi thêm lifecycle rule cho bucket.

Chi tiết cấu hình và ví dụ gọi API nằm trong `docs/CASHIER_RECEIPT_PDF.md`.
