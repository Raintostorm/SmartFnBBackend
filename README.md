# Smart F&B Chain Platform — Backend

Bộ khung backend cho **Smart F&B Chain Platform (SP26SE123)**, sử dụng NestJS,
TypeScript, Prisma ORM và PostgreSQL.

## Yêu cầu

- Node.js 24.15+
- pnpm 11+
- Docker Desktop / Docker Engine có Docker Compose

## Chạy lần đầu

```bash
pnpm install
pnpm db:up
pnpm prisma:migrate --name init
pnpm prisma:seed
pnpm start:dev
```

API kiểm tra trạng thái: `GET http://localhost:3100/api/v1/health`

## Chạy đồng nhất bằng Docker

```bash
pnpm docker:up
```

Lệnh này build NestJS bằng Node.js 24, khởi động cả API và PostgreSQL, chạy Prisma
migration/seed tự động rồi mở API tại `http://localhost:3100`. Xem log API bằng
`pnpm docker:logs`.

Khi deploy Railway, dùng `Dockerfile` cho service BE và tạo PostgreSQL thành một
managed service riêng. Đặt `DATABASE_URL` của BE tham chiếu tới `DATABASE_URL`
của PostgreSQL; không dùng địa chỉ `127.0.0.1` trên Railway.

## Swagger / OpenAPI

Sau khi chạy backend, FE có thể xem và thử API trực tiếp tại:

- Swagger UI: `http://localhost:3100/api/docs`
- OpenAPI JSON: `http://localhost:3100/api/docs-json`

Với API được bảo vệ, đăng nhập để lấy `accessToken`, bấm **Authorize** trên Swagger
UI và nhập token. Swagger sẽ tự gửi header `Authorization: Bearer <token>`.
Có thể tắt tài liệu bằng `SWAGGER_ENABLED=false` hoặc đổi đường dẫn bằng
`SWAGGER_PATH`; Swagger mặc định bị tắt trong production nếu không cấu hình rõ.

## Authentication và phân quyền

Hệ thống dùng access token JWT ngắn hạn và refresh token luân phiên. Mật khẩu được
băm bằng Argon2id; refresh token chỉ được lưu trong database dưới dạng SHA-256.
Mọi API mặc định đều yêu cầu `Authorization: Bearer <accessToken>`, trừ các route
được khai báo public.

| Method  | Endpoint                       | Quyền                                                       |
| ------- | ------------------------------ | ----------------------------------------------------------- |
| `POST`  | `/api/v1/auth/register`        | Public, luôn tạo `CUSTOMER`                                 |
| `POST`  | `/api/v1/auth/login`           | Public                                                      |
| `POST`  | `/api/v1/auth/refresh`         | Public, đổi refresh token một lần                           |
| `POST`  | `/api/v1/auth/logout`          | Public, thu hồi session bằng refresh token                  |
| `POST`  | `/api/v1/auth/logout-all`      | Đã đăng nhập                                                |
| `GET`   | `/api/v1/auth/me`              | Đã đăng nhập                                                |
| `POST`  | `/api/v1/auth/staff`           | Chỉ `ADMIN`; tạo `WAITER`, `KITCHEN`, `CASHIER`             |
| `PATCH` | `/api/v1/users/:userId/status` | Chỉ `ADMIN`; cập nhật `ACTIVE`, `INACTIVE` hoặc `SUSPENDED` |

Các role ứng dụng: `ADMIN`, `WAITER`, `KITCHEN`, `CASHIER`, `CUSTOMER`. Gắn
`@Roles(AppRole.ADMIN, ...)` vào controller/handler để giới hạn route theo role;
route public phải được gắn `@Public()` một cách tường minh.

Không có API đăng ký `ADMIN`. Để tạo tài khoản quản trị đầu tiên, điền tạm
`SEED_ADMIN_EMAIL` và `SEED_ADMIN_PASSWORD` trong `.env`, chạy `pnpm prisma:seed`,
sau đó xóa mật khẩu bootstrap khỏi môi trường. Seed không thay đổi mật khẩu nếu
email đó đã tồn tại.

## Cấu trúc chính

```text
prisma/
  schema.prisma       Database schema
  seed.ts             Dữ liệu Role mặc định
src/
  config/             Kiểm tra biến môi trường
  database/           PrismaModule và PrismaService
  generated/prisma/   Prisma Client được generate, không commit
  modules/             Các module nghiệp vụ
```

## Các bảng nền

- `roles`: vai trò dùng cho RBAC.
- `users`: tài khoản đăng nhập; mỗi tài khoản có một vai trò.
- `branches`: thông tin chi nhánh nhà hàng.
- `employees`: hồ sơ nhân viên; liên kết 1–1 với User và thuộc một Branch.
- `customers`: hồ sơ khách hàng; liên kết 1–1 với User và lưu điểm/tier loyalty.
- `restaurant_tables`: bàn ăn theo từng chi nhánh.
- `reservations`: lịch đặt bàn của thành viên hoặc khách vãng lai.
- `menu_categories`, `menu_items`: danh mục và món ăn theo chi nhánh.
- `orders`, `order_items`: đơn hàng và snapshot món tại thời điểm đặt.
- `payments`: các lần thanh toán hoặc hoàn tiền của đơn hàng.
- `vouchers`: voucher toàn chuỗi hoặc giới hạn theo chi nhánh.
- `loyalty_points`: sổ giao dịch điểm của khách hàng.
- `attendances`: chấm công theo nhân viên, chi nhánh và ngày làm việc.

## Lệnh hữu ích

```bash
pnpm db:up                 # Khởi động PostgreSQL
pnpm db:down               # Dừng PostgreSQL
pnpm prisma:generate       # Generate Prisma Client
pnpm prisma:migrate        # Tạo/chạy migration trong môi trường dev
pnpm prisma:migrate:deploy # Chạy migration đã có trong production
pnpm prisma:studio         # Mở Prisma Studio
pnpm test                  # Chạy unit test
pnpm test:e2e              # Chạy kiểm thử luồng auth với PostgreSQL local
pnpm build                 # Build production
```

Thông tin kết nối local nằm trong `.env`. Khi triển khai thật, thay toàn bộ mật khẩu mặc định.
