import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SWAGGER_ACCESS_TOKEN } from './modules/auth/auth.constants.js';

export const SWAGGER_DEVICE_TOKEN = 'display-device-token';

export const SWAGGER_TAGS = [
  ['System', 'Health check và trạng thái API.'],
  ['Authentication', 'Đăng nhập, làm mới token, đăng xuất và thông tin người dùng hiện tại.'],
  ['Business registration', 'Đăng ký doanh nghiệp công khai.'],
  ['Service plans - public', 'Danh sách gói dịch vụ công khai cho chủ doanh nghiệp.'],
  ['Restaurant chains - public', 'Danh sách chuỗi và chi nhánh đang hoạt động.'],
  ['Platform administration', 'Quản trị đăng ký doanh nghiệp, gói dịch vụ và thuê bao.'],
  ['Users', 'Quản lý trạng thái tài khoản.'],
  ['Restaurant chains - OWNER', 'OWNER quản lý chuỗi nhà hàng của mình.'],
  ['Employees - OWNER', 'OWNER quản lý tài khoản nhân viên theo phạm vi chuỗi.'],
  ['Menu - chain wide (OWNER)', 'OWNER quản lý danh mục, món và tùy chọn dùng chung.'],
  ['Reports - OWNER', 'Báo cáo doanh thu và vận hành của OWNER.'],
  [
    'Branch Manager',
    'Quản lý Cashier/Barista, tùy chọn, báo cáo, tra cứu đơn và audit trong chi nhánh được gán.',
  ],
  ['Restaurant branding', 'Cấu hình thương hiệu của chuỗi.'],
  ['PayOS channel', 'OWNER cấu hình kênh PayOS; khóa bí mật không được trả lại.'],
  ['Branches - internal', 'Quản lý chi nhánh, giờ mở cửa và khu vực phục vụ.'],
  ['Menu - branch', 'Bật/tắt món và giá riêng tại từng chi nhánh.'],
  ['POS stations and displays', 'Quầy POS, ghép màn hình khách và màn hình gọi số.'],
  ['Cashier · Orders', 'Cashier tạo, sửa, chốt, hủy và in lại đơn tại quầy.'],
  ['Cashier · Payments', 'Cashier thu tiền mặt hoặc tạo thanh toán QR PayOS.'],
  ['Barista · Queue', 'Barista nhận mẻ, pha chế, hoàn tác và giao đơn.'],
  ['Barista · Availability', 'Barista báo hết món hoặc tùy chọn tại chi nhánh.'],
  ['Waiter · Orders', 'Waiter tạo và gửi đơn tại bàn.'],
  ['Kitchen · Queue', 'Kitchen nhận và cập nhật tiến độ chế biến.'],
  ['Waiter · Serving', 'Waiter nhận và hoàn tất tác vụ phục vụ món.'],
  ['Tables', 'Sơ đồ bàn, trạng thái bàn và phiên phục vụ.'],
  ['Reservations and table allocation', 'Đặt bàn và gợi ý bàn phù hợp.'],
  ['Payments', 'Thanh toán cho phiên bàn và lịch sử thanh toán.'],
  ['Invoices and bill printing', 'Hóa đơn, bản chụp và dữ liệu in.'],
  ['Shifts and work sessions', 'Ca làm việc, phân ca và chấm công.'],
  ['PayOS webhook', 'Webhook công khai; dữ liệu chỉ được xử lý khi chữ ký PayOS hợp lệ.'],
] as const;

export const SWAGGER_DESCRIPTION = [
  '# Smart F&B API V9.1',
  '',
  'Tài liệu này được sinh trực tiếp từ các controller đang chạy. Tất cả REST API nghiệp vụ nằm dưới `/api/v1`.',
  '',
  '## Xác thực',
  '- API nhân viên dùng JWT lấy từ `POST /api/v1/auth/login`.',
  '- Bấm **Authorize** và nhập access token; Swagger tự thêm tiền tố `Bearer`.',
  '- API màn hình dùng device token được cấp khi ghép thiết bị.',
  '',
  '## Luồng Cashier → Barista',
  '1. Cashier tải context với trạng thái chuỗi, chi nhánh, số suất và option mặc định.',
  '2. Cashier chốt đơn để giữ suất rồi thu tiền mặt hoặc tạo QR PayOS có hạn 10 phút.',
  '3. Chỉ đơn đã thanh toán mới vào hàng chờ Barista và được cấp số gọi.',
  '4. Barista nhận mẻ theo cấu hình allowBatching, pha chế, hoàn tất rồi giao đơn.',
  '5. Đơn chưa thanh toán bị hủy hoặc QR hết hạn sẽ hoàn lại số suất đã giữ.',
  '',
  '## Trạng thái thuê bao',
  'Thuê bao hết hạn vẫn được đọc dữ liệu và hoàn tất đơn đang xử lý; thao tác tạo/cấu hình mới bị chặn.',
].join('\n');

export function configureSwagger(app: INestApplication): void {
  const configService = app.get(ConfigService);
  if (!configService.get<boolean>('SWAGGER_ENABLED', true)) return;

  const swaggerPath = configService.get<string>('SWAGGER_PATH', 'api/docs');
  let builder = new DocumentBuilder()
    .setTitle('Smart F&B Chain Platform — API V9.1')
    .setDescription(SWAGGER_DESCRIPTION)
    .setVersion('9.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token từ POST /api/v1/auth/login',
      },
      SWAGGER_ACCESS_TOKEN,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Nhập `Bearer <deviceToken>` của màn hình đã ghép.',
      },
      SWAGGER_DEVICE_TOKEN,
    );
  for (const [name, description] of SWAGGER_TAGS) builder = builder.addTag(name, description);
  const documentConfig = builder.build();

  const documentFactory = () =>
    SwaggerModule.createDocument(app, documentConfig, {
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
    });

  SwaggerModule.setup(swaggerPath, app, documentFactory, {
    customSiteTitle: 'Smart F&B API V9.1',
    swaggerOptions: {
      deepLinking: true,
      displayOperationId: true,
      displayRequestDuration: true,
      docExpansion: 'none',
      filter: true,
      persistAuthorization: true,
      operationsSorter: 'method',
      tryItOutEnabled: true,
    },
  });
}
