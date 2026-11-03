# V14 — Cashier và Barista: hợp đồng BE và kết quả triển khai

Cập nhật 03/11/2026. Phạm vi chỉ Backend; AI để sau. Không sửa FE Web/Mobile.

## Đã triển khai

- Combo: danh mục, 2–6 thành phần cố định/chọn món, 1–5 phần/thành phần, 2–10 lựa chọn cho nhóm chọn món, một lựa chọn mặc định, phụ thu không âm, size cố định, gán chi nhánh, tắt/ngừng bán.
- Giá chi nhánh cho cả món và combo: null lấy giá chuỗi, 0 là giá hợp lệ; cập nhật hàng loạt nguyên tử, audit cùng transaction, socket sau commit. Giá quá thấp/cao vẫn lưu kèm cảnh báo.
- Topping: thư viện chuỗi, giá/giới hạn/thứ tự theo món, giá mặc định từ thư viện khi không nhập giá riêng, trạng thái chi nhánh, snapshot tên/giá/số lượng. DELETE thư viện là ngừng bán, không xoá lịch sử.
- Cashier checkout: định giá DB, snapshot bất biến; combo cha tính tiền, con giá 0, giữ tên combo. Mỗi con sinh lượt pha theo số lượng thực. Không phân bổ doanh thu cha xuống con.
- Khả dụng combo đọc động từ món thành phần/size/chi nhánh; không tự lưu cờ tắt vĩnh viễn khi một món hết.
- Pha chế: con combo vào hàng đợi/gom món như món lẻ; chỉ READY khi đủ con; trả comboName/parentId và thông tin pager; không trả giá trong options của queue.
- Phiếu/PDF: cha và các con đi cùng nhau; không cộng hoặc in giá con như một khoản thu riêng. Báo cáo có topCombos riêng; topItems đếm món con nhưng doanh thu nằm ở cha.
- CS-07: Cashier chỉ chi nhánh mình, thanh toán trong ngày Việt Nam; Store Manager cả lịch sử. Hỗ trợ đơn đã hoàn tất và trạng thái DELIVERED cũ. Hoàn nguyên dòng combo, không hoàn một con.
- Khoản hoàn mới luôn CASH/COMPLETED, server tính tiền theo snapshot/thực thu; reasonCode, audit, hao hụt cho món đã làm/giao, huỷ unit khỏi hàng đợi. Khoá payment rồi order để chống trùng.
- PayOS về muộn: ghi nhận tiền và cảnh báo; không tự tạo một khoản chờ hoàn chuyển khoản. Manager ghi khoản hoàn sau khi thực sự trả cash. Webhook lặp không tạo nghĩa vụ/hoàn trùng. Giữ khoản PENDING lịch sử.
- Báo cáo két: cashCollected/cashRefunded/netCash theo nhân viên; hoàn đơn QR vẫn trừ tiền mặt. Tiền nhận thừa sau huỷ/đổi tiền mặt không tính là doanh thu bán hàng.
- Máy rung: 1–999, không trùng đơn mở trong chi nhánh; đổi số xoá dấu đã gọi; giữ số lịch sử nhưng giải phóng khi đóng/huỷ. Nhân viên bấm thiết bị thật rồi ghi nhận, không tích hợp radio.

## API combo và giá

Prefix `/api/v1`. Brand Manager vẫn dùng API role OWNER để tương thích.

| API | Mục đích |
|---|---|
| GET/POST /restaurant-chains/:chainId/combos | Danh sách/tạo combo |
| PATCH/DELETE /restaurant-chains/:chainId/combos/:id | Sửa/ngừng bán; không xoá snapshot |
| PUT /restaurant-chains/:chainId/combos/:id/branches | `{branchIds:[uuid]}`; bỏ gán giữ nguyên giá override lịch sử |
| GET /restaurant-chains/:chainId/branch-prices | `{branches,cells}` cho món và combo |
| PUT /restaurant-chains/:chainId/branch-prices | `{updates:[{type:"ITEM" hoặc "COMBO",productId,branchId,priceOverride}]}`; 1–500 ô, toàn bộ cùng transaction |
| PATCH /branch-combos/:id/availability | MANAGER/BARISTA; `{isAvailable:true}` tại chi nhánh tài khoản |
| GET /reports/top-combos | Owner; cùng bộ lọc phạm vi/ngày/limit với top-items |

