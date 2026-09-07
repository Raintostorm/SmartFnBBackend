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
pnpm build                 # Build production
```

Thông tin kết nối local nằm trong `.env`. Khi triển khai thật, thay toàn bộ mật khẩu mặc định.
