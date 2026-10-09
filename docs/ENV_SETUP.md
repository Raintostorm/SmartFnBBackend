# Cấu hình môi trường Smart F&B

Tài liệu này ghi rõ file `.env` cần đặt cho Backend, Web và Mobile. Không commit file chứa secret thật lên GitHub.

## 1. Backend

### Vị trí file

```text
SmartFnBBackend/.env
```

Tạo từ template:

```bash
cd SmartFnBBackend
cp .env.example .env
```

### Cấu hình local đầy đủ

```dotenv
NODE_ENV=development
PORT=3100
API_PREFIX=api/v1
CORS_ORIGIN=http://localhost:8443,http://localhost:5173,http://localhost:8081
SWAGGER_ENABLED=true
SWAGGER_PATH=api/docs

POSTGRES_USER=smartfnb
POSTGRES_PASSWORD=smartfnb_dev_password
POSTGRES_DB=smart_fnb
POSTGRES_PORT=5433
DATABASE_URL=postgresql://smartfnb:smartfnb_dev_password@127.0.0.1:5433/smart_fnb?schema=public

JWT_ACCESS_SECRET=THAY_BANG_CHUOI_NGAU_NHIEN_TOI_THIEU_32_KY_TU
JWT_REFRESH_SECRET=THAY_BANG_CHUOI_KHAC_TOI_THIEU_32_KY_TU
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=604800
JWT_ISSUER=smart-fnb-backend
JWT_AUDIENCE=smart-fnb-client

SEED_ADMIN_EMAIL=
SEED_ADMIN_PASSWORD=
SEED_DEMO_DATA=false
SEED_DEMO_PASSWORD=

OPERATIONS_DEFAULT_PAGE_SIZE=20
OPERATIONS_MAX_PAGE_SIZE=100
OPERATIONS_MAX_ITEMS_PER_ORDER=50
SERVING_TASK_CLAIM_TIMEOUT_SECONDS=300
INVOICE_NUMBER_PREFIX=INV

REALTIME_ENABLED=true
REALTIME_PATH=/socket.io
REALTIME_CORS_ORIGINS=http://localhost:8443,http://localhost:5173,http://localhost:8081

PAYOS_MASTER_KEY=THAY_BANG_KHOA_BASE64_32_BYTE
PAYOS_WEBHOOK_BASE_URL=http://localhost:3100/api/v1
PUBLIC_WEB_URL=http://localhost:8443
ORDER_TRACKING_SECRET=THAY_BANG_SECRET_RIENG_TOI_THIEU_32_KY_TU

# Email mời Cashier/Barista đặt mật khẩu (HTTPS, phù hợp Render)
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_xxxxxxxxx
EMAIL_FROM=Smart F&B <no-reply@domain-da-xac-thuc.example>
```

Tạo các secret local bằng Node.js (mỗi lệnh chạy riêng và sao chép kết quả vào đúng biến):

```bash
# JWT_ACCESS_SECRET
node -e "const c=require('node:crypto'); console.log(c.randomBytes(48).toString('base64url'))"
# JWT_REFRESH_SECRET
node -e "const c=require('node:crypto'); console.log(c.randomBytes(48).toString('base64url'))"
# PAYOS_MASTER_KEY (bắt buộc đúng 32 byte ở dạng base64)
node -e "const c=require('node:crypto'); console.log(c.randomBytes(32).toString('base64'))"
# ORDER_TRACKING_SECRET (secret độc lập, dài hơn 32 ký tự)
node -e "const c=require('node:crypto'); console.log(c.randomBytes(48).toString('base64url'))"
```

Không dùng chung các giá trị này và không commit chúng vào Git. Giữ nguyên
`PAYOS_MASTER_KEY` và `ORDER_TRACKING_SECRET` qua các lần deploy; đổi chúng sẽ làm
mất khả năng giải mã cấu hình PayOS hoặc vô hiệu các QR theo dõi còn hạn.

### Khắc phục migration trùng từ bản `4aa30c7`

Bản `4aa30c7` từng chứa migration trùng
`20261006000000_owner_menu_batching_default`. Migration đúng đã có tên
`20261004160000_add_v91_menu_defaults_and_batching`.

Nếu container đã thử chạy bản lỗi và Prisma báo `P3009`, đánh dấu lần chạy lỗi là
đã rollback trước khi khởi động lại API:

