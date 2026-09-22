# Smart F&B Chain Platform — Backend

Bộ khung backend cho **Smart F&B Chain Platform (SP26SE123)**, sử dụng NestJS,
TypeScript, Prisma ORM và PostgreSQL.

## Yêu cầu

- Node.js 24.15+
- pnpm 11+
- Docker Desktop / Docker Engine có Docker Compose

## Chạy lần đầu

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:up
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm prisma:seed
pnpm start:dev
```

Trên macOS/Linux, thay lệnh đầu bằng `cp .env.example .env`. Không chạy
`prisma migrate --name init` trên máy mới vì repository đã có sẵn lịch sử migration.
Chỉ người thay đổi `prisma/schema.prisma` mới tạo migration mới; các thành viên còn
lại dùng `pnpm prisma:migrate:deploy` sau khi pull.

API kiểm tra trạng thái: `GET http://localhost:3100/api/v1/health`

## Chạy đồng nhất bằng Docker

```bash
cp .env.example .env # PowerShell: Copy-Item .env.example .env
pnpm docker:up
```

Lệnh này build NestJS bằng Node.js 24, khởi động cả API và PostgreSQL, chạy Prisma
migration/seed tự động rồi mở API tại `http://localhost:3100`. Xem log API bằng
`pnpm docker:logs`.

Khi deploy Render/Railway, dùng `Dockerfile` cho service BE và dùng PostgreSQL
managed (ví dụ Neon) làm database riêng. Đặt `DATABASE_URL` của BE bằng connection
string PostgreSQL; không dùng địa chỉ `127.0.0.1` trên môi trường deploy.

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

| Method  | Endpoint                       | Quyền                                                             |
| ------- | ------------------------------ | ----------------------------------------------------------------- |
| `POST`  | `/api/v1/auth/login`           | Public                                                            |
| `POST`  | `/api/v1/auth/refresh`         | Public, đổi refresh token một lần                                 |
| `POST`  | `/api/v1/auth/logout`          | Public, thu hồi session bằng refresh token                        |
| `POST`  | `/api/v1/auth/logout-all`      | Đã đăng nhập                                                      |
| `GET`   | `/api/v1/auth/me`              | Đã đăng nhập                                                      |
| `POST`  | `/api/v1/auth/managers`        | `ADMIN` hoặc `OWNER`; tạo `MANAGER` cho đúng một chi nhánh        |
| `POST`  | `/api/v1/auth/staff`           | Endpoint cũ; `OWNER` chỉ tạo `MANAGER`, nên dùng `/auth/managers` |
| `PATCH` | `/api/v1/users/:userId/status` | Chỉ `ADMIN`; cập nhật `ACTIVE`, `INACTIVE` hoặc `SUSPENDED`       |

Các role ứng dụng: `ADMIN`, `OWNER`, `MANAGER`, `WAITER`, `KITCHEN`, `CASHIER`.
Gắn `@Roles(AppRole.ADMIN, ...)` vào controller/handler để giới hạn
route theo role; route public phải được gắn `@Public()` một cách tường minh.

## Quản lý chuỗi nhà hàng

| Nhóm API       | ADMIN           | OWNER                                                    | MANAGER                                                      | WAITER                  | KITCHEN                         | CASHIER                 | Public                   |
| -------------- | --------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ----------------------- | ------------------------------- | ----------------------- | ------------------------ |
| Chuỗi nhà hàng | Quản lý tất cả  | Xem phạm vi qua các chi nhánh; không sửa thông tin chuỗi | Không                                                        | Không                   | Không                           | Không                   | Xem chuỗi active         |
| Chi nhánh      | Quản lý tất cả  | Quản lý mọi chi nhánh thuộc các chuỗi được giao          | Quản lý đúng một chi nhánh, không được chuyển thành INACTIVE | Chỉ xem chi nhánh chính | Chỉ xem chi nhánh chính         | Chỉ xem chi nhánh chính | Xem chi nhánh active     |
| Giờ hoạt động  | Xem và cấu hình | Xem và cấu hình toàn bộ chi nhánh thuộc chuỗi            | Xem và cấu hình chi nhánh được giao                          | Xem                     | Xem                             | Xem                     | Xem giờ công khai        |
| Khu vực        | Quản lý tất cả  | Quản lý khu vực trong các chuỗi được giao                | Quản lý khu thuộc chi nhánh được giao                        | Xem dining/pickup       | Xem kitchen/bar, đổi trạng thái | Xem cashier/pickup      | Xem dining/pickup active |

Các endpoint được mô tả đầy đủ trên Swagger. Nhóm chính là
`/api/v1/restaurant-chains`, `/api/v1/branches` và `/api/v1/public/branches`.
Owner được tạo sau khi Platform Admin phê duyệt hồ sơ đăng ký. OWNER tạo MANAGER qua
`POST /api/v1/auth/managers`; hệ thống chỉ chấp nhận chi nhánh thuộc chuỗi của OWNER.
Mỗi MANAGER chỉ quản lý `Employee.branchId` của mình.

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

