# Owner – poster cho màn hình phụ thu ngân

Phạm vi: API BE và app `smart_fnb_cashier_backscreen_version`; chưa có giao diện quản lý trên web Owner.

## API

Tiền tố: `/api/v1/restaurant-chains/{chainId}/display-posters`.
Đăng nhập OWNER và gửi Bearer access token. Chỉ Owner được gán vào chuỗi mới truy cập; ADMIN, Manager, Cashier và thiết bị không được quản lý poster.

| Method | Đường dẫn     | Công dụng                                                        |
| ------ | ------------- | ---------------------------------------------------------------- |
| GET    | `/`           | Danh sách poster chưa xóa, gồm cả đang tắt, theo thứ tự hiển thị |
| POST   | `/`           | Multipart field `file`: tải ảnh JPEG/PNG/WebP, tối đa 5 MB       |
| PATCH  | `/{posterId}` | JSON: `title`, `enabled`, `sortOrder`, `durationSeconds`         |
| DELETE | `/{posterId}` | Xóa mềm; dừng hiển thị ở lần đồng bộ kế tiếp                     |

Tối đa 10 poster chưa xóa mỗi chuỗi (kể cả đang tắt). Upload mới mặc định bật, tên `Poster`, thời lượng 8 giây. Đổi ảnh bằng tải poster mới và xóa poster cũ; không nhận URL tùy ý để thay cho upload. Nếu đủ 10 ảnh, xóa một ảnh trước khi tải mới.

Ví dụ PATCH:

```json
{
  "title": "Khuyến mãi tháng 10",
  "enabled": true,
  "sortOrder": 0,
  "durationSeconds": 12
}
```

`title`: 1–120 ký tự; `sortOrder`: số nguyên 0–10000, nhỏ trước; trùng thứ tự thì theo ngày tạo và ID. `durationSeconds`: số nguyên 3–60. Không chấp nhận null, JSON rỗng hoặc trường lạ. Đổi thứ tự bằng PATCH vị trí từng ảnh (không có thao tác reorder nguyên danh sách nguyên tử).

Gói hết hạn/tạm ngưng: không được upload/sửa/xóa; Owner vẫn đọc được nếu chuỗi còn active. Chưa bổ sung một feature flag hoặc phí gói mới cho poster.

## Backscreen

`GET /api/v1/public/customer-display/context` dùng **device token đã ghép** (không phải token Owner) trả thêm:

```json
{
  "posters": [
    {
      "id": "uuid",
      "title": "Khuyến mãi tháng 10",
      "imageUrl": "/uploads/posters/chain-random.png",
      "durationSeconds": 12
    }
  ]
}
```

Chỉ trả ảnh đang bật, chưa xóa của chuỗi chứa quầy đã ghép. Không nhận chainId từ thiết bị. Danh sách dùng chung mọi chi nhánh/quầy trong chuỗi, không áp dụng màn hình gọi số.

App ghép URL ảnh tương đối với origin của `EXPO_PUBLIC_API_BASE_URL`, không ghép với `/api/v1`. Khi chạy máy thật, dùng IP LAN/domain BE, không dùng `localhost` của máy tính.

App cập nhật poster khi kết nối lại và mỗi 60 giây khi app đang hoạt động (không push tức thì). Poster không phụ thuộc `cartVersion`, không reset giỏ/QR. Gỡ ghép hoặc đổi thiết bị không hiển thị poster của token cũ. Mất mạng giữ danh sách cuối trong RAM; ảnh đã tải có cache. Khởi động lại offline dùng poster mặc định, chưa có lưu danh sách offline lâu dài.

Giữ layout chờ/giỏ hiện có, ảnh `contain` để không cắt chữ. BE cũ thiếu `posters`, danh sách rỗng/tắt hết, URL không hợp lệ hoặc ảnh tải lỗi đều có poster đi kèm app làm dự phòng. Khi hệ điều hành bật reduced motion, dừng xoay ảnh và hiệu ứng phóng.

## Lưu trữ và triển khai

- Migration: `20261013110000_display_posters` (chỉ thêm bảng).
- Chạy `pnpm prisma:generate`, `pnpm prisma:migrate:deploy`, `pnpm build`, khởi động lại BE.
- Ảnh ở `${UPLOAD_DIR:-uploads}/posters`, được phục vụ công khai dưới `/uploads/posters/` (nội dung quảng cáo không phải tài liệu bí mật).
- Docker Compose hiện có volume `smart_fnb_uploads`; cần giữ volume. Khi dùng Render phải mount persistent disk vào `UPLOAD_DIR`, hoặc đổi sang object storage trước khi dùng production. Không dựa vào filesystem tạm của container.
- Xóa mềm giữ file để tránh lỗi trên máy còn cache context cũ. Chưa có job dọn ảnh đã xóa; cần theo dõi dung lượng. Upload thất bại do DB/quota sẽ dọn file mới.
- Chỉ kiểm tra MIME, dung lượng và chữ ký đầu file; không tái mã hóa ảnh. Backscreen xử lý fallback nếu decoder không đọc được file.

## Kiểm thử

BE: `pnpm build` rồi `node scripts/test-posters.mjs` (PostgreSQL local đang chạy). Script tạo DB tạm, áp toàn bộ migrations, kiểm thử HTTP/quyền/tenant/quota đồng thời/ảnh tĩnh/device context rồi dọn DB và ảnh test. Không seed hoặc thay đổi DB ứng dụng.

Backscreen: `pnpm exec tsc --noEmit`, `pnpm lint`, `node --test test/poster-data.test.mjs` (Node hỗ trợ strip TypeScript), `pnpm exec expo export --platform web`.

Test thủ công: upload 2 ảnh bằng Swagger → PATCH thời lượng/vị trí → ghép backscreen với quầy của chuỗi → kiểm tra sau 60 giây ở màn hình chờ và cạnh giỏ → tắt/xóa hết để thấy fallback → gỡ ghép và ghép chuỗi khác → kiểm tra không giữ ảnh chuỗi cũ.