Combo dùng `categoryId,name,description,imageUrl,price,isActive,displayOrder,components`.
Mỗi component có `type:FIXED/CHOICE,name,quantity,fixedSizeCode,displayOrder,choices`.
Mỗi choice có `menuItemId,surcharge,isDefault`. fixedSizeCode là code option thuộc nhóm SIZE,
phải có trên mọi món lựa chọn. FIXED có đúng một choice; CHOICE có 2–10.
PATCH có thể gửi một phần; gửi components nghĩa là thay toàn bộ cấu hình thành phần.
Giỏ cũ chứa component ID bị thay phải tải lại cấu hình; đơn đã chốt không bị sửa.

`GET /cashier/context` thêm combos bên cạnh menuItems. Checkout giữ tương thích items và thêm combos:

```json
{
  "items": [],
  "combos": [{
    "comboId": "uuid",
    "quantity": 2,
    "components": [{
      "componentId": "uuid",
      "menuItemId": "uuid",
      "optionIds": [],
      "extras": [{ "extraId": "uuid", "quantity": 1 }]
    }]
  }]
}
```

Bỏ lựa chọn thành phần thì dùng món mặc định; tuỳ chọn bắt buộc vẫn phải được chọn đúng quy tắc món.
Size cố định được BE thêm vào, gửi size khác bị từ chối. Topping là số phần trên mỗi ly thành phần.
Ví dụ 39.000 + món chọn phụ thu 5.000 + topping 5.000 = 49.000/combo; mua 2 là 98.000.
Dòng cha `lineType=COMBO`, menuItemId=null; con `COMBO_COMPONENT`, parentId trỏ cha,
comboName là snapshot, unitPrice/totalPrice=0. Dòng lẻ giữ ITEM và parentId=null.
BE không nhận giá từ client. FE cần xử lý loại dòng mới khi hiển thị; lượt này không đổi FE.

## API hoàn tiền và pager

- POST `/cashier/orders/:orderId/refunds`: `{items:[{orderItemId}],reasonCode,note}`.
  Bỏ items hoặc [] hoàn phần còn lại; combo chọn ID dòng cha. Không nhận số tiền/số lượng hoàn tuỳ ý.
- reasonCode: CHANGE_OF_MIND, WRONG_ITEM, OUT_OF_STOCK, LONG_WAIT, OTHER; OTHER cần note >=5 ký tự.
- GET `/cashier/orders/:orderId/refunds/:refundId/receipt`: JSON khoản hoàn/dòng món/phương thức gốc/người hoàn/thời điểm/lý do để FE in; không phải PDF phiếu hoàn.
- Manager dùng route huỷ đơn đã trả hiện có, refundMethod chỉ CASH; có thể gửi reasonCode, reason mô tả.
- GET `/refunds` mặc định toàn bộ lịch sử theo phạm vi; dùng status để lọc. Owner chỉ đọc.
  API hoàn tất PENDING cũ vẫn dành cho Manager và giữ ngữ nghĩa legacy, không tạo PENDING mới.
- PATCH `/counter/orders/:orderId/pager`, CASHIER/MANAGER, `{pagerNumber:23}` hoặc null để gỡ.
- POST `/counter/orders/:orderId/pager/notify`, BARISTA/MANAGER, `{pagerNumber:23}`.
  Chỉ READY và số vẫn khớp. Notify lặp giữ thời điểm đầu; đổi số xóa pagerNotifiedAt.
- Event: menu.prices-updated, menu.availability.changed, manager.order.attention-required,
  order.pager.updated, refund.completed. Các trường pager cũng có trong phản hồi queue/ready.
