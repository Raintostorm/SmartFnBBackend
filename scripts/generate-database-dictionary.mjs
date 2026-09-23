import { mkdir, readFile, writeFile } from 'node:fs/promises';

const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const modelNames = new Set([...schema.matchAll(/^model\s+(\w+)\s+\{/gm)].map((match) => match[1]));
const tablePurposes = {
  Role: 'Danh mục quyền truy cập dùng cho RBAC.',
  User: 'Tài khoản đăng nhập chung cho mọi người dùng nội bộ.',
  AuthSession: 'Refresh token và vòng đời phiên đăng nhập.',
  RestaurantChain: 'Thông tin cấp chuỗi/thương hiệu.',
  Branch: 'Chi nhánh vận hành cụ thể của một chuỗi.',
  BranchOperatingHour: 'Lịch mở cửa lặp lại theo thứ trong tuần.',
  BranchSpecialHour: 'Ngoại lệ giờ mở cửa cho một ngày cụ thể.',
  BranchArea: 'Khu chức năng trong chi nhánh như phục vụ hoặc bếp.',
  Employee: 'Hồ sơ nhân viên gắn tài khoản với chi nhánh.',
  Owner: 'Hồ sơ chủ sở hữu không thuộc biên chế chi nhánh.',
  OwnerChainAssignment: 'Phạm vi chuỗi mà một Owner được quản lý.',
  RegistrationApplication: 'Hồ sơ đăng ký kinh doanh chờ Platform Admin xét duyệt.',
  ServicePlan: 'Gói dịch vụ và các giới hạn tài nguyên được bán cho chuỗi.',
  BusinessSubscription: 'Gói dịch vụ đang áp dụng và thời hạn của một chuỗi.',
  BusinessSubscriptionEvent: 'Lịch sử thay đổi trạng thái/gói thuê bao để audit.',
  BusinessBranding: 'Tên, logo và bảng màu nhận diện dùng nhất quán trên các ứng dụng.',
  BusinessWallet: 'Số dư ví đối soát của chuỗi.',
  WalletLedgerEntry: 'Sổ cái bất biến ghi từng biến động số dư ví.',
  WithdrawalRequest: 'Yêu cầu rút tiền và trạng thái xử lý của Platform Admin.',
  PlatformFinanceConfig: 'Cấu hình tài chính áp dụng ở cấp nền tảng.',
  PasswordSetupToken: 'Token dùng một lần cho quy trình thiết lập mật khẩu an toàn.',
  EmailOutbox: 'Hàng đợi email bền vững để gửi lại khi provider lỗi.',
  RestaurantTable: 'Bàn vật lý và tọa độ để dựng sơ đồ bàn cho Waiter.',
  TableAdjacency: 'Khai báo các bàn liền kề có thể ghép.',
  TableSession: 'Một lượt khách ngồi bàn; gom nhiều bàn, order và thanh toán.',
  TableSessionTable: 'Bảng nối nhiều-nhiều giữa phiên phục vụ và bàn.',
  Reservation: 'Thông tin đặt bàn của khách vãng lai.',
  ReservationTable: 'Bảng nối cho phép một đặt bàn giữ nhiều bàn liền kề.',
  MenuCategory: 'Nhóm món của một chi nhánh.',
  MenuItem: 'Thông tin món và giá niêm yết.',
  BranchMenuItem: 'Khả năng bán và số phần còn lại của món tại chi nhánh.',
  Order: 'Một lần gọi món trong table session; một phiên có thể có nhiều order.',
  OrderItem: 'Snapshot từng món tại thời điểm gọi và trạng thái xử lý bếp/phục vụ.',
  Payment: 'Một lần thử hoặc hoàn tất thanh toán cho order hoặc table session.',
  Invoice: 'Snapshot bill nội bộ bất biến được phát hành sau khi thanh toán đủ.',
  InvoiceItem: 'Snapshot từng dòng món tại thời điểm phát hành bill.',
  InvoicePayment: 'Phân bổ các payment thành công vào bill đã phát hành.',
  Voucher: 'Khuyến mãi áp dụng toàn chuỗi hoặc một chi nhánh.',
  Attendance: 'Bản tổng hợp chấm công theo ngày.',
  WorkSession: 'Phiên làm việc thực tế để xác định nhân viên đang trong ca.',
  ShiftTemplate: 'Mẫu khung giờ làm việc tái sử dụng trong một chi nhánh.',
  ShiftAssignment: 'Phân công nhân viên vào mẫu ca tại một ngày cụ thể.',
  ServingTask: 'Task bưng món được tạo khi Kitchen Staff đánh dấu món READY.',
};

const fieldPurposes = {
  id: 'Khóa chính UUID.',
  code: 'Mã nghiệp vụ ngắn, ổn định và dễ tra cứu.',
  name: 'Tên hiển thị.',
  description: 'Mô tả bổ sung.',
  status: 'Trạng thái vòng đời hiện tại.',
  createdAt: 'Thời điểm tạo bản ghi.',
  updatedAt: 'Thời điểm cập nhật gần nhất.',
  deletedAt: 'Thời điểm xóa mềm; null nghĩa là còn hiệu lực.',
  branchId: 'Chi nhánh sở hữu hoặc xử lý bản ghi.',
  userId: 'Tài khoản đăng nhập liên quan.',
  employeeId: 'Nhân viên liên quan.',
  orderId: 'Order chứa bản ghi.',
  orderItemId: 'Món trong order liên quan.',
  tableId: 'Bàn vật lý liên quan.',
  tableSessionId: 'Phiên phục vụ tại bàn liên quan.',
  menuItemId: 'Món trong menu liên quan.',
  roleId: 'Role quyết định quyền của tài khoản.',
  chainId: 'Chuỗi nhà hàng sở hữu chi nhánh.',
  isActive: 'Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu.',
  note: 'Ghi chú nghiệp vụ tự do.',
  email: 'Địa chỉ email liên hệ hoặc đăng nhập.',
  phone: 'Số điện thoại liên hệ.',
  firstName: 'Tên của người dùng.',
  lastName: 'Họ và tên đệm.',
  dateOfBirth: 'Ngày sinh, nếu được cung cấp.',
  openedAt: 'Thời điểm mở phiên bàn.',
  closedAt: 'Thời điểm đóng phiên bàn.',
  cancelledAt: 'Thời điểm hủy.',
  cancellationReason: 'Lý do hủy để truy vết.',
  quantity: 'Số lượng món đã gọi.',
  unitPrice: 'Đơn giá được chụp tại thời điểm gọi món.',
  totalPrice: 'Thành tiền của dòng món.',
  specialInstructions: 'Ghi chú chế biến từ khách/Waiter.',
  selectedOptions: 'Snapshot JSON của lựa chọn thêm/bớt/topping.',
  queuedAt: 'Thời điểm món vào hàng đợi bếp.',
  startedAt: 'Thời điểm Kitchen Staff bắt đầu chế biến.',
  readyAt: 'Thời điểm món sẵn sàng để bưng.',
  servedAt: 'Thời điểm Waiter xác nhận đã phục vụ.',
  remainingPortions: 'Số phần còn bán; null nghĩa là không theo dõi giới hạn.',
  isAvailable: 'Cho biết món hiện có thể bán hay không.',
  isEnabled: 'Cho biết chi nhánh có kinh doanh món này hay không.',
  guestCount: 'Số khách trong phiên bàn.',
  capacity: 'Sức chứa tối đa của bàn.',
  positionX: 'Tọa độ ngang trên sơ đồ bàn.',
  positionY: 'Tọa độ dọc trên sơ đồ bàn.',
  width: 'Chiều rộng biểu diễn trên sơ đồ.',
  height: 'Chiều cao biểu diễn trên sơ đồ.',
  paymentStatus: 'Trạng thái thanh toán tổng hợp.',
  passwordHash: 'Mật khẩu đã băm; không lưu mật khẩu thô.',
  refreshTokenHash: 'Refresh token đã băm để có thể thu hồi an toàn.',
  expiresAt: 'Thời điểm dữ liệu hoặc token hết hiệu lực.',
  checkedInAt: 'Thời điểm bắt đầu ca thực tế.',
  checkedOutAt: 'Thời điểm kết thúc ca thực tế.',
  isSystem: 'Đánh dấu role hệ thống, không phải role tùy biến.',
  emailVerifiedAt: 'Thời điểm xác minh email.',
  lastLoginAt: 'Lần đăng nhập thành công gần nhất.',
  userAgent: 'Thông tin thiết bị/trình duyệt của phiên đăng nhập.',
  ipAddress: 'Địa chỉ IP tạo hoặc sử dụng phiên.',
  lastUsedAt: 'Lần cuối refresh token được dùng.',
  revokedAt: 'Thời điểm phiên đăng nhập bị thu hồi.',
  logoUrl: 'Đường dẫn logo của chuỗi.',
  website: 'Website công khai của chuỗi.',
  taxCode: 'Mã số thuế của chuỗi.',
  headquartersAddress: 'Địa chỉ trụ sở chính.',
  timezone: 'Múi giờ dùng để diễn giải thời gian nghiệp vụ.',
  currency: 'Mã tiền tệ ISO dùng cho giá và thanh toán.',
  addressLine1: 'Dòng địa chỉ bắt buộc.',
  addressLine2: 'Dòng địa chỉ bổ sung.',
  ward: 'Phường/xã.',
  district: 'Quận/huyện.',
  city: 'Tỉnh/thành phố.',
  country: 'Quốc gia.',
  dayOfWeek: 'Ngày trong tuần, từ 0 đến 6.',
  openTime: 'Giờ mở cửa dạng HH:mm.',
  closeTime: 'Giờ đóng cửa dạng HH:mm.',
  isClosed: 'Đánh dấu nghỉ cả ngày.',
  date: 'Ngày áp dụng ngoại lệ lịch.',
  type: 'Loại nghiệp vụ của bản ghi.',
  floor: 'Tầng vật lý trong chi nhánh.',
  employeeCode: 'Mã nhân viên duy nhất toàn hệ thống.',
  jobTitle: 'Chức danh hiển thị của nhân viên.',
  hireDate: 'Ngày bắt đầu làm việc.',
  ownerCode: 'Mã hồ sơ Owner duy nhất.',
  ownerId: 'Owner được phân quyền.',
  assignedById: 'Tài khoản thực hiện việc phân quyền.',
  assignedAt: 'Thời điểm phân quyền.',
  area: 'Tên khu vực hiển thị của bàn.',
  adjacentTableId: 'Bàn liền kề với table_id.',
  sessionCode: 'Mã phiên bàn để nhân viên tra cứu.',
  reservationId: 'Đặt bàn được chuyển thành phiên phục vụ.',
  openedByWaiterId: 'Waiter mở phiên bàn.',
  closedByWaiterId: 'Waiter đóng phiên sau thanh toán.',
  guestName: 'Tên khách vãng lai.',
  guestPhone: 'Số điện thoại khách vãng lai.',
  paidAt: 'Thời điểm hệ thống xác nhận đã thanh toán.',
  joinedAt: 'Thời điểm bàn được đưa vào phiên.',
  releasedAt: 'Thời điểm bàn được giải phóng; null nghĩa là đang sử dụng.',
  reservationCode: 'Mã đặt bàn để tra cứu.',
  confirmedById: 'Nhân viên xác nhận đặt bàn.',
  guestEmail: 'Email liên hệ của khách đặt bàn.',
  partySize: 'Số khách dự kiến.',
  reservationAt: 'Thời gian khách dự kiến đến.',
  durationMinutes: 'Thời lượng giữ bàn dự kiến.',
  confirmedAt: 'Thời điểm đặt bàn được xác nhận.',
  displayOrder: 'Thứ tự hiển thị trong menu.',
  sku: 'Mã món duy nhất.',
  price: 'Giá bán niêm yết.',
  costPrice: 'Giá vốn nội bộ, không hiển thị cho Kitchen Staff.',
  imageUrl: 'Đường dẫn ảnh món.',
  preparationMinutes: 'Thời gian chế biến dự kiến.',
  updatedById: 'Nhân viên cập nhật gần nhất.',
  orderCode: 'Mã order để nhân viên tra cứu.',
  waiterId: 'Waiter phụ trách theo cấu trúc cũ, được giữ để tương thích.',
  createdByWaiterId: 'Waiter thực sự ghi nhận lần gọi món.',
  voucherId: 'Voucher được áp dụng.',
  subtotal: 'Tổng tiền trước giảm giá, thuế và phí.',
  discountAmount: 'Tổng số tiền giảm.',
  taxAmount: 'Tiền thuế.',
  serviceCharge: 'Phí phục vụ.',
  totalAmount: 'Tổng tiền cuối cùng.',
  placedAt: 'Thời điểm tạo order.',
  submittedAt: 'Thời điểm gửi order xuống bếp.',
  completedAt: 'Thời điểm hoàn tất.',
  servedByWaiterId: 'Waiter xác nhận đã bưng món.',
  unavailableAt: 'Thời điểm Kitchen Staff báo không thể chế biến.',
  unavailableById: 'Kitchen Staff báo món không khả dụng.',
  cancelledById: 'Nhân viên thực hiện hủy.',
  paymentCode: 'Mã giao dịch thanh toán nội bộ.',
  processedById: 'Nhân viên/thu ngân xử lý thanh toán.',
  method: 'Phương thức thanh toán.',
  amount: 'Số tiền của giao dịch.',
  transactionRef: 'Mã tham chiếu từ cổng thanh toán.',
  failureReason: 'Lý do giao dịch thất bại.',
  value: 'Giá trị tiền hoặc phần trăm của voucher.',
  minOrderAmount: 'Giá trị order tối thiểu để áp dụng.',
  maxDiscountAmount: 'Mức giảm tối đa.',
  startsAt: 'Thời điểm bắt đầu hiệu lực.',
  endsAt: 'Thời điểm hết hiệu lực.',
  usageLimit: 'Tổng lượt sử dụng tối đa.',
  usageCount: 'Số lượt đã sử dụng.',
  workDate: 'Ngày chấm công.',
  checkInAt: 'Giờ vào ca dùng cho bảng tổng hợp attendance.',
  checkOutAt: 'Giờ ra ca dùng cho bảng tổng hợp attendance.',
  minutesLate: 'Số phút đi muộn.',
  totalMinutes: 'Tổng phút làm việc trong ngày.',
  scheduledStart: 'Giờ bắt đầu ca dự kiến.',
  scheduledEnd: 'Giờ kết thúc ca dự kiến.',
  isUnscheduled: 'Cho biết đây là ca phát sinh ngoài lịch.',
  autoClosed: 'Cho biết ca được hệ thống tự đóng.',
  claimedByWaiterId: 'Waiter nhận task; null nghĩa là chưa ai nhận.',
  availableAt: 'Thời điểm task bắt đầu xuất hiện cho Waiter.',
  claimedAt: 'Thời điểm Waiter nhận task.',
};

const toSnake = (value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const describeField = (field, model) =>
  fieldPurposes[field] ??
  `${field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} của ${model}.`;

function getDefault(attributes) {
  const start = attributes.indexOf('@default(');
  if (start < 0) return null;
  let depth = 0;
  for (let index = start + '@default'.length; index < attributes.length; index += 1) {
    if (attributes[index] === '(') depth += 1;
    if (attributes[index] === ')') {
      depth -= 1;
      if (depth === 0) return attributes.slice(start + '@default('.length, index);
    }
  }
  return null;
}

const models = [...schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)].map((match) => {
  const [, name, body] = match;
  const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? toSnake(name);
  const fields = [];
  const relations = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('@@') || line.startsWith('//')) continue;
    const fieldMatch = line.match(/^(\w+)\s+([\w]+)(\[\])?(\?)?\s*(.*)$/);
    if (!fieldMatch) continue;
    const [, field, type, list, optional, attributes] = fieldMatch;
    if (modelNames.has(type)) {
      const relation = attributes.match(
        /@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]([^)]*)\)/,
      );
      if (relation) {
        relations.push({
          field,
          target: type,
          local: relation[1].trim(),
          remote: relation[2].trim(),
          deleteRule: relation[3].match(/onDelete:\s*(\w+)/)?.[1] ?? 'mặc định',
        });
      }
      continue;
    }
    const column = attributes.match(/@map\("([^"]+)"\)/)?.[1] ?? toSnake(field);
    const defaultValue = getDefault(attributes);
    const constraints = [
      attributes.includes('@id') ? 'PK' : '',
      attributes.includes('@unique') ? 'UNIQUE' : '',
      defaultValue ? `default: ${defaultValue}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    fields.push({
      field,
      column,
      type: `${type}${list ?? ''}`,
      nullable: optional ? 'Có' : 'Không',
      constraints: constraints || '—',
      purpose: describeField(field, name),
    });
  }
  return { name, table, fields, relations };
});

const lines = [
  '# Smart F&B Database Dictionary',
  '',
  '> Tài liệu được sinh từ `prisma/schema.prisma`. Tên bảng/cột bên dưới là tên vật lý trong PostgreSQL.',
  '',
  '## Phạm vi và quy ước',
  '',
  '- Database: PostgreSQL.',
  '- `PK`: khóa chính; `UNIQUE`: không cho phép trùng.',
  '- Các cột `created_at`, `updated_at`, `deleted_at` hỗ trợ audit và xóa mềm.',
  '- Waiter/Kitchen Staff dùng luồng `restaurant_tables → table_session_tables → table_sessions → orders → order_items → serving_tasks`.',
  '',
  '## Danh sách bảng',
  '',
  ...models.map(
    (model) =>
      `- [\`${model.table}\`](#${model.table.replaceAll('_', '-')}) — ${tablePurposes[model.name] ?? ''}`,
  ),
  '',
];