```bash
docker compose run --rm --entrypoint pnpm api prisma migrate resolve --rolled-back 20261006000000_owner_menu_batching_default
docker compose up -d --build api
```

Chỉ chạy lệnh `resolve` khi log thực sự nêu đúng migration trên. Database chưa từng
chạy bản lỗi chỉ cần pull code mới và build lại.

### Docker local báo mất kết nối máy chủ

Trong Docker Desktop, nếu `postgres` có chấm xanh nhưng `api` hiện nút chạy
**▶**, Backend đã dừng nên Web/Mobile sẽ báo mất kết nối. Kiểm tra lỗi thật bằng:

```bash
docker compose ps -a
docker compose logs --tail=200 api
```

File `docker-compose.yml` local phải dùng `NODE_ENV=development`. Không đổi nó
thành `production`, vì cấu hình production bắt buộc `PUBLIC_WEB_URL` dùng HTTPS,
trong khi FE local thường chạy tại `http://localhost:8443`.

Nếu chưa cần gửi thư mời tài khoản, để **cả hai** biến email trống:

```env
EMAIL_API_KEY=
EMAIL_FROM=
```

Nếu cần gửi thư, phải điền đồng thời API key và người gửi đã xác thực:

```env
EMAIL_API_KEY=re_xxxxxxxxx
EMAIL_FROM=Smart F&B <no-reply@your-verified-domain.example>
```

Sau khi sửa `.env`, tạo lại container API và kiểm tra health endpoint:

```bash
docker compose up -d --build api
docker compose ps
curl http://localhost:3100/api/v1/health
```

API hoạt động khi container `api` có trạng thái `Up/healthy` và health endpoint
trả HTTP 200. Cổng `5433:5432` của PostgreSQL trong Docker Desktop là bình thường:
API trong Compose kết nối bằng hostname nội bộ `postgres:5432`, còn máy host dùng
`localhost:5433`.

### Render

Trên Render, nhập các biến trong phần **Environment** của service Backend. Không tải file `.env` local lên Render.

Các biến bắt buộc cần kiểm tra:

- `DATABASE_URL`: URL PostgreSQL của môi trường Render.
- `JWT_ACCESS_SECRET` và `JWT_REFRESH_SECRET`: hai secret khác nhau.
- `PAYOS_MASTER_KEY`: khóa base64 32 byte; phải giữ nguyên khi deploy lại để đọc được thông tin PayOS đã mã hóa.
- `PAYOS_WEBHOOK_BASE_URL=https://smart-fnb-be.onrender.com/api/v1`: prefix API công khai để PayOS xác nhận webhook theo từng kênh.
- `PUBLIC_WEB_URL`: domain FE Web công khai được in vào QR theo dõi trên phiếu số.
- `ORDER_TRACKING_SECRET`: secret độc lập tối thiểu 32 ký tự; không dùng lại JWT hoặc khóa PayOS.
- `EMAIL_API_KEY`: API key của Resend. Backend gọi HTTPS nên dùng được trên Render Free.
- `EMAIL_FROM`: người gửi thuộc domain đã xác thực trong Resend. Phải đặt cùng `EMAIL_API_KEY`; bỏ trống cả hai thì thư chỉ nằm ở trạng thái `PENDING`.
- `CORS_ORIGIN` và `REALTIME_CORS_ORIGINS`: thêm domain Web thực tế, phân cách bằng dấu phẩy.
- `REALTIME_ENABLED=true` và `REALTIME_PATH=/socket.io`.
- `SWAGGER_ENABLED=true` nếu cần dùng `/api/docs`; production có thể tắt sau khi kiểm thử.

Không đặt Client ID, API Key hoặc Checksum Key của PayOS trực tiếp trong `.env` Backend. Các khóa kênh PayOS được Owner gửi qua API và Backend mã hóa bằng `PAYOS_MASTER_KEY`.

`PAYOS_WEBHOOK_BASE_URL` local chỉ dùng cho test tự động. PayOS thật không gọi được `localhost`; kiểm thử thật phải dùng URL HTTPS công khai như Render.

Sau khi đặt biến email, Manager tạo hoặc reset Cashier/Barista sẽ sinh liên kết một
lần, gửi qua Resend và trả `emailStatus`. Không đưa setup token vào response API.

