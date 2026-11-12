# Backend v17.3 — phần Bảo (Cashier, Barista, Payment)

## Phạm vi

Tài liệu này ghi lại phần triển khai theo `Việc BE còn thiếu theo đặc tả v17.3.docx`:

- Sổ giao dịch bán hàng bất biến (`cash_ledger_entries`).
- Phiếu hoàn tiền PDF (đã có sẵn trên `main`, đã đối chiếu và chạy lại test).
- Tự huỷ QR PayOS và đơn chưa thanh toán khi QR hết hạn.
- Khoá ghép màn hình khách theo quầy sau 5 mã sai liên tiếp trong 5 phút.
- Barista, Cashier và Store Manager đều được xác nhận đã gọi thẻ rung.
- WAITER/KITCHEN bị loại khỏi tập vai trò đăng nhập và khỏi lựa chọn tạo/lọc nhân viên; các route
  phục vụ bàn/bếp cũ đã được xoá từ `main` trước thay đổi này.

## Sổ giao dịch

Mỗi khoản thu/chi được ghi trong cùng transaction với nghiệp vụ nguồn. Khoá duy nhất
`(source_type, source_id)` chống ghi trùng; trigger PostgreSQL chặn `UPDATE` và `DELETE` để bảng
thực sự append-only.

Nguồn thu hỗ trợ: tiền mặt, webhook PayOS, PayOS recheck và Store Manager xác nhận tay. Khoản
hoàn đã hoàn tất được ghi là `OUTFLOW`.

API đọc:

- `GET /api/v1/branches/{branchId}/cash-ledger?from=&to=` — Store Manager đúng chi nhánh hoặc
  Brand Manager có quyền.
- `GET /api/v1/restaurant-chains/{chainId}/cash-ledger?from=&to=` — Brand Manager được phân công.

Response có tối đa 500 dòng mới nhất và tổng `inflow`, `outflow`, `net`.

### Backfill dữ liệu cũ

Sau khi deploy migration, chạy đúng một lần trên môi trường dùng chung:

```bash
pnpm ledger:backfill
```

Script có thể chạy lại an toàn vì dùng `skipDuplicates`. Dữ liệu PayOS lịch sử không lưu nguồn
webhook/recheck riêng nên backfill gắn nguồn mặc định `PAYOS_RECHECK`; dữ liệu mới ghi đúng nguồn.

## QR PayOS hết hạn

Worker gọi API huỷ payment link PayOS trước. Khi PayOS xác nhận huỷ thành công, BE chuyển payment
sang `EXPIRED`, tự huỷ đơn `UNPAID` còn ở `PENDING/CONFIRMED`, và phát sự kiện
`payment.expired`. Nếu PayOS lỗi, worker giữ payment để lượt sau thử lại, không giả vờ đã huỷ.

Biến môi trường liên quan:

```env
PAYMENT_EXPIRY_JOB_ENABLED=true
PAYMENT_EXPIRY_JOB_INTERVAL_MS=60000
PAYMENT_EXPIRY_BATCH_SIZE=100
PAYOS_MASTER_KEY=<base64-32-byte-key>
```

## Khoá ghép màn hình

Hai cột `pairing_failed_attempts` và `pairing_locked_until` nằm trong `pos_stations`, nên restart
Render không làm mất trạng thái. Sai mã lần thứ 5 sẽ khoá quầy 5 phút và ghi audit
`DISPLAY_PAIRING_LOCKED`. Ghép thành công đặt lại bộ đếm. Trong thời gian khoá API trả HTTP 429,
mã `PAIRING_LOCKED` và `lockedUntil`.

## Phiếu hoàn tiền PDF

Luồng hiện có đáp ứng: sinh sau khi refund commit, một document/refund, trạng thái retry được,
PDF/PNG, link R2 ký 10 phút, phân quyền theo chi nhánh/chuỗi và lý do in lại. Lỗi lưu/PDF không
rollback khoản hoàn.

## Kiểm thử

```bash
pnpm test:bao-v173
pnpm prisma validate
```

Bộ test riêng bao phủ ledger idempotent và scope, quyền pager, khoá ghép màn hình, QR hết hạn,
payment settlement, refund và refund PDF.
