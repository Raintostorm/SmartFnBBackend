# V14 — Cashier, Barista và AI

Ngày: 03/11/2026. Căn cứ: `documentation/Smart-FnB-Dac-ta-v14.docx` ở workspace cha.

## Đợt 1: giá món theo chi nhánh — đã viết code, chưa deploy

- `BranchMenuItem.priceOverride`: Decimal nullable; null dùng giá chuỗi, 0 là giá thật.
- Brand Manager (API role hiện OWNER):
  `PUT /api/v1/restaurant-chains/:chainId/menu/items/:itemId/branches/:branchId/price`.
- Body bắt buộc `{ "priceOverride": 35000 }` hoặc `{ "priceOverride": null }`.
- Chỉ chuỗi được phân quyền, gói còn quyền ghi, chi nhánh đúng chuỗi và món đã gán vào chi nhánh.
- Response thêm chainPrice, effectivePrice, priceOverride, warnings.
- Giá dưới 50% hoặc trên 200% giá chuỗi vẫn lưu, cảnh báo PRICE_OUTSIDE_CHAIN_RANGE.
- Ghi giá và audit cùng transaction, event phát sau commit. Audit cho Owner dùng user ID;
  actor_employee_id đổi nullable vì Owner không có Employee. Không giả mạo employee ID.
- Cashier context: menuItem.price là giá hiệu lực để tương thích Mobile cũ, thêm chainPrice.
- Checkout tự tính giá DB + option, không nhận giá client; đơn đã chốt giữ snapshot.
- Barista không nhận override, giá chuỗi, giá vốn, phụ thu option.
- Đổi giá chuỗi giữ nguyên override. Phát menu.prices-updated cho các chi nhánh liên quan.
- Mobile nghe socket/reconnect, tải dự phòng 5 giây; tính lại giỏ chưa chốt, không đổi đơn/QR đã chốt.
- Màn khách nhận giỏ tính lại qua luồng hiện có. Chưa có combo, API đợt này chỉ hỗ trợ món.

### Migration

`20261103000100_branch_menu_prices`: thêm cột và CHECK không âm, nới nullable audit.
Không drop bảng, không seed, không sửa snapshot cũ. **Chưa áp dụng lên DB local hoặc Render.**

Tại backend:

```sh
pnpm prisma:migrate:deploy
pnpm prisma:generate
pnpm build
pnpm test
```

Render dùng render:start chạy migrate deploy trước start. Code mới phải đi cùng migration;
không chạy Prisma mới với DB chưa có cột. Không cần ENV mới. Không đổi ENV Mobile.

### Kiểm chứng

- BE build và Prisma validate qua.
- Full suite BE: 176/176 qua trước khi bổ sung 3 ca cuối.
- Bộ giá chi nhánh cuối: 8/8 qua, bao gồm không lộ giá Barista, audit lỗi không phát event,
  đổi giá chuỗi không ghi override và phát thông báo.
- Mobile TypeScript qua; lint file thay đổi kiểm riêng.
- Chưa E2E DB thật/emulator/màn khách/Render. Unit test dùng mock không thay integration test.

## Các đợt tiếp theo — chưa triển khai

### 2. Topping theo món — có code đợt 2, còn migration dữ liệu và E2E

Thư viện extra chuỗi; item-extra có giá/giới hạn 1–5 và tổng mỗi ly.
Trạng thái chuỗi/chi nhánh; Barista báo hết; snapshot giá và số lượng.
Migration topping cũ một lần, đối chiếu trước khi vô hiệu hóa đường cũ.
POS +/−; bill/màn khách hiển thị; Barista chỉ tên/số lượng.
Test giới hạn, cross-tenant, hết topping lúc checkout và nhiều ly.

### 3. Combo

2–6 thành phần, số lượng 1–5; cố định hoặc chọn từ 2–10 món.
Giá chuỗi/chi nhánh + phụ thu + option/extra; snapshot đầy đủ.
Cha tính tiền, con giá món gốc 0 và sinh unit pha theo món + size.
Hết thành phần ảnh hưởng khả dụng, không lưu cờ tự tắt vĩnh viễn.
Chỉ hoàn nguyên combo; báo cáo không tính trùng doanh thu.

### 4. Hoàn tiền mặt CS-07

Cashier trong ngày bán Việt Nam; Store Manager cả lịch sử; đúng chi nhánh.
Mọi phương thức gốc hoàn tiền mặt; bỏ tạo mới pending bank-transfer refund.
Giữ khoản hoàn cũ, không xóa lịch sử; kế hoạch chuyển dữ liệu phải riêng biệt.
Hoàn toàn đơn/nguyên dòng/combo, BE tính tiền; lý do bắt buộc, OTHER >=5 ký tự.
Khóa chống trùng; cập nhật prep/order/pager/audit/phiếu hoàn.
Trừ doanh thu ngày hoàn; tiền mặt quầy trừ cả hoàn đơn QR.
Test đua webhook/xác nhận tay/hoàn và truy cập chéo.

### 5. Máy rung

Gán số 1–999 không trùng đơn mở trong chi nhánh; đổi số xóa dấu đã báo.
Prep API/events có pagerNumber/pagerNotifiedAt; giải phóng khi hoàn tất/hủy.
Barista bấm máy thật rồi đánh dấu, không tích hợp phần cứng radio.