## 2. Web

### Vị trí file

```text
Smart_FnB_Web_Version/.env.local
```

Tạo từ template:

```bash
cd Smart_FnB_Web_Version
cp .env.example .env.local
```

### Chạy với Backend local

```dotenv
VITE_API_BASE_URL=http://localhost:3100/api/v1
VITE_REALTIME_PATH=/socket.io
```

### Chạy với Backend Render

```dotenv
VITE_API_BASE_URL=https://smart-fnb-be.onrender.com/api/v1
VITE_REALTIME_PATH=/socket.io
```

Các cờ `VITE_API_*` khác chỉ thêm khi cần ép một module chạy `real` hoặc `mock`. Nếu bỏ trống, Web dùng giá trị mặc định trong `src/api/flags.ts`.

Sau khi đổi biến `VITE_*`, phải dừng và chạy lại Vite.

## 3. Mobile chính

### Vị trí file

```text
Smart-FnB-Chain-Platform-Mobile/.env
```

Không thêm `/` ở cuối `api/v1`.

### Điện thoại hoặc tablet thật

Điện thoại và máy chạy Backend phải cùng mạng Wi-Fi:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://IP_LAN_CUA_MAY_CHAY_BACKEND:3100/api/v1
EXPO_PUBLIC_REALTIME_PATH=/socket.io
EXPO_PUBLIC_DISPLAY_PAIRING_MOCK=false
```

Ví dụ nếu IP máy chạy Backend là `192.168.1.30`:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.30:3100/api/v1
EXPO_PUBLIC_REALTIME_PATH=/socket.io
EXPO_PUBLIC_DISPLAY_PAIRING_MOCK=false
```

### Android Emulator

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3100/api/v1
EXPO_PUBLIC_REALTIME_PATH=/socket.io
EXPO_PUBLIC_DISPLAY_PAIRING_MOCK=false
```

### iOS Simulator hoặc Expo Web trên cùng máy

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://localhost:3100/api/v1
EXPO_PUBLIC_REALTIME_PATH=/socket.io
EXPO_PUBLIC_DISPLAY_PAIRING_MOCK=false
```

### Dùng Backend Render

```dotenv
EXPO_PUBLIC_API_BASE_URL=https://smart-fnb-be.onrender.com/api/v1
EXPO_PUBLIC_REALTIME_PATH=/socket.io
EXPO_PUBLIC_DISPLAY_PAIRING_MOCK=false
```

Sau khi đổi biến `EXPO_PUBLIC_*`, khởi động lại Expo và xóa cache:

```bash
pnpm expo start --clear
```

## 4. Kiểm tra kết nối

1. Backend local trả kết quả tại `http://localhost:3100/api/v1/health` và Swagger tại `http://localhost:3100/api/docs`.
2. Backend Render dùng `https://smart-fnb-be.onrender.com/api/v1` và Swagger tại `https://smart-fnb-be.onrender.com/api/docs`.
3. Web và Mobile phải dùng cùng một Backend để ghép quầy và đồng bộ màn hình khách.
4. `VITE_REALTIME_PATH`, `EXPO_PUBLIC_REALTIME_PATH` và `REALTIME_PATH` phải cùng là `/socket.io`.
5. Nếu HTTP gọi được nhưng màn hình khách không cập nhật, kiểm tra `REALTIME_ENABLED`, CORS realtime và WebSocket của môi trường deploy.

### Test local #38 và #40 không gọi PayOS thật

```bash
cd SmartFnBBackend
pnpm test:subscription-payos
```

Lệnh này build Backend, kiểm tra quyền đọc gói của Owner/Manager, trạng thái hết hạn/tạm ngưng, xác nhận webhook PayOS giả lập, trạng thái `LINKED/ERROR`, Last4, audit log và Prisma schema. Không cần Client ID, API Key, Checksum Key hoặc URL public.

## 5. Quy tắc bảo mật

- Chỉ chia sẻ `.env.example` hoặc tài liệu này; gửi secret thật qua kênh bảo mật riêng.
- Không commit `.env`, `.env.local`, database URL production, JWT secret hoặc khóa PayOS.
- Nếu một API key đã được gửi trong chat hoặc đưa lên GitHub, phải thu hồi và tạo khóa mới.
- Mỗi môi trường local, test và production nên dùng secret riêng.