Data dictionary đầy đủ (từng bảng, cột, lý do tồn tại và khóa ngoại) nằm tại
[`docs/database-dictionary.md`](docs/database-dictionary.md). Chạy
`node scripts/generate-database-dictionary.mjs` sau khi sửa Prisma schema để cập nhật tài liệu.

- `roles`: vai trò dùng cho RBAC.
- `users`: tài khoản đăng nhập; mỗi tài khoản có một vai trò.
- `branches`: thông tin chi nhánh nhà hàng.
- `restaurant_chains`: thông tin thương hiệu/chuỗi sở hữu các chi nhánh.
- `branch_operating_hours`, `branch_special_hours`: lịch mở cửa định kỳ và ngày đặc biệt.
- `branch_areas`: khu phục vụ, bếp, bar, thu ngân và nhận món theo chi nhánh.
- `owners`: hồ sơ chủ sở hữu; liên kết 1–1 với User.
- `owner_chain_assignments`: các chuỗi nhà hàng được ADMIN giao cho OWNER.
- `employees`: hồ sơ nhân viên; liên kết 1–1 với User và thuộc một Branch.
- `restaurant_tables`: bàn ăn theo từng chi nhánh.
- `reservations`: lịch đặt bàn theo thông tin khách vãng lai.
- `menu_categories`, `menu_items`: danh mục và món ăn dùng chung ở cấp chuỗi.
- `orders`, `order_items`: đơn hàng và snapshot món tại thời điểm đặt.
- `table_sessions`, `table_session_tables`: phiên phục vụ tại bàn; một phiên có thể
  ghép nhiều bàn và chứa nhiều lần gọi món.
- `table_adjacencies`: quan hệ bàn liền kề dùng khi Waiter cần ghép bàn.
- `branch_menu_items`: trạng thái bán và số phần còn lại của món tại từng chi nhánh.
- `serving_tasks`: hàng đợi món đã sẵn sàng, hỗ trợ Waiter nhận việc và xác nhận đã phục vụ.
- `work_sessions`: phiên làm việc thực tế; dùng để giới hạn thông báo thời gian thực cho
  Waiter/Kitchen Staff đang trong ca.
- `payments`: các lần thanh toán hoặc hoàn tiền của đơn hàng.
- `vouchers`: voucher toàn chuỗi hoặc giới hạn theo chi nhánh.
- `attendances`: chấm công theo nhân viên, chi nhánh và ngày làm việc.

### Luồng dữ liệu Waiter và Kitchen Staff

```text
restaurant_tables
  -> table_session_tables
  -> table_sessions
  -> orders
  -> order_items
  -> serving_tasks
```

Kitchen Staff xử lý từng `order_item` từ `QUEUED` sang `PREPARING`, rồi `READY`.
Khi món sẵn sàng, hệ thống tạo đúng một `serving_task`; Waiter nhận task theo cơ chế
first-claim-wins và xác nhận `SERVED`. Trạng thái sẵn bán và số phần còn lại được quản
lý riêng theo chi nhánh trong `branch_menu_items`, không sửa trực tiếp menu gốc.

### Dữ liệu demo Waiter và Kitchen Staff

Để có dữ liệu kiểm tra trong PostgreSQL/pgAdmin, cấu hình local:

```dotenv
SEED_DEMO_DATA=true
SEED_DEMO_PASSWORD=your_local_demo_password
```

Sau đó chạy `pnpm prisma:seed`. Seed có thể chạy lại nhiều lần mà không nhân đôi dữ liệu.
Mật khẩu phải dài tối thiểu 12 ký tự và có chữ hoa, chữ thường, chữ số. Seed tạo
chi nhánh, khu vực, bốn bàn và quan hệ liền kề, menu/tồn món, một Owner, một Manager,
một Waiter, một Kitchen Staff, hai ca đang hoạt động, một phiên bàn, một order,
hai order item, một serving task và một payment đang chờ. Các tài khoản demo là:

- `owner.demo@smartfnb.local`
- `manager.demo@smartfnb.local`
- `waiter.demo@smartfnb.local`
- `kitchen.demo@smartfnb.local`

Tất cả dùng `SEED_DEMO_PASSWORD`. Không bật `SEED_DEMO_DATA` ở production.

## Lệnh hữu ích

```bash
pnpm db:up                 # Khởi động PostgreSQL
pnpm db:down               # Dừng PostgreSQL
pnpm prisma:generate       # Generate Prisma Client
pnpm prisma:migrate        # Tạo/chạy migration trong môi trường dev
pnpm prisma:migrate:deploy # Chạy migration đã có trong production
pnpm prisma:studio         # Mở Prisma Studio
pnpm test                  # Chạy unit test
pnpm test:e2e              # Chạy kiểm thử auth, chi nhánh, Swagger và flow Waiter/Kitchen
pnpm build                 # Build production
```

Thông tin kết nối local nằm trong `.env`. Khi triển khai thật, thay toàn bộ mật khẩu mặc định.