- POST `/cashier/orders` tạo draft DB đã ngừng: trả 410, dùng checkout với giỏ local.
  Các API xử lý draft cũ giữ lại để tương thích/thu hồi dữ liệu lịch sử; không tạo draft mới.
- Khi giao món, order mới chuyển COMPLETED; vẫn đọc/hoàn được đơn DELIVERED lịch sử.

## DB, backup và Render

Đã áp dụng DB local cấu hình trong .env: `127.0.0.1:5432/smart_fnb`.
Migration cuối: `20261103000700_convert_legacy_toppings`; bao gồm migration GitHub mới nhất.
Không reset, không seed lại dữ liệu. Đối chiếu bản sao lưu: giữ nguyên 7 users, 71 orders, 71 payments, 0 refunds.
Backup custom dump (quyền 600, ngoài repo):
`../.local-backups/SmartFnBBackend/2026-11-03T15-07-15.319Z.dump`.
Đã khôi phục backup sang PostgreSQL tạm và thử migrate thành công trước khi đổi DB đang dùng.
Script sao lưu lần sau: `node scripts/backup-local-db.mjs` (chỉ chấp nhận DB local).

Migration 007 tự chuyển nhóm code TOPPING: giữ ID, giá, trạng thái chi nhánh và liên kết;
copy xong mới gỡ liên kết nhóm cũ; không xoá option/group hoặc JSON lịch sử.
Gặp giá âm/trùng tên mơ hồ thì rollback để xử lý, không tự đoán.
DB local lần này không có nhóm TOPPING nên không có dữ liệu cần chuyển.
File `prisma/data-migrations/v14-legacy-toppings.sql` là bản tương đương có thể chạy lại có kiểm soát.

Unique index pager chỉ chiếm số cho COUNTER_PICKUP/PAID/SUBMITTED/PREPARING/READY.
Lịch sử số không bị xoá khi đơn kết thúc. Combo có CHECK cha/con và FK cùng đơn.
Dùng migrate deploy, không dùng db push để giữ các ràng buộc SQL bổ sung.

```sh
pnpm prisma:migrate:deploy
pnpm prisma:generate
pnpm build
pnpm test
```

Không cần ENV mới. Render `render:start` đã chạy migrate deploy trước start;
DB Render chỉ đổi khi bản BE được deploy, không phải khi chạy migrate trên máy local.
Không xác nhận Render đã deploy chỉ dựa vào việc push GitHub.

## Kiểm chứng

- Full suite sau khi ghép origin/main: 215/215 qua; Prisma validate/build qua.
- DB integration: chuyển topping chạy lại không nhân đôi; giá/stock giữ nguyên;
  tranh pager/hoàn cùng đơn chỉ một giao dịch thành công; pager reset dấu gọi và giải phóng;
  CS-07 hoàn QR trừ két; khoản PayOS muộn chỉ ghi hoàn sau xác nhận trả cash.
- Combo DB: checkout/snapshot/giá override; lỗi một ô giá rollback toàn bộ;
  chỉ con có lượt pha, đủ món mới READY; cả cash và PayOS/webhook lặp không nhân đôi lượt pha;
  giao món, hoàn nguyên combo/hao hụt, từ chối hoàn con; báo cáo doanh thu cha; tự phục hồi khả dụng khi món bật lại.
- Smoke HTTP trên bản sao DB: Nest DI/startup, Swagger có API mới và endpoint yêu cầu đăng nhập.
- Không dùng tiền thật, không gửi email thử, không sửa FE, không gọi AI.

Kiểm thử tích hợp chỉ nhận DB riêng cổng 55439 (đã migrate), không dùng DB dự án:

```sh
V14_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/postgres pnpm test:v14:db
```

Còn ngoài phạm vi BE: giao diện combo/CS-07/pager và thao tác in/máy rung vật lý trên thiết bị;
nghiệm thu Render/FE sau deploy và AI ở lượt riêng.
