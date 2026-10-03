# Branch Manager APIs

All routes use `/api/v1` and Bearer JWT. `/manager/*` requires `MANAGER` and derives the branch from the authenticated employee. Sending `branchId` to override that scope is rejected. Multiple managers can belong to one branch.

| Method      | Path                                           | Purpose                                                                |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| GET / POST  | `/manager/staff`                               | Search or create CASHIER/BARISTA                                       |
| GET / PATCH | `/manager/staff/:employeeId`                   | Read/edit profile, switch between CASHIER and BARISTA                  |
| PATCH       | `/manager/staff/:employeeId/status`            | `{ "status": "SUSPENDED", "reason": "Employee left" }`; ACTIVE unlocks |
| POST        | `/manager/staff/:employeeId/reset-password`    | `{ "password": "NewStrongPass123", "reason": "Forgot password" }`      |
| GET         | `/manager/menu-options`                        | Local availability and effective availability after Owner switches     |
| PATCH       | `/manager/menu-options/:optionId/availability` | `{ "isAvailable": false }`                                             |
| GET         | `/manager/orders`                              | Paginated search, see query fields below                               |
| GET         | `/manager/orders/:orderId`                     | Sale snapshots, creators, payments and related audit                   |
| GET         | `/manager/reports`                             | Branch report                                                          |
| GET         | `/manager/audit-logs`                          | Paginated branch audit; optional `entityId`                            |

Staff creation uses email, password, role, employeeCode, firstName, lastName and optional phone, jobTitle, hireDate, dateOfBirth. Passwords require 8–128 characters, lowercase, uppercase and a digit. Reset does not unlock a locked account. Locking, password resets and role changes revoke sessions. Passwords and hashes are never returned or put into audit. Creating staff counts all non-deleted accounts across the chain, including Owners, and returns 409 at the quota. Manager sees the limit rejection, not subscription details. Staff list supports `search`, `role`, `status`, `page`, `limit`.

Order search supports `search` (partial code or exact numeric call number), `orderCode`, `callNumber`, `from`, `to`, `status`, `paymentStatus`, `paymentMethod`, `type`, `page`, `limit`. Dates filter `placedAt`: from inclusive, to exclusive. Use ISO timestamps with offsets. Call numbers repeat per business day. Payment method matches any payment attempt on the order or table session. Session payments are separately labeled because one session can cover several orders. Historical item/option names and prices come from order snapshots.

Reports accept inclusive local `YYYY-MM-DD` dates `from`/`to`, up to 366 days; default is 30 days ending today. `granularity=day|week|month`, `limit=1..50` for best sellers/cancellation preview. Revenue uses paid non-cancelled orders by `paidAt`; this is sales revenue, not profit. Payment-method totals show settled amounts and actual received amounts separately, so they can differ after manual acceptance of a discrepancy. Hourly counts use placedAt and include all order states. Preparation time excludes queue time and averages completed physical units (legacy kitchen lines when no units exist); absent samples return null. Toppings use option-group codes `TOPPING` or `TOPPINGS`; `topOptions` covers every group. Cancellations use cancelledAt, return reasons and a limited preview; full searchable history is in `/manager/orders?status=CANCELLED` (placedAt filter).

`POST /payments/:paymentId/confirm` keeps CASHIER access for CASH only. Non-cash requires MANAGER plus `reason` and positive `receivedAmount`, optionally `transactionRef`:

```json
{
  "reason": "Verified bank transfer; accepted discrepancy",
  "receivedAmount": 95000,
  "transactionRef": "BANK-123"
}
```

The Manager explicitly accepts settlement of the expected amount. Original `amount` and order total remain unchanged; actual `receivedAmount`, variance, actor, reason and timestamp are recorded. This API does not transfer/refund money. Counter confirmation allocates a call number and queues preparation in the same serializable transaction. Duplicate or racing confirmations return 409 without duplicate units/audit. The normal PayOS webhook remains automatic.

`POST /invoices/:invoiceId/cancel` now requires MANAGER and a nonblank reason, records audit, and only cancels the invoice. It does not implement paid-order cancellation/refunds (BM-06).

Audit is append-only through the API and written in the same transaction as staff changes, option switches, payment confirmation and invoice cancellation. No audit update/delete API exists. Option stock events publish `menu.availability.changed` and `manager.order.attention-required` when paid queued/preparing lines are affected. Re-enabling an option does not automatically restart already flagged lines.

Apply `pnpm prisma:migrate:deploy`, regenerate client with `pnpm prisma:generate`, then restart/rebuild the API. Swagger contains the **Branch Manager** tag. Run `pnpm build` and `node scripts/test-manager.mjs` to test on an automatically created/dropped local PostgreSQL database. The runner refuses a remote DATABASE_URL.
