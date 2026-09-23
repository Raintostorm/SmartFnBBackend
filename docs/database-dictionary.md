# Smart F&B Database Dictionary

> Tài liệu được sinh từ `prisma/schema.prisma`. Tên bảng/cột bên dưới là tên vật lý trong PostgreSQL.

## Phạm vi và quy ước

- Database: PostgreSQL.
- `PK`: khóa chính; `UNIQUE`: không cho phép trùng.
- Các cột `created_at`, `updated_at`, `deleted_at` hỗ trợ audit và xóa mềm.
- Waiter/Kitchen Staff dùng luồng `restaurant_tables → table_session_tables → table_sessions → orders → order_items → serving_tasks`.

## Danh sách bảng

- [`roles`](#roles) — Danh mục quyền truy cập dùng cho RBAC.
- [`users`](#users) — Tài khoản đăng nhập chung cho mọi người dùng nội bộ.
- [`auth_sessions`](#auth-sessions) — Refresh token và vòng đời phiên đăng nhập.
- [`restaurant_chains`](#restaurant-chains) — Thông tin cấp chuỗi/thương hiệu.
- [`branches`](#branches) — Chi nhánh vận hành cụ thể của một chuỗi.
- [`branch_operating_hours`](#branch-operating-hours) — Lịch mở cửa lặp lại theo thứ trong tuần.
- [`branch_special_hours`](#branch-special-hours) — Ngoại lệ giờ mở cửa cho một ngày cụ thể.
- [`branch_areas`](#branch-areas) — Khu chức năng trong chi nhánh như phục vụ hoặc bếp.
- [`employees`](#employees) — Hồ sơ nhân viên gắn tài khoản với chi nhánh.
- [`owners`](#owners) — Hồ sơ chủ sở hữu không thuộc biên chế chi nhánh.
- [`owner_chain_assignments`](#owner-chain-assignments) — Phạm vi chuỗi mà một Owner được quản lý.
- [`registration_applications`](#registration-applications) — Hồ sơ đăng ký kinh doanh chờ Platform Admin xét duyệt.
- [`service_plans`](#service-plans) — Gói dịch vụ và các giới hạn tài nguyên được bán cho chuỗi.
- [`business_subscriptions`](#business-subscriptions) — Gói dịch vụ đang áp dụng và thời hạn của một chuỗi.
- [`business_subscription_events`](#business-subscription-events) — Lịch sử thay đổi trạng thái/gói thuê bao để audit.
- [`business_branding`](#business-branding) — Tên, logo và bảng màu nhận diện dùng nhất quán trên các ứng dụng.
- [`business_wallets`](#business-wallets) — Số dư ví đối soát của chuỗi.
- [`wallet_ledger_entries`](#wallet-ledger-entries) — Sổ cái bất biến ghi từng biến động số dư ví.
- [`withdrawal_requests`](#withdrawal-requests) — Yêu cầu rút tiền và trạng thái xử lý của Platform Admin.
- [`platform_finance_configs`](#platform-finance-configs) — Cấu hình tài chính áp dụng ở cấp nền tảng.
- [`password_setup_tokens`](#password-setup-tokens) — Token dùng một lần cho quy trình thiết lập mật khẩu an toàn.
- [`email_outbox`](#email-outbox) — Hàng đợi email bền vững để gửi lại khi provider lỗi.
- [`restaurant_tables`](#restaurant-tables) — Bàn vật lý và tọa độ để dựng sơ đồ bàn cho Waiter.
- [`table_adjacencies`](#table-adjacencies) — Khai báo các bàn liền kề có thể ghép.
- [`table_sessions`](#table-sessions) — Một lượt khách ngồi bàn; gom nhiều bàn, order và thanh toán.
- [`table_session_tables`](#table-session-tables) — Bảng nối nhiều-nhiều giữa phiên phục vụ và bàn.
- [`reservations`](#reservations) — Thông tin đặt bàn của khách vãng lai.
- [`reservation_tables`](#reservation-tables) — Bảng nối cho phép một đặt bàn giữ nhiều bàn liền kề.
- [`menu_categories`](#menu-categories) — Nhóm món của một chi nhánh.
- [`menu_items`](#menu-items) — Thông tin món và giá niêm yết.
- [`branch_menu_items`](#branch-menu-items) — Khả năng bán và số phần còn lại của món tại chi nhánh.
- [`orders`](#orders) — Một lần gọi món trong table session; một phiên có thể có nhiều order.
- [`order_items`](#order-items) — Snapshot từng món tại thời điểm gọi và trạng thái xử lý bếp/phục vụ.
- [`payments`](#payments) — Một lần thử hoặc hoàn tất thanh toán cho order hoặc table session.
- [`invoices`](#invoices) — Snapshot bill nội bộ bất biến được phát hành sau khi thanh toán đủ.
- [`invoice_items`](#invoice-items) — Snapshot từng dòng món tại thời điểm phát hành bill.
- [`invoice_payments`](#invoice-payments) — Phân bổ các payment thành công vào bill đã phát hành.
- [`vouchers`](#vouchers) — Khuyến mãi áp dụng toàn chuỗi hoặc một chi nhánh.
- [`attendances`](#attendances) — Bản tổng hợp chấm công theo ngày.
- [`work_sessions`](#work-sessions) — Phiên làm việc thực tế để xác định nhân viên đang trong ca.
- [`shift_templates`](#shift-templates) — Mẫu khung giờ làm việc tái sử dụng trong một chi nhánh.
- [`shift_assignments`](#shift-assignments) — Phân công nhân viên vào mẫu ca tại một ngày cụ thể.
- [`serving_tasks`](#serving-tasks) — Task bưng món được tạo khi Kitchen Staff đánh dấu món READY.

## `roles`

Danh mục quyền truy cập dùng cho RBAC.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `code` | `code` | `String` | Không | UNIQUE | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `description` | `description` | `String` | Có | — | Mô tả bổ sung. |
| `is_system` | `isSystem` | `Boolean` | Không | default: false | Đánh dấu role hệ thống, không phải role tùy biến. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- Không có khóa ngoại trực tiếp.

## `users`

Tài khoản đăng nhập chung cho mọi người dùng nội bộ.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `email` | `email` | `String` | Không | UNIQUE | Địa chỉ email liên hệ hoặc đăng nhập. |
| `phone` | `phone` | `String` | Có | UNIQUE | Số điện thoại liên hệ. |
| `password_hash` | `passwordHash` | `String` | Không | — | Mật khẩu đã băm; không lưu mật khẩu thô. |
| `status` | `status` | `UserStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `email_verified_at` | `emailVerifiedAt` | `DateTime` | Có | — | Thời điểm xác minh email. |
| `last_login_at` | `lastLoginAt` | `DateTime` | Có | — | Lần đăng nhập thành công gần nhất. |
| `role_id` | `roleId` | `String` | Không | — | Role quyết định quyền của tài khoản. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `roleId` → `roles.id` (xóa: `Restrict`).

## `auth_sessions`

Refresh token và vòng đời phiên đăng nhập.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `user_id` | `userId` | `String` | Không | — | Tài khoản đăng nhập liên quan. |
| `refresh_token_hash` | `refreshTokenHash` | `String` | Không | — | Refresh token đã băm để có thể thu hồi an toàn. |
| `user_agent` | `userAgent` | `String` | Có | — | Thông tin thiết bị/trình duyệt của phiên đăng nhập. |
| `ip_address` | `ipAddress` | `String` | Có | — | Địa chỉ IP tạo hoặc sử dụng phiên. |
| `expires_at` | `expiresAt` | `DateTime` | Không | — | Thời điểm dữ liệu hoặc token hết hiệu lực. |
| `last_used_at` | `lastUsedAt` | `DateTime` | Có | — | Lần cuối refresh token được dùng. |
| `revoked_at` | `revokedAt` | `DateTime` | Có | — | Thời điểm phiên đăng nhập bị thu hồi. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `userId` → `users.id` (xóa: `Cascade`).

## `restaurant_chains`

Thông tin cấp chuỗi/thương hiệu.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `code` | `code` | `String` | Không | UNIQUE | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `logo_url` | `logoUrl` | `String` | Có | — | Đường dẫn logo của chuỗi. |
| `email` | `email` | `String` | Có | — | Địa chỉ email liên hệ hoặc đăng nhập. |
| `phone` | `phone` | `String` | Có | — | Số điện thoại liên hệ. |
| `website` | `website` | `String` | Có | — | Website công khai của chuỗi. |
| `tax_code` | `taxCode` | `String` | Có | — | Mã số thuế của chuỗi. |
| `headquarters_address` | `headquartersAddress` | `String` | Có | — | Địa chỉ trụ sở chính. |
| `timezone` | `timezone` | `String` | Không | default: "Asia/Ho_Chi_Minh" | Múi giờ dùng để diễn giải thời gian nghiệp vụ. |
| `currency` | `currency` | `String` | Không | default: "VND" | Mã tiền tệ ISO dùng cho giá và thanh toán. |
| `status` | `status` | `RestaurantChainStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- Không có khóa ngoại trực tiếp.

## `branches`

Chi nhánh vận hành cụ thể của một chuỗi.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `chain_id` | `chainId` | `String` | Không | default: dbgenerated("'00000000-0000-4000-8000-000000000001'::uuid") | Chuỗi nhà hàng sở hữu chi nhánh. |
| `code` | `code` | `String` | Không | UNIQUE | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `phone` | `phone` | `String` | Có | — | Số điện thoại liên hệ. |
| `email` | `email` | `String` | Có | — | Địa chỉ email liên hệ hoặc đăng nhập. |
| `address_line_1` | `addressLine1` | `String` | Không | — | Dòng địa chỉ bắt buộc. |
| `address_line_2` | `addressLine2` | `String` | Có | — | Dòng địa chỉ bổ sung. |
| `ward` | `ward` | `String` | Có | — | Phường/xã. |
| `district` | `district` | `String` | Có | — | Quận/huyện. |
| `city` | `city` | `String` | Không | — | Tỉnh/thành phố. |
| `country` | `country` | `String` | Không | default: "Vietnam" | Quốc gia. |
| `timezone` | `timezone` | `String` | Không | default: "Asia/Ho_Chi_Minh" | Múi giờ dùng để diễn giải thời gian nghiệp vụ. |
| `status` | `status` | `BranchStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `chainId` → `restaurant_chains.id` (xóa: `Restrict`).

## `branch_operating_hours`

Lịch mở cửa lặp lại theo thứ trong tuần.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `day_of_week` | `dayOfWeek` | `Int` | Không | — | Ngày trong tuần, từ 0 đến 6. |
| `open_time` | `openTime` | `String` | Có | — | Giờ mở cửa dạng HH:mm. |
| `close_time` | `closeTime` | `String` | Có | — | Giờ đóng cửa dạng HH:mm. |
| `is_closed` | `isClosed` | `Boolean` | Không | default: false | Đánh dấu nghỉ cả ngày. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).

## `branch_special_hours`

Ngoại lệ giờ mở cửa cho một ngày cụ thể.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `date` | `date` | `DateTime` | Không | — | Ngày áp dụng ngoại lệ lịch. |
| `open_time` | `openTime` | `String` | Có | — | Giờ mở cửa dạng HH:mm. |
| `close_time` | `closeTime` | `String` | Có | — | Giờ đóng cửa dạng HH:mm. |
| `is_closed` | `isClosed` | `Boolean` | Không | default: false | Đánh dấu nghỉ cả ngày. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).

## `branch_areas`

Khu chức năng trong chi nhánh như phục vụ hoặc bếp.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `code` | `code` | `String` | Không | — | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `type` | `type` | `BranchAreaType` | Không | — | Loại nghiệp vụ của bản ghi. |
| `floor` | `floor` | `Int` | Không | default: 1 | Tầng vật lý trong chi nhánh. |
| `status` | `status` | `BranchAreaStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).

## `employees`

Hồ sơ nhân viên gắn tài khoản với chi nhánh.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `employee_code` | `employeeCode` | `String` | Không | UNIQUE | Mã nhân viên duy nhất toàn hệ thống. |
| `user_id` | `userId` | `String` | Không | UNIQUE | Tài khoản đăng nhập liên quan. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `first_name` | `firstName` | `String` | Không | — | Tên của người dùng. |
| `last_name` | `lastName` | `String` | Không | — | Họ và tên đệm. |
| `date_of_birth` | `dateOfBirth` | `DateTime` | Có | — | Ngày sinh, nếu được cung cấp. |
| `job_title` | `jobTitle` | `String` | Có | — | Chức danh hiển thị của nhân viên. |
| `hire_date` | `hireDate` | `DateTime` | Không | default: now() | Ngày bắt đầu làm việc. |
| `status` | `status` | `EmployeeStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `userId` → `users.id` (xóa: `Cascade`).
- `branchId` → `branches.id` (xóa: `Restrict`).

## `owners`

Hồ sơ chủ sở hữu không thuộc biên chế chi nhánh.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `owner_code` | `ownerCode` | `String` | Không | UNIQUE | Mã hồ sơ Owner duy nhất. |
| `user_id` | `userId` | `String` | Không | UNIQUE | Tài khoản đăng nhập liên quan. |
| `first_name` | `firstName` | `String` | Không | — | Tên của người dùng. |
| `last_name` | `lastName` | `String` | Không | — | Họ và tên đệm. |
| `date_of_birth` | `dateOfBirth` | `DateTime` | Có | — | Ngày sinh, nếu được cung cấp. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `userId` → `users.id` (xóa: `Cascade`).

## `owner_chain_assignments`

Phạm vi chuỗi mà một Owner được quản lý.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `owner_id` | `ownerId` | `String` | Không | — | Owner được phân quyền. |
| `chain_id` | `chainId` | `String` | Không | — | Chuỗi nhà hàng sở hữu chi nhánh. |
| `assigned_by_id` | `assignedById` | `String` | Có | — | Tài khoản thực hiện việc phân quyền. |
| `assigned_at` | `assignedAt` | `DateTime` | Không | default: now() | Thời điểm phân quyền. |

**Quan hệ**

- `ownerId` → `owners.id` (xóa: `Cascade`).
- `chainId` → `restaurant_chains.id` (xóa: `Cascade`).
- `assignedById` → `users.id` (xóa: `SetNull`).

## `registration_applications`

Hồ sơ đăng ký kinh doanh chờ Platform Admin xét duyệt.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `application_code` | `applicationCode` | `String` | Không | UNIQUE | application code của RegistrationApplication. |
| `business_name` | `businessName` | `String` | Không | — | business name của RegistrationApplication. |
| `tax_code` | `taxCode` | `String` | Có | — | Mã số thuế của chuỗi. |
| `representative_name` | `representativeName` | `String` | Không | — | representative name của RegistrationApplication. |
| `representative_email` | `representativeEmail` | `String` | Không | — | representative email của RegistrationApplication. |
| `representative_phone` | `representativePhone` | `String` | Không | — | representative phone của RegistrationApplication. |
| `headquarters_address` | `headquartersAddress` | `String` | Có | — | Địa chỉ trụ sở chính. |
| `requested_plan_id` | `requestedPlanId` | `String` | Có | — | requested plan id của RegistrationApplication. |
| `status` | `status` | `RegistrationApplicationStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `rejection_reason` | `rejectionReason` | `String` | Có | — | rejection reason của RegistrationApplication. |
| `reviewed_by_id` | `reviewedById` | `String` | Có | — | reviewed by id của RegistrationApplication. |
| `reviewed_at` | `reviewedAt` | `DateTime` | Có | — | reviewed at của RegistrationApplication. |
| `approved_chain_id` | `approvedChainId` | `String` | Có | UNIQUE | approved chain id của RegistrationApplication. |
| `owner_user_id` | `ownerUserId` | `String` | Có | UNIQUE | owner user id của RegistrationApplication. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `requestedPlanId` → `service_plans.id` (xóa: `SetNull`).
- `reviewedById` → `users.id` (xóa: `SetNull`).
- `approvedChainId` → `restaurant_chains.id` (xóa: `SetNull`).
- `ownerUserId` → `users.id` (xóa: `SetNull`).

## `service_plans`

Gói dịch vụ và các giới hạn tài nguyên được bán cho chuỗi.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `code` | `code` | `String` | Không | UNIQUE | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `description` | `description` | `String` | Có | — | Mô tả bổ sung. |
| `monthly_price` | `monthlyPrice` | `Decimal` | Không | — | monthly price của ServicePlan. |
| `max_branches` | `maxBranches` | `Int` | Không | — | max branches của ServicePlan. |
| `max_accounts` | `maxAccounts` | `Int` | Không | — | max accounts của ServicePlan. |
| `max_tables` | `maxTables` | `Int` | Không | — | max tables của ServicePlan. |
| `is_active` | `isActive` | `Boolean` | Không | default: true | Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- Không có khóa ngoại trực tiếp.

## `business_subscriptions`

Gói dịch vụ đang áp dụng và thời hạn của một chuỗi.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `chain_id` | `chainId` | `String` | Không | UNIQUE | Chuỗi nhà hàng sở hữu chi nhánh. |
| `plan_id` | `planId` | `String` | Không | — | plan id của BusinessSubscription. |
| `status` | `status` | `BusinessSubscriptionStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `monthly_price` | `monthlyPrice` | `Decimal` | Không | — | monthly price của BusinessSubscription. |
| `starts_at` | `startsAt` | `DateTime` | Không | — | Thời điểm bắt đầu hiệu lực. |
| `expires_at` | `expiresAt` | `DateTime` | Không | — | Thời điểm dữ liệu hoặc token hết hiệu lực. |
| `suspended_at` | `suspendedAt` | `DateTime` | Có | — | suspended at của BusinessSubscription. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `chainId` → `restaurant_chains.id` (xóa: `Cascade`).
- `planId` → `service_plans.id` (xóa: `Restrict`).

## `business_subscription_events`

Lịch sử thay đổi trạng thái/gói thuê bao để audit.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `subscription_id` | `subscriptionId` | `String` | Không | — | subscription id của BusinessSubscriptionEvent. |
| `type` | `type` | `SubscriptionEventType` | Không | — | Loại nghiệp vụ của bản ghi. |
| `from_plan_id` | `fromPlanId` | `String` | Có | — | from plan id của BusinessSubscriptionEvent. |
| `to_plan_id` | `toPlanId` | `String` | Có | — | to plan id của BusinessSubscriptionEvent. |
| `changed_by_id` | `changedById` | `String` | Có | — | changed by id của BusinessSubscriptionEvent. |
| `effective_at` | `effectiveAt` | `DateTime` | Không | default: now() | effective at của BusinessSubscriptionEvent. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |

**Quan hệ**

- `subscriptionId` → `business_subscriptions.id` (xóa: `Cascade`).
- `fromPlanId` → `service_plans.id` (xóa: `SetNull`).
- `toPlanId` → `service_plans.id` (xóa: `SetNull`).
- `changedById` → `users.id` (xóa: `SetNull`).

## `business_branding`

Tên, logo và bảng màu nhận diện dùng nhất quán trên các ứng dụng.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `chain_id` | `chainId` | `String` | Không | UNIQUE | Chuỗi nhà hàng sở hữu chi nhánh. |
| `display_name` | `displayName` | `String` | Không | — | display name của BusinessBranding. |
| `logo_url` | `logoUrl` | `String` | Có | — | Đường dẫn logo của chuỗi. |
| `primary_color` | `primaryColor` | `String` | Không | default: "#0F172A" | primary color của BusinessBranding. |
| `secondary_color` | `secondaryColor` | `String` | Không | default: "#FFFFFF" | secondary color của BusinessBranding. |
| `accent_color` | `accentColor` | `String` | Không | default: "#22C55E" | accent color của BusinessBranding. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `chainId` → `restaurant_chains.id` (xóa: `Cascade`).

## `business_wallets`

Số dư ví đối soát của chuỗi.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `chain_id` | `chainId` | `String` | Không | UNIQUE | Chuỗi nhà hàng sở hữu chi nhánh. |
| `currency` | `currency` | `String` | Không | default: "VND" | Mã tiền tệ ISO dùng cho giá và thanh toán. |
| `balance` | `balance` | `Decimal` | Không | default: 0 | balance của BusinessWallet. |
| `held_balance` | `heldBalance` | `Decimal` | Không | default: 0 | held balance của BusinessWallet. |
| `status` | `status` | `WalletStatus` | Không | default: ACTIVE | Trạng thái vòng đời hiện tại. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `chainId` → `restaurant_chains.id` (xóa: `Cascade`).

## `wallet_ledger_entries`

Sổ cái bất biến ghi từng biến động số dư ví.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `wallet_id` | `walletId` | `String` | Không | — | wallet id của WalletLedgerEntry. |
| `branch_id` | `branchId` | `String` | Có | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `type` | `type` | `WalletLedgerEntryType` | Không | — | Loại nghiệp vụ của bản ghi. |
| `amount` | `amount` | `Decimal` | Không | — | Số tiền của giao dịch. |
| `balance_after` | `balanceAfter` | `Decimal` | Không | — | balance after của WalletLedgerEntry. |
| `reference_type` | `referenceType` | `String` | Có | — | reference type của WalletLedgerEntry. |
| `reference_id` | `referenceId` | `String` | Có | — | reference id của WalletLedgerEntry. |
| `description` | `description` | `String` | Có | — | Mô tả bổ sung. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |

**Quan hệ**

- `walletId` → `business_wallets.id` (xóa: `Restrict`).
- `branchId` → `branches.id` (xóa: `SetNull`).

## `withdrawal_requests`

Yêu cầu rút tiền và trạng thái xử lý của Platform Admin.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `wallet_id` | `walletId` | `String` | Không | — | wallet id của WithdrawalRequest. |
| `requested_by_id` | `requestedById` | `String` | Không | — | requested by id của WithdrawalRequest. |
| `amount` | `amount` | `Decimal` | Không | — | Số tiền của giao dịch. |
| `status` | `status` | `WithdrawalRequestStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `bank_name` | `bankName` | `String` | Không | — | bank name của WithdrawalRequest. |
| `bank_account_name` | `bankAccountName` | `String` | Không | — | bank account name của WithdrawalRequest. |
| `bank_account_number` | `bankAccountNumber` | `String` | Không | — | bank account number của WithdrawalRequest. |
| `rejection_reason` | `rejectionReason` | `String` | Có | — | rejection reason của WithdrawalRequest. |
| `reviewed_by_id` | `reviewedById` | `String` | Có | — | reviewed by id của WithdrawalRequest. |
| `reviewed_at` | `reviewedAt` | `DateTime` | Có | — | reviewed at của WithdrawalRequest. |
| `bank_transaction_code` | `bankTransactionCode` | `String` | Có | — | bank transaction code của WithdrawalRequest. |
| `transfer_failure_reason` | `transferFailureReason` | `String` | Có | — | transfer failure reason của WithdrawalRequest. |
| `transferred_by_id` | `transferredById` | `String` | Có | — | transferred by id của WithdrawalRequest. |
| `transferred_at` | `transferredAt` | `DateTime` | Có | — | transferred at của WithdrawalRequest. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `walletId` → `business_wallets.id` (xóa: `Restrict`).
- `requestedById` → `users.id` (xóa: `Restrict`).
- `reviewedById` → `users.id` (xóa: `SetNull`).
- `transferredById` → `users.id` (xóa: `SetNull`).

## `platform_finance_configs`

Cấu hình tài chính áp dụng ở cấp nền tảng.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK | Khóa chính UUID. |
| `payment_fee_rate` | `paymentFeeRate` | `Decimal` | Không | — | payment fee rate của PlatformFinanceConfig. |
| `holding_period_days` | `holdingPeriodDays` | `Int` | Không | — | holding period days của PlatformFinanceConfig. |
| `minimum_withdrawal_amount` | `minimumWithdrawalAmount` | `Decimal` | Không | — | minimum withdrawal amount của PlatformFinanceConfig. |
| `updated_by_id` | `updatedById` | `String` | Có | — | Nhân viên cập nhật gần nhất. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `updatedById` → `users.id` (xóa: `SetNull`).

## `password_setup_tokens`

Token dùng một lần cho quy trình thiết lập mật khẩu an toàn.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `user_id` | `userId` | `String` | Không | — | Tài khoản đăng nhập liên quan. |
| `token_hash` | `tokenHash` | `String` | Không | UNIQUE | token hash của PasswordSetupToken. |
| `expires_at` | `expiresAt` | `DateTime` | Không | — | Thời điểm dữ liệu hoặc token hết hiệu lực. |
| `used_at` | `usedAt` | `DateTime` | Có | — | used at của PasswordSetupToken. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |

**Quan hệ**

- `userId` → `users.id` (xóa: `Cascade`).

## `email_outbox`

Hàng đợi email bền vững để gửi lại khi provider lỗi.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `recipient` | `recipient` | `String` | Không | — | recipient của EmailOutbox. |
| `subject` | `subject` | `String` | Không | — | subject của EmailOutbox. |
| `template` | `template` | `String` | Không | — | template của EmailOutbox. |
| `payload` | `payload` | `Json` | Không | — | payload của EmailOutbox. |
| `status` | `status` | `EmailOutboxStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `attempts` | `attempts` | `Int` | Không | default: 0 | attempts của EmailOutbox. |
| `last_error` | `lastError` | `String` | Có | — | last error của EmailOutbox. |
| `sent_at` | `sentAt` | `DateTime` | Có | — | sent at của EmailOutbox. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- Không có khóa ngoại trực tiếp.

## `restaurant_tables`

Bàn vật lý và tọa độ để dựng sơ đồ bàn cho Waiter.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `code` | `code` | `String` | Không | — | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Có | — | Tên hiển thị. |
| `area` | `area` | `String` | Có | — | Tên khu vực hiển thị của bàn. |
| `floor` | `floor` | `Int` | Không | default: 1 | Tầng vật lý trong chi nhánh. |
| `capacity` | `capacity` | `Int` | Không | — | Sức chứa tối đa của bàn. |
| `position_x` | `positionX` | `Decimal` | Có | — | Tọa độ ngang trên sơ đồ bàn. |
| `position_y` | `positionY` | `Decimal` | Có | — | Tọa độ dọc trên sơ đồ bàn. |
| `width` | `width` | `Decimal` | Có | — | Chiều rộng biểu diễn trên sơ đồ. |
| `height` | `height` | `Decimal` | Có | — | Chiều cao biểu diễn trên sơ đồ. |
| `status` | `status` | `TableStatus` | Không | default: AVAILABLE | Trạng thái vòng đời hiện tại. |
| `is_active` | `isActive` | `Boolean` | Không | default: true | Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Restrict`).

## `table_adjacencies`

Khai báo các bàn liền kề có thể ghép.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `table_id` | `tableId` | `String` | Không | — | Bàn vật lý liên quan. |
| `adjacent_table_id` | `adjacentTableId` | `String` | Không | — | Bàn liền kề với table_id. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).
- `tableId` → `restaurant_tables.id` (xóa: `Cascade`).
- `adjacentTableId` → `restaurant_tables.id` (xóa: `Cascade`).

## `table_sessions`

Một lượt khách ngồi bàn; gom nhiều bàn, order và thanh toán.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `session_code` | `sessionCode` | `String` | Không | UNIQUE | Mã phiên bàn để nhân viên tra cứu. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `reservation_id` | `reservationId` | `String` | Có | UNIQUE | Đặt bàn được chuyển thành phiên phục vụ. |
| `opened_by_waiter_id` | `openedByWaiterId` | `String` | Không | — | Waiter mở phiên bàn. |
| `closed_by_waiter_id` | `closedByWaiterId` | `String` | Có | — | Waiter đóng phiên sau thanh toán. |
| `guest_count` | `guestCount` | `Int` | Không | — | Số khách trong phiên bàn. |
| `status` | `status` | `TableSessionStatus` | Không | default: OPEN | Trạng thái vòng đời hiện tại. |
| `payment_status` | `paymentStatus` | `OrderPaymentStatus` | Không | default: UNPAID | Trạng thái thanh toán tổng hợp. |
| `guest_name` | `guestName` | `String` | Có | — | Tên khách vãng lai. |
| `guest_phone` | `guestPhone` | `String` | Có | — | Số điện thoại khách vãng lai. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `opened_at` | `openedAt` | `DateTime` | Không | default: now() | Thời điểm mở phiên bàn. |
| `paid_at` | `paidAt` | `DateTime` | Có | — | Thời điểm hệ thống xác nhận đã thanh toán. |
| `closed_at` | `closedAt` | `DateTime` | Có | — | Thời điểm đóng phiên bàn. |
| `cancelled_at` | `cancelledAt` | `DateTime` | Có | — | Thời điểm hủy. |
| `cancellation_reason` | `cancellationReason` | `String` | Có | — | Lý do hủy để truy vết. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Restrict`).
- `reservationId` → `reservations.id` (xóa: `SetNull`).
- `openedByWaiterId` → `employees.id` (xóa: `Restrict`).
- `closedByWaiterId` → `employees.id` (xóa: `SetNull`).

## `table_session_tables`

Bảng nối nhiều-nhiều giữa phiên phục vụ và bàn.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `table_session_id` | `tableSessionId` | `String` | Không | — | Phiên phục vụ tại bàn liên quan. |
| `table_id` | `tableId` | `String` | Không | — | Bàn vật lý liên quan. |
| `joined_at` | `joinedAt` | `DateTime` | Không | default: now() | Thời điểm bàn được đưa vào phiên. |
| `released_at` | `releasedAt` | `DateTime` | Có | — | Thời điểm bàn được giải phóng; null nghĩa là đang sử dụng. |

**Quan hệ**

- `tableSessionId` → `table_sessions.id` (xóa: `Cascade`).
- `tableId` → `restaurant_tables.id` (xóa: `Restrict`).

## `reservations`

Thông tin đặt bàn của khách vãng lai.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `reservation_code` | `reservationCode` | `String` | Không | UNIQUE | Mã đặt bàn để tra cứu. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `table_id` | `tableId` | `String` | Có | — | Bàn vật lý liên quan. |
| `confirmed_by_id` | `confirmedById` | `String` | Có | — | Nhân viên xác nhận đặt bàn. |
| `created_by_id` | `createdById` | `String` | Có | — | created by id của Reservation. |
| `updated_by_id` | `updatedById` | `String` | Có | — | Nhân viên cập nhật gần nhất. |
| `guest_name` | `guestName` | `String` | Không | — | Tên khách vãng lai. |
| `guest_phone` | `guestPhone` | `String` | Không | — | Số điện thoại khách vãng lai. |
| `guest_email` | `guestEmail` | `String` | Có | — | Email liên hệ của khách đặt bàn. |
| `party_size` | `partySize` | `Int` | Không | — | Số khách dự kiến. |
| `reservation_at` | `reservationAt` | `DateTime` | Không | — | Thời gian khách dự kiến đến. |
| `duration_minutes` | `durationMinutes` | `Int` | Không | default: 120 | Thời lượng giữ bàn dự kiến. |
| `status` | `status` | `ReservationStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `source` | `source` | `ReservationSource` | Không | default: PHONE | source của Reservation. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `confirmed_at` | `confirmedAt` | `DateTime` | Có | — | Thời điểm đặt bàn được xác nhận. |
| `checked_in_at` | `checkedInAt` | `DateTime` | Có | — | Thời điểm bắt đầu ca thực tế. |
| `no_show_at` | `noShowAt` | `DateTime` | Có | — | no show at của Reservation. |
| `cancelled_at` | `cancelledAt` | `DateTime` | Có | — | Thời điểm hủy. |
| `cancellation_reason` | `cancellationReason` | `String` | Có | — | Lý do hủy để truy vết. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Restrict`).
- `tableId` → `restaurant_tables.id` (xóa: `SetNull`).
- `confirmedById` → `employees.id` (xóa: `SetNull`).
- `createdById` → `employees.id` (xóa: `SetNull`).
- `updatedById` → `employees.id` (xóa: `SetNull`).

## `reservation_tables`

Bảng nối cho phép một đặt bàn giữ nhiều bàn liền kề.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `reservation_id` | `reservationId` | `String` | Không | — | Đặt bàn được chuyển thành phiên phục vụ. |
| `table_id` | `tableId` | `String` | Không | — | Bàn vật lý liên quan. |
| `allocated_at` | `allocatedAt` | `DateTime` | Không | default: now() | allocated at của ReservationTable. |
| `released_at` | `releasedAt` | `DateTime` | Có | — | Thời điểm bàn được giải phóng; null nghĩa là đang sử dụng. |

**Quan hệ**

- `reservationId` → `reservations.id` (xóa: `Cascade`).
- `tableId` → `restaurant_tables.id` (xóa: `Restrict`).

## `menu_categories`

Nhóm món của một chi nhánh.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `chain_id` | `chainId` | `String` | Không | — | Chuỗi nhà hàng sở hữu chi nhánh. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `description` | `description` | `String` | Có | — | Mô tả bổ sung. |
| `display_order` | `displayOrder` | `Int` | Không | default: 0 | Thứ tự hiển thị trong menu. |
| `is_active` | `isActive` | `Boolean` | Không | default: true | Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `chainId` → `restaurant_chains.id` (xóa: `Restrict`).

## `menu_items`

Thông tin món và giá niêm yết.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `category_id` | `categoryId` | `String` | Không | — | category id của MenuItem. |
| `sku` | `sku` | `String` | Không | UNIQUE | Mã món duy nhất. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `description` | `description` | `String` | Có | — | Mô tả bổ sung. |
| `price` | `price` | `Decimal` | Không | — | Giá bán niêm yết. |
| `cost_price` | `costPrice` | `Decimal` | Có | — | Giá vốn nội bộ, không hiển thị cho Kitchen Staff. |
| `image_url` | `imageUrl` | `String` | Có | — | Đường dẫn ảnh món. |
| `preparation_minutes` | `preparationMinutes` | `Int` | Có | — | Thời gian chế biến dự kiến. |
| `is_available` | `isAvailable` | `Boolean` | Không | default: true | Cho biết món hiện có thể bán hay không. |
| `is_active` | `isActive` | `Boolean` | Không | default: true | Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `categoryId` → `menu_categories.id` (xóa: `Restrict`).

## `branch_menu_items`

Khả năng bán và số phần còn lại của món tại chi nhánh.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `menu_item_id` | `menuItemId` | `String` | Không | — | Món trong menu liên quan. |
| `is_enabled` | `isEnabled` | `Boolean` | Không | default: true | Cho biết chi nhánh có kinh doanh món này hay không. |
| `is_available` | `isAvailable` | `Boolean` | Không | default: true | Cho biết món hiện có thể bán hay không. |
| `remaining_portions` | `remainingPortions` | `Int` | Có | — | Số phần còn bán; null nghĩa là không theo dõi giới hạn. |
| `updated_by_id` | `updatedById` | `String` | Có | — | Nhân viên cập nhật gần nhất. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).
- `menuItemId` → `menu_items.id` (xóa: `Cascade`).
- `updatedById` → `employees.id` (xóa: `SetNull`).

## `orders`

Một lần gọi món trong table session; một phiên có thể có nhiều order.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `order_code` | `orderCode` | `String` | Không | UNIQUE | Mã order để nhân viên tra cứu. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `table_id` | `tableId` | `String` | Có | — | Bàn vật lý liên quan. |
| `reservation_id` | `reservationId` | `String` | Có | UNIQUE | Đặt bàn được chuyển thành phiên phục vụ. |
| `waiter_id` | `waiterId` | `String` | Có | — | Waiter phụ trách theo cấu trúc cũ, được giữ để tương thích. |
| `table_session_id` | `tableSessionId` | `String` | Có | — | Phiên phục vụ tại bàn liên quan. |
| `created_by_waiter_id` | `createdByWaiterId` | `String` | Có | — | Waiter thực sự ghi nhận lần gọi món. |
| `voucher_id` | `voucherId` | `String` | Có | — | Voucher được áp dụng. |
| `type` | `type` | `OrderType` | Không | default: DINE_IN | Loại nghiệp vụ của bản ghi. |
| `status` | `status` | `OrderStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `payment_status` | `paymentStatus` | `OrderPaymentStatus` | Không | default: UNPAID | Trạng thái thanh toán tổng hợp. |
| `subtotal` | `subtotal` | `Decimal` | Không | default: 0 | Tổng tiền trước giảm giá, thuế và phí. |
| `discount_amount` | `discountAmount` | `Decimal` | Không | default: 0 | Tổng số tiền giảm. |
| `tax_amount` | `taxAmount` | `Decimal` | Không | default: 0 | Tiền thuế. |
| `service_charge` | `serviceCharge` | `Decimal` | Không | default: 0 | Phí phục vụ. |
| `total_amount` | `totalAmount` | `Decimal` | Không | default: 0 | Tổng tiền cuối cùng. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `placed_at` | `placedAt` | `DateTime` | Không | default: now() | Thời điểm tạo order. |
| `submitted_at` | `submittedAt` | `DateTime` | Có | — | Thời điểm gửi order xuống bếp. |
| `completed_at` | `completedAt` | `DateTime` | Có | — | Thời điểm hoàn tất. |
| `cancelled_at` | `cancelledAt` | `DateTime` | Có | — | Thời điểm hủy. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Restrict`).
- `tableId` → `restaurant_tables.id` (xóa: `SetNull`).
- `reservationId` → `reservations.id` (xóa: `SetNull`).
- `waiterId` → `employees.id` (xóa: `SetNull`).
- `tableSessionId` → `table_sessions.id` (xóa: `Restrict`).
- `createdByWaiterId` → `employees.id` (xóa: `SetNull`).
- `voucherId` → `vouchers.id` (xóa: `SetNull`).

## `order_items`

Snapshot từng món tại thời điểm gọi và trạng thái xử lý bếp/phục vụ.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `order_id` | `orderId` | `String` | Không | — | Order chứa bản ghi. |
| `menu_item_id` | `menuItemId` | `String` | Không | — | Món trong menu liên quan. |
| `item_name` | `itemName` | `String` | Không | — | item name của OrderItem. |
| `unit_price` | `unitPrice` | `Decimal` | Không | — | Đơn giá được chụp tại thời điểm gọi món. |
| `quantity` | `quantity` | `Int` | Không | — | Số lượng món đã gọi. |
| `discount_amount` | `discountAmount` | `Decimal` | Không | default: 0 | Tổng số tiền giảm. |
| `total_price` | `totalPrice` | `Decimal` | Không | — | Thành tiền của dòng món. |
| `special_instructions` | `specialInstructions` | `String` | Có | — | Ghi chú chế biến từ khách/Waiter. |
| `selected_options` | `selectedOptions` | `Json` | Có | — | Snapshot JSON của lựa chọn thêm/bớt/topping. |
| `status` | `status` | `OrderItemStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `started_at` | `startedAt` | `DateTime` | Có | — | Thời điểm Kitchen Staff bắt đầu chế biến. |
| `completed_at` | `completedAt` | `DateTime` | Có | — | Thời điểm hoàn tất. |
| `queued_at` | `queuedAt` | `DateTime` | Có | — | Thời điểm món vào hàng đợi bếp. |
| `ready_at` | `readyAt` | `DateTime` | Có | — | Thời điểm món sẵn sàng để bưng. |
| `served_at` | `servedAt` | `DateTime` | Có | — | Thời điểm Waiter xác nhận đã phục vụ. |
| `served_by_waiter_id` | `servedByWaiterId` | `String` | Có | — | Waiter xác nhận đã bưng món. |
| `unavailable_at` | `unavailableAt` | `DateTime` | Có | — | Thời điểm Kitchen Staff báo không thể chế biến. |
| `unavailable_by_id` | `unavailableById` | `String` | Có | — | Kitchen Staff báo món không khả dụng. |
| `started_by_kitchen_id` | `startedByKitchenId` | `String` | Có | — | started by kitchen id của OrderItem. |
| `completed_by_kitchen_id` | `completedByKitchenId` | `String` | Có | — | completed by kitchen id của OrderItem. |
| `cancelled_at` | `cancelledAt` | `DateTime` | Có | — | Thời điểm hủy. |
| `cancelled_by_id` | `cancelledById` | `String` | Có | — | Nhân viên thực hiện hủy. |
| `cancellation_reason` | `cancellationReason` | `String` | Có | — | Lý do hủy để truy vết. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `orderId` → `orders.id` (xóa: `Cascade`).
- `menuItemId` → `menu_items.id` (xóa: `Restrict`).
- `servedByWaiterId` → `employees.id` (xóa: `SetNull`).
- `unavailableById` → `employees.id` (xóa: `SetNull`).
- `startedByKitchenId` → `employees.id` (xóa: `SetNull`).
- `completedByKitchenId` → `employees.id` (xóa: `SetNull`).
- `cancelledById` → `employees.id` (xóa: `SetNull`).

## `payments`

Một lần thử hoặc hoàn tất thanh toán cho order hoặc table session.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `payment_code` | `paymentCode` | `String` | Không | UNIQUE | Mã giao dịch thanh toán nội bộ. |
| `order_id` | `orderId` | `String` | Có | — | Order chứa bản ghi. |
| `table_session_id` | `tableSessionId` | `String` | Có | — | Phiên phục vụ tại bàn liên quan. |
| `processed_by_id` | `processedById` | `String` | Có | — | Nhân viên/thu ngân xử lý thanh toán. |
| `method` | `method` | `PaymentMethod` | Không | — | Phương thức thanh toán. |
| `status` | `status` | `PaymentStatus` | Không | default: PENDING | Trạng thái vòng đời hiện tại. |
| `amount` | `amount` | `Decimal` | Không | — | Số tiền của giao dịch. |
| `transaction_ref` | `transactionRef` | `String` | Có | — | Mã tham chiếu từ cổng thanh toán. |
| `paid_at` | `paidAt` | `DateTime` | Có | — | Thời điểm hệ thống xác nhận đã thanh toán. |
| `failure_reason` | `failureReason` | `String` | Có | — | Lý do giao dịch thất bại. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `orderId` → `orders.id` (xóa: `Restrict`).
- `tableSessionId` → `table_sessions.id` (xóa: `Restrict`).
- `processedById` → `employees.id` (xóa: `SetNull`).

## `invoices`

Snapshot bill nội bộ bất biến được phát hành sau khi thanh toán đủ.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `invoice_number` | `invoiceNumber` | `String` | Không | UNIQUE | invoice number của Invoice. |
| `chain_id` | `chainId` | `String` | Không | — | Chuỗi nhà hàng sở hữu chi nhánh. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `table_session_id` | `tableSessionId` | `String` | Không | — | Phiên phục vụ tại bàn liên quan. |
| `status` | `status` | `InvoiceStatus` | Không | default: ISSUED | Trạng thái vòng đời hiện tại. |
| `currency` | `currency` | `String` | Không | default: "VND" | Mã tiền tệ ISO dùng cho giá và thanh toán. |
| `subtotal` | `subtotal` | `Decimal` | Không | — | Tổng tiền trước giảm giá, thuế và phí. |
| `discount_amount` | `discountAmount` | `Decimal` | Không | default: 0 | Tổng số tiền giảm. |
| `tax_amount` | `taxAmount` | `Decimal` | Không | default: 0 | Tiền thuế. |
| `service_charge` | `serviceCharge` | `Decimal` | Không | default: 0 | Phí phục vụ. |
| `total_amount` | `totalAmount` | `Decimal` | Không | — | Tổng tiền cuối cùng. |
| `paid_amount` | `paidAmount` | `Decimal` | Không | — | paid amount của Invoice. |
| `seller_name` | `sellerName` | `String` | Không | — | seller name của Invoice. |
| `seller_tax_code` | `sellerTaxCode` | `String` | Có | — | seller tax code của Invoice. |
| `seller_address` | `sellerAddress` | `String` | Không | — | seller address của Invoice. |
| `seller_phone` | `sellerPhone` | `String` | Có | — | seller phone của Invoice. |
| `seller_logo_url` | `sellerLogoUrl` | `String` | Có | — | seller logo url của Invoice. |
| `customer_name` | `customerName` | `String` | Có | — | customer name của Invoice. |
| `customer_phone` | `customerPhone` | `String` | Có | — | customer phone của Invoice. |
| `customer_email` | `customerEmail` | `String` | Có | — | customer email của Invoice. |
| `customer_tax_code` | `customerTaxCode` | `String` | Có | — | customer tax code của Invoice. |
| `customer_address` | `customerAddress` | `String` | Có | — | customer address của Invoice. |
| `issued_by_id` | `issuedById` | `String` | Không | — | issued by id của Invoice. |
| `issued_at` | `issuedAt` | `DateTime` | Không | default: now() | issued at của Invoice. |
| `cancelled_by_id` | `cancelledById` | `String` | Có | — | Nhân viên thực hiện hủy. |
| `cancelled_at` | `cancelledAt` | `DateTime` | Có | — | Thời điểm hủy. |
| `cancellation_reason` | `cancellationReason` | `String` | Có | — | Lý do hủy để truy vết. |
| `replacement_invoice_id` | `replacementInvoiceId` | `String` | Có | — | replacement invoice id của Invoice. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `chainId` → `restaurant_chains.id` (xóa: `Restrict`).
- `branchId` → `branches.id` (xóa: `Restrict`).
- `tableSessionId` → `table_sessions.id` (xóa: `Restrict`).
- `issuedById` → `employees.id` (xóa: `Restrict`).
- `cancelledById` → `employees.id` (xóa: `SetNull`).
- `replacementInvoiceId` → `invoices.id` (xóa: `SetNull`).

## `invoice_items`

Snapshot từng dòng món tại thời điểm phát hành bill.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `invoice_id` | `invoiceId` | `String` | Không | — | invoice id của InvoiceItem. |
| `order_item_id` | `orderItemId` | `String` | Có | — | Món trong order liên quan. |
| `item_name` | `itemName` | `String` | Không | — | item name của InvoiceItem. |
| `unit_price` | `unitPrice` | `Decimal` | Không | — | Đơn giá được chụp tại thời điểm gọi món. |
| `quantity` | `quantity` | `Int` | Không | — | Số lượng món đã gọi. |
| `discount_amount` | `discountAmount` | `Decimal` | Không | default: 0 | Tổng số tiền giảm. |
| `tax_rate` | `taxRate` | `Decimal` | Không | default: 0 | tax rate của InvoiceItem. |
| `tax_amount` | `taxAmount` | `Decimal` | Không | default: 0 | Tiền thuế. |
| `line_total` | `lineTotal` | `Decimal` | Không | — | line total của InvoiceItem. |
| `selected_options` | `selectedOptions` | `Json` | Có | — | Snapshot JSON của lựa chọn thêm/bớt/topping. |
| `special_instructions` | `specialInstructions` | `String` | Có | — | Ghi chú chế biến từ khách/Waiter. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |

**Quan hệ**

- `invoiceId` → `invoices.id` (xóa: `Cascade`).
- `orderItemId` → `order_items.id` (xóa: `SetNull`).

## `invoice_payments`

Phân bổ các payment thành công vào bill đã phát hành.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `invoice_id` | `invoiceId` | `String` | Không | — | invoice id của InvoicePayment. |
| `payment_id` | `paymentId` | `String` | Không | — | payment id của InvoicePayment. |
| `allocated_amount` | `allocatedAmount` | `Decimal` | Không | — | allocated amount của InvoicePayment. |

**Quan hệ**

- `invoiceId` → `invoices.id` (xóa: `Cascade`).
- `paymentId` → `payments.id` (xóa: `Restrict`).

## `vouchers`

Khuyến mãi áp dụng toàn chuỗi hoặc một chi nhánh.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Có | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `code` | `code` | `String` | Không | UNIQUE | Mã nghiệp vụ ngắn, ổn định và dễ tra cứu. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `description` | `description` | `String` | Có | — | Mô tả bổ sung. |
| `type` | `type` | `VoucherType` | Không | — | Loại nghiệp vụ của bản ghi. |
| `value` | `value` | `Decimal` | Không | — | Giá trị tiền hoặc phần trăm của voucher. |
| `min_order_amount` | `minOrderAmount` | `Decimal` | Không | default: 0 | Giá trị order tối thiểu để áp dụng. |
| `max_discount_amount` | `maxDiscountAmount` | `Decimal` | Có | — | Mức giảm tối đa. |
| `starts_at` | `startsAt` | `DateTime` | Không | — | Thời điểm bắt đầu hiệu lực. |
| `ends_at` | `endsAt` | `DateTime` | Không | — | Thời điểm hết hiệu lực. |
| `usage_limit` | `usageLimit` | `Int` | Có | — | Tổng lượt sử dụng tối đa. |
| `usage_count` | `usageCount` | `Int` | Không | default: 0 | Số lượt đã sử dụng. |
| `is_active` | `isActive` | `Boolean` | Không | default: true | Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `deleted_at` | `deletedAt` | `DateTime` | Có | — | Thời điểm xóa mềm; null nghĩa là còn hiệu lực. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Restrict`).

## `attendances`

Bản tổng hợp chấm công theo ngày.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `employee_id` | `employeeId` | `String` | Không | — | Nhân viên liên quan. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `work_date` | `workDate` | `DateTime` | Không | — | Ngày chấm công. |
| `check_in_at` | `checkInAt` | `DateTime` | Có | — | Giờ vào ca dùng cho bảng tổng hợp attendance. |
| `check_out_at` | `checkOutAt` | `DateTime` | Có | — | Giờ ra ca dùng cho bảng tổng hợp attendance. |
| `status` | `status` | `AttendanceStatus` | Không | default: PRESENT | Trạng thái vòng đời hiện tại. |
| `minutes_late` | `minutesLate` | `Int` | Không | default: 0 | Số phút đi muộn. |
| `total_minutes` | `totalMinutes` | `Int` | Có | — | Tổng phút làm việc trong ngày. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `employeeId` → `employees.id` (xóa: `Restrict`).
- `branchId` → `branches.id` (xóa: `Restrict`).

## `work_sessions`

Phiên làm việc thực tế để xác định nhân viên đang trong ca.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `employee_id` | `employeeId` | `String` | Không | — | Nhân viên liên quan. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `status` | `status` | `WorkSessionStatus` | Không | default: SCHEDULED | Trạng thái vòng đời hiện tại. |
| `scheduled_start` | `scheduledStart` | `DateTime` | Có | — | Giờ bắt đầu ca dự kiến. |
| `scheduled_end` | `scheduledEnd` | `DateTime` | Có | — | Giờ kết thúc ca dự kiến. |
| `checked_in_at` | `checkedInAt` | `DateTime` | Có | — | Thời điểm bắt đầu ca thực tế. |
| `checked_out_at` | `checkedOutAt` | `DateTime` | Có | — | Thời điểm kết thúc ca thực tế. |
| `is_unscheduled` | `isUnscheduled` | `Boolean` | Không | default: false | Cho biết đây là ca phát sinh ngoài lịch. |
| `auto_closed` | `autoClosed` | `Boolean` | Không | default: false | Cho biết ca được hệ thống tự đóng. |
| `note` | `note` | `String` | Có | — | Ghi chú nghiệp vụ tự do. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |
| `shift_assignment_id` | `shiftAssignmentId` | `String` | Có | — | shift assignment id của WorkSession. |

**Quan hệ**

- `employeeId` → `employees.id` (xóa: `Restrict`).
- `branchId` → `branches.id` (xóa: `Restrict`).
- `shiftAssignmentId` → `shift_assignments.id` (xóa: `SetNull`).

## `shift_templates`

Mẫu khung giờ làm việc tái sử dụng trong một chi nhánh.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `name` | `name` | `String` | Không | — | Tên hiển thị. |
| `start_time` | `startTime` | `String` | Không | — | start time của ShiftTemplate. |
| `end_time` | `endTime` | `String` | Không | — | end time của ShiftTemplate. |
| `is_active` | `isActive` | `Boolean` | Không | default: true | Cờ bật/tắt nghiệp vụ mà không xóa dữ liệu. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).

## `shift_assignments`

Phân công nhân viên vào mẫu ca tại một ngày cụ thể.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `employee_id` | `employeeId` | `String` | Không | — | Nhân viên liên quan. |
| `shift_template_id` | `shiftTemplateId` | `String` | Không | — | shift template id của ShiftAssignment. |
| `work_date` | `workDate` | `DateTime` | Không | — | Ngày chấm công. |
| `scheduled_start` | `scheduledStart` | `DateTime` | Không | — | Giờ bắt đầu ca dự kiến. |
| `scheduled_end` | `scheduledEnd` | `DateTime` | Không | — | Giờ kết thúc ca dự kiến. |
| `status` | `status` | `ShiftAssignmentStatus` | Không | default: SCHEDULED | Trạng thái vòng đời hiện tại. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `branchId` → `branches.id` (xóa: `Cascade`).
- `employeeId` → `employees.id` (xóa: `Restrict`).
- `shiftTemplateId` → `shift_templates.id` (xóa: `Restrict`).

## `serving_tasks`

Task bưng món được tạo khi Kitchen Staff đánh dấu món READY.

| Cột PostgreSQL | Prisma | Kiểu | Null | Ràng buộc | Nội dung / lý do tồn tại |
| --- | --- | --- | --- | --- | --- |
| `id` | `id` | `String` | Không | PK; default: uuid() | Khóa chính UUID. |
| `order_item_id` | `orderItemId` | `String` | Không | UNIQUE | Món trong order liên quan. |
| `branch_id` | `branchId` | `String` | Không | — | Chi nhánh sở hữu hoặc xử lý bản ghi. |
| `status` | `status` | `ServingTaskStatus` | Không | default: WAITING | Trạng thái vòng đời hiện tại. |
| `claimed_by_waiter_id` | `claimedByWaiterId` | `String` | Có | — | Waiter nhận task; null nghĩa là chưa ai nhận. |
| `served_by_waiter_id` | `servedByWaiterId` | `String` | Có | — | Waiter xác nhận đã bưng món. |
| `available_at` | `availableAt` | `DateTime` | Không | default: now() | Thời điểm task bắt đầu xuất hiện cho Waiter. |
| `claimed_at` | `claimedAt` | `DateTime` | Có | — | Thời điểm Waiter nhận task. |
| `served_at` | `servedAt` | `DateTime` | Có | — | Thời điểm Waiter xác nhận đã phục vụ. |
| `cancelled_at` | `cancelledAt` | `DateTime` | Có | — | Thời điểm hủy. |
| `created_at` | `createdAt` | `DateTime` | Không | default: now() | Thời điểm tạo bản ghi. |
| `updated_at` | `updatedAt` | `DateTime` | Không | — | Thời điểm cập nhật gần nhất. |

**Quan hệ**

- `orderItemId` → `order_items.id` (xóa: `Cascade`).
- `branchId` → `branches.id` (xóa: `Restrict`).
- `claimedByWaiterId` → `employees.id` (xóa: `SetNull`).
- `servedByWaiterId` → `employees.id` (xóa: `SetNull`).

## Quan hệ nghiệp vụ Waiter và Kitchen Staff

1. `restaurant_tables` lưu bàn và tọa độ; `table_adjacencies` quyết định bàn nào có thể ghép.
2. Waiter mở `table_sessions`; các bàn tham gia được ghi tại `table_session_tables`.
3. Mỗi lần gọi thêm tạo một `orders` mới trong cùng `table_sessions`.
4. `order_items` là đơn vị Kitchen Staff xử lý: `QUEUED → PREPARING → READY`.
5. Khi món `READY`, `serving_tasks` cho phép đúng một Waiter claim rồi xác nhận `SERVED`.
6. `branch_menu_items` tách tồn món theo chi nhánh khỏi thông tin menu gốc.
7. `work_sessions` xác định Waiter/Kitchen Staff nào đang thực sự trong ca.
8. `payments` gắn đúng một trong hai đối tượng: order cũ hoặc table session mới; migration có CHECK chống gắn cả hai.

## Ràng buộc chỉ có trong migration

- Một bàn chỉ được nằm trong một `table_session` chưa giải phóng.
- Một nhân viên chỉ có một `work_session` trạng thái `ACTIVE`.
- `guest_count > 0`; `remaining_portions >= 0` hoặc null.
- Một bàn không được khai báo liền kề với chính nó.
- `payments` phải trỏ đúng một payable (`order_id` XOR `table_session_id`).

