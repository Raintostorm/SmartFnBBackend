# Swagger / OpenAPI V9

Swagger là tài liệu sinh trực tiếp từ controller đang chạy, không duy trì một danh sách endpoint viết tay riêng.

## Đường dẫn

- Giao diện: `/api/docs`
- OpenAPI JSON: `/api/docs-json`
- API nghiệp vụ: `/api/v1`

Có thể đổi đường dẫn hoặc tắt Swagger bằng `SWAGGER_PATH` và `SWAGGER_ENABLED`.

## Nhóm nghiệp vụ

Các tag được sắp theo luồng sử dụng: Public/Auth → Admin → Owner → Manager → Cashier → Barista → Waiter/Kitchen. Tên tag trong controller phải trùng với danh sách tại `src/swagger.setup.ts`.

Luồng quầy V9:

1. Cashier tạo hoặc checkout đơn.
2. Cashier chốt đơn và nhận tiền mặt hoặc tạo QR PayOS.
3. Webhook PayOS phải qua kiểm tra chữ ký và số tiền.
4. Đơn đã thanh toán được cấp số gọi và vào hàng chờ Barista.
5. Barista nhận mẻ, pha chế, hoàn tác trong thời gian cho phép và giao đơn.

## Quy tắc khi thêm endpoint

1. Body phải dùng DTO có validation và ví dụ Swagger.
2. Mỗi endpoint phải có `ApiOperation` mô tả ngắn, rõ trạng thái đầu vào.
3. Route có UUID dùng `ApiUuidPath` và `ParseUUIDPipe`.
4. Route cần JWT dùng `ApiBearerAuth` và `ApiAuthenticatedOperation`.
5. Route màn hình dùng security scheme `display-device-token`.
6. Không đưa API key, checksum key, token hoặc dữ liệu Prisma nội bộ vào response mẫu.
7. Route cũ đã xóa khỏi controller thì không được giữ lại dưới dạng tài liệu thủ công.

## Mã phản hồi

- `200`: đọc hoặc cập nhật thành công.
- `201`: tạo tài nguyên hoặc hoàn tất lệnh chuyển trạng thái.
- `400`: body, UUID hoặc quy tắc nghiệp vụ không hợp lệ.
- `401`: token/chữ ký thiếu hoặc không hợp lệ.
- `403`: sai vai trò, chi nhánh hoặc phạm vi chuỗi.
- `404`: tài nguyên không tồn tại trong phạm vi được phép.
- `409`: trạng thái hiện tại không cho phép thao tác hoặc có tranh chấp đồng thời.

Sau khi sửa Swagger, chạy `pnpm prisma:generate`, `pnpm typecheck` và `pnpm test`.