### 6. AI

Đã có SmartFnB-AI, Ollama và qwen3.5:9b; không tải lại model.
Gateway 11435/Ollama 11434 chưa phản hồi lúc kiểm tra. Test hiện có 11/11 qua.
Chưa tìm thấy Tesseract trong PATH; chưa kiểm mọi Python environment.

- Benchmark OCR Việt và Qwen hiện có trước khi chọn công cụ.
- 1–5 PNG/JPG/WebP, 10 MB/ảnh, Brand Manager đúng chuỗi, quota 20 lượt/ngày.
- Job nền: OCR raw text/vị trí/confidence -> Qwen cấu trúc -> schema -> draft DB.
- Một retry schema sai; trạng thái xử lý/duyệt/nhập/lỗi/hủy; draft hết hạn 7 ngày.
- Không sinh mô tả/tên/giá; thiếu giá null; xử lý size/extra/trùng cùng danh mục.
- Người dùng sửa rồi import atomic/audit, giữ branch override, không tự tạo combo.
- Ảnh 30 ngày, giữ kết quả/lịch sử; tránh ổ Render tạm.
- Gateway HTTPS có secret, Ollama nội bộ; Render không gọi localhost Mac.
- >=10 ảnh ground truth; đo OCR/structure/edit count; <=60s/ảnh, <=3phút/5ảnh.

## Kiểm thử cuối

Cashier -> tiền mặt/QR -> Barista -> nhận món/hoàn -> bill/phiếu hoàn;
mất/nối socket, thiết bị thu hồi, read-only, cross-tenant.
Cập nhật Swagger, hợp đồng FE, ENV hướng dẫn, kết quả kiểm thử trước push/merge.

## Cập nhật đợt 2: topping theo món và thử AI local

### Code topping đã thêm

- Bảng menu_extras, menu_item_extras, branch_menu_extras và menu_items.max_extras.
- API Owner/Brand Manager (prefix /restaurant-chains/:chainId/menu):
  GET/POST extras; PUT extras/:extraId; GET/PUT items/:itemId/extras.
  Gán món: `{maxExtras:5, extras:[{extraId:"uuid",price:5000,maxQuantity:3}]}`.
- PATCH /menu-extras/:extraId/availability: Store Manager/Barista, chi nhánh từ tài khoản.
- Checkout `extras:[{extraId,quantity}]` là số topping trên MỖI LY. Giá dòng = giá mỗi ly x số ly.
- Snapshot trong selectedOptions có kind=EXTRA, quantity, unitPrice và priceDelta tổng topping mỗi ly.
- Kiểm trùng ID, giới hạn 1–5/topping, giới hạn tổng/món, liên kết cùng chuỗi, bật/tắt chuỗi/chi nhánh.
- Thu tiền mặt kiểm lại khả dụng extra; đơn cũ không đổi giá khi extra đổi giá.
- POS có stepper topping, màn khách/bill có số lượng; Barista có công tắc extra và không nhận giá.
- PDF bill hiển thị +số lượng tên topping từ snapshot.
- Migration 20261103000200_item_extras chỉ thêm dữ liệu/cấu trúc; CHƯA áp dụng DB.
- Chưa chuyển đổi dữ liệu option topping cũ; giữ nguyên option và đơn lịch sử, tránh tự đoán nhóm cũ.
  Phải kiểm tra nhóm topping thực tế và migrate có đối chiếu trước khi vô hiệu hóa option cũ.
- Chưa nối combo (giai đoạn tiếp theo). Chưa kiểm E2E DB thật và thiết bị in.
- BE full suite cuối đợt 2: 187/187 qua. Mobile TypeScript/lint các file thay đổi qua.

### AI

- Gateway local đã chạy tại http://127.0.0.1:11435, Ollama tại 11434, qwen3.5:9b đã có sẵn.
- Thêm OCR Apple Vision trên macOS: source tại SmartFnB-AI/scripts/macos-ocr.swift.
- Thêm pipeline OCR -> Qwen text -> kiểm bằng bằng chứng dòng OCR, giá không có bằng chứng => null.
- Đây là gateway local thử nghiệm; CHƯA có job nền/draft DB/atomic import hoặc host public cho Render.
- Apple Vision không chạy trên Render Linux. Khi deploy cần máy host macOS riêng hoặc adapter OCR khác.
- Báo cáo ảnh thực tế, nguồn và giới hạn tại SmartFnB-AI/PUBLIC_MENU_TEST.md ở workspace cha.

## Cập nhật tiếp theo 03/11/2026 — AI tạm hoãn

Đã bổ sung pager, CS-07 BE, cashDrawer, cảnh báo topping lưu DB và script chuyển topping có kiểm tra.
Kết quả và giới hạn mới nhất: [V14_POS_BACKEND_PROGRESS.md](V14_POS_BACKEND_PROGRESS.md).
Các đoạn “chưa triển khai” ở trên là trạng thái đợt trước. Combo vẫn chưa triển khai;
không xác nhận toàn bộ v14 đã xong. Migration và script dữ liệu chỉ thử trên PostgreSQL tạm.