for (const model of models) {
  lines.push(`## \`${model.table}\``, '', tablePurposes[model.name] ?? '', '');
  lines.push('| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const field of model.fields) {
    lines.push(
      `| \`${field.column}\` | \`${field.field}\` | \`${field.type}\` | ${field.nullable} | ${field.constraints} | ${field.purpose} |`,
    );
  }
  lines.push('', '**Quan hệ**', '');
  if (model.relations.length === 0) {
    lines.push('- Không có khóa ngoại trực tiếp.');
  } else {
    for (const relation of model.relations) {
      const target =
        models.find((candidate) => candidate.name === relation.target)?.table ?? relation.target;
      lines.push(
        `- \`${relation.local}\` → \`${target}.${relation.remote}\` (xóa: \`${relation.deleteRule}\`).`,
      );
    }
  }
  lines.push('');
}

lines.push(
  '## Quan hệ nghiệp vụ Waiter và Kitchen Staff',
  '',
  '1. `restaurant_tables` lưu bàn và tọa độ; `table_adjacencies` quyết định bàn nào có thể ghép.',
  '2. Waiter mở `table_sessions`; các bàn tham gia được ghi tại `table_session_tables`.',
  '3. Mỗi lần gọi thêm tạo một `orders` mới trong cùng `table_sessions`.',
  '4. `order_items` là đơn vị Kitchen Staff xử lý: `QUEUED → PREPARING → READY`.',
  '5. Khi món `READY`, `serving_tasks` cho phép đúng một Waiter claim rồi xác nhận `SERVED`.',
  '6. `branch_menu_items` tách tồn món theo chi nhánh khỏi thông tin menu gốc.',
  '7. `work_sessions` xác định Waiter/Kitchen Staff nào đang thực sự trong ca.',
  '8. `payments` gắn đúng một trong hai đối tượng: order cũ hoặc table session mới; migration có CHECK chống gắn cả hai.',
  '',
  '## Ràng buộc chỉ có trong migration',
  '',
  '- Một bàn chỉ được nằm trong một `table_session` chưa giải phóng.',
  '- Một nhân viên chỉ có một `work_session` trạng thái `ACTIVE`.',
  '- `guest_count > 0`; `remaining_portions >= 0` hoặc null.',
  '- Một bàn không được khai báo liền kề với chính nó.',
  '- `payments` phải trỏ đúng một payable (`order_id` XOR `table_session_id`).',
  '',
);

await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../docs/database-dictionary.md', import.meta.url),
  `${lines.join('\n')}\n`,
);
