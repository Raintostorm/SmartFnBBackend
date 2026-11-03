# V14 POS backend — kết quả triển khai và phần còn thiếu

Ngày 03/11/2026. AI tạm hoãn theo yêu cầu; lượt này không sửa AI.

## Phạm vi đã có code

| Phần | Kết quả | Giới hạn |
|---|---|---|
| Giá món chi nhánh | Override nullable, server định giá checkout, snapshot giữ giá cũ, audit và event | Chưa có combo hoặc API ma trận bulk |
| Topping | Thư viện, liên kết món, số lượng/giá snapshot, stock theo chi nhánh, thứ tự hiển thị | Chuyển dữ liệu dự án cần chạy riêng sau kiểm tra |
| Topping hết | Lưu attentionAt/attentionReason trên đơn đang mở có topping; socket báo Manager | Không tự huỷ đơn hoặc tự bật lại món |
| Máy rung | Gán/đổi/gỡ số 1–999; notify READY; payload pha chế có pagerNumber/pagerNotifiedAt | Chưa thêm giao diện Mobile gán/gọi máy rung |
| CS-07 | Cashier hoàn nguyên dòng/toàn đơn, đúng chi nhánh và ngày thanh toán VN; đơn COMPLETED được hoàn | Chưa có giao diện Mobile hoàn tiền/in phiếu hoàn |
| Hoàn tiền | Tạo COMPLETED/CASH, mã lý do, audit, huỷ unit; khoá payment rồi order | Chưa có combo để hoàn nguyên combo |
| Tiền PayOS về muộn | Chỉ đánh dấu REQUIRES_ATTENTION; Manager xác nhận đã trả cash mới ghi refund | Khoản PENDING cũ giữ nguyên, không tự đánh dấu đã trả |
| Báo cáo | cashDrawer theo nhân viên: cashCollected, cashRefunded, netCash; hoàn đơn QR vẫn trừ két | Không quản lý tiền đầu ca hoặc đối chiếu két vật lý |

**Chưa hoàn thành toàn bộ v14. Combo vẫn chưa triển khai.** Không dùng báo cáo này để xác nhận nghiệm thu toàn bộ Cashier/Barista.

## API mới

Prefix `/api/v1`.

- `PATCH /counter/orders/:orderId/pager`, CASHIER/MANAGER, `{ "pagerNumber": 23 }`; null để gỡ.
- `POST /counter/orders/:orderId/pager/notify`, BARISTA/MANAGER, `{ "pagerNumber": 23 }`.
  Chỉ READY và số vẫn khớp. Nhân viên bấm thiết bị thật rồi gọi API; BE không phát tín hiệu radio.
  Đổi số xóa pagerNotifiedAt; notify lặp cùng số giữ thời điểm đầu.
- `POST /cashier/orders/:orderId/refunds`, CASHIER:

```json
{
  "items": [{ "orderItemId": "uuid" }],
  "reasonCode": "WRONG_ITEM",
  "note": "Khách nhận nhầm món"
}
```

Bỏ items hoặc []: hoàn toàn bộ phần chưa hoàn. Không nhận số tiền hay số lượng tuỳ ý.
Mã lý do: CHANGE_OF_MIND, WRONG_ITEM, OUT_OF_STOCK, LONG_WAIT, OTHER.
OTHER cần note ít nhất 5 ký tự. Chỉ xác nhận sau khi đưa tiền khách.
Tiền hoàn tính từ snapshot, giới hạn theo tiền thực nhận của đúng payment; không cộng nhầm khoản hoàn payment khác.
- `GET /cashier/orders/:orderId/refunds/:refundId/receipt`: dữ liệu khoản hoàn, dòng món, phương thức thanh toán gốc, người hoàn/thời điểm/lý do. Đây là JSON cho FE in, chưa phải PDF phiếu hoàn.
- API Manager huỷ đơn đã trả vẫn dùng route hiện có; chỉ chấp nhận refundMethod=CASH.
- GET /refunds mặc định trả lịch sử mọi trạng thái trong phạm vi; truyền status nếu cần lọc.
- Owner chỉ đọc khoản hoàn. Endpoint hoàn khoản PENDING cũ dành cho Manager và còn giữ ngữ nghĩa legacy; không tạo thêm PENDING mới.
- `order.pager.updated` và `refund.completed` phát sau commit. Payload prep/ready thêm hai trường pager.

## Dữ liệu và triển khai

Migration mới từ 20261103000100 đến 20261103000500. Không xoá bảng, đơn, snapshot hay lịch sử cũ.
Unique index PostgreSQL cho pager chỉ tính COUNTER_PICKUP, PAID, SUBMITTED/PREPARING/READY.
COMPLETED/CANCELLED tự giải phóng số qua điều kiện index, vẫn lưu pagerNumber lịch sử.
Không dùng Prisma db push thay migrate deploy vì cần giữ partial unique index.

```sh
pnpm prisma:migrate:deploy
pnpm prisma:generate
pnpm build
pnpm test
```

Render đã có render:start chạy migrate deploy. Chưa deploy/chưa push lượt này. Không cần thêm ENV.

### Chuyển topping cũ — thực hiện riêng

File `prisma/data-migrations/v14-legacy-toppings.sql` chỉ nhận nhóm code TOPPING, không đoán theo tên.
Trước khi chạy: sao lưu DB, kiểm tra nhóm/giá/liên kết và xác nhận client đã hỗ trợ extras.
Script transaction khóa các bảng liên quan, giữ ID option làm ID extra, sao giá và trạng thái chi nhánh,
sao liên kết rồi mới gỡ liên kết nhóm cũ. Không xoá option/group hoặc sửa JSON đơn lịch sử.
Chạy lại không nhân đôi hoặc ghi đè cấu hình extra đã chỉnh.
Giá âm hoặc trùng tên mơ hồ làm transaction thất bại để xử lý thủ công.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/data-migrations/v14-legacy-toppings.sql
```

**Chưa chạy script trên DB dự án hoặc Render.** Chỉ đã thử trên DB tạm.

## Kiểm chứng

- Build, Prisma validate và full unit suite: 194/194 qua.
- PostgreSQL tạm riêng, cổng 55439: áp dụng toàn bộ migration thành công.
- Integration: chuyển topping hai lần không nhân đôi, giữ giá và sold-out; hai đơn tranh cùng pager chỉ một được;
  đơn đóng giải phóng số và giữ lịch sử; hai refund đồng thời chỉ một ghi;
  unit rời queue; hoàn đơn QR làm netCash âm đúng khoản hoàn;
  topping hết lưu attention; PayOS về sau huỷ không tự tạo refund, Manager hoàn tiền mặt được.
- Không thay .env, không seed/reset DB dự án. Chưa test emulator, máy in, TV hoặc Render thực.

Chạy lại integration trên PostgreSQL dùng riêng (không dùng DB thật):

```sh
# DB đã migrate; guard test chỉ nhận đúng URL local này.
V14_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres pnpm test:v14:db
```

## Việc tiếp theo còn bắt buộc

1. Combo: catalog/branch override, pricing/snapshot cha-con, unit pha, khả dụng động, hoàn nguyên combo, báo cáo/bill không tính trùng.
2. API giá ma trận bulk cho cả món/combo.
3. Mobile CS-07 và pager; phiếu hoàn, thông báo Barista/Manager, đồng bộ màn phụ; test thiết bị thực.
4. Rà hết các luồng legacy theo v14 trước khi gỡ; không tự xoá API đang có client dùng.
5. Chuyển topping DB thật và kiểm thử triển khai sau khi review/thống nhất thời điểm nâng client.
