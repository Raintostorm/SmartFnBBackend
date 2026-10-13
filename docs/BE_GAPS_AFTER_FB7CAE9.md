# Backend fixes after fb7cae9

## Scope

This change set closes the Cashier, Barista and Manager backend gaps reported after commit
`fb7cae9`.

## Completed contracts

| Issue    | Backend behavior                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #47, #76 | Manager payment-method totals use paid counter orders only. Dine-in payments are excluded.                                                                                             |
| #75      | A Manager can confirm a PayOS payment received after QR expiry, or cancel the order and create a refund for the actual received amount.                                                |
| #45      | An in-process worker expires overdue PayOS payments without requiring a user to open the order. Database locking and idempotent settlement make repeated and multi-instance runs safe. |
| #51, #77 | Cashier checkout emits `cashier.order.updated`; payment expiry emits `payment.expired`; amount mismatch records its first attention time and reason.                                   |
| #52      | Cash payments persist the POS station and Manager order details expose it through the existing payment relation.                                                                       |
| #58      | Equal PayOS webhook deliveries are serialized by a PostgreSQL advisory transaction lock and the idempotency record.                                                                    |
| #63      | `PATCH /manager/staff/:id` accepts `phone: null`; this was already implemented and remains covered by the contract.                                                                    |
| #65, #67 | Amount mismatch has `attentionAt`/`attentionReason`; an overdue QR becomes `EXPIRED` using its existing `expiresAt`.                                                                   |
| #70      | Pairing-code creation removes expired/consumed rows and limits each client address to ten requests per minute.                                                                         |
| #29      | `maxTables` is optional when creating a service plan. A compatibility value remains in storage until the legacy table domain is removed separately.                                    |
| #34      | Duplicate station names now return `409` with `STATION_NAME_ALREADY_EXISTS` for create and update.                                                                                     |

## API and state changes

### Cashier checkout and reporting

- `POST /cashier/checkout` still owns the counter checkout flow and now publishes
  `cashier.order.updated` after a successful commit.
- Cash payments store `stationId`, allowing Manager order details to identify the originating POS
  station.
- `GET /manager/reports` builds every revenue section from the same set of paid counter orders.
  Payment-method totals no longer include table-session/DINE_IN payments.
- Report date boundaries are converted from the branch timezone to UTC in the application before
  querying PostgreSQL. This avoids different results between local PostgreSQL and Render.

### QR expiry and late PayOS money

Normal state progression:

```text
PENDING --expiry worker--> EXPIRED
EXPIRED --late PayOS money--> REQUIRES_ATTENTION
REQUIRES_ATTENTION --Manager confirms--> SUCCESS + order SUBMITTED
REQUIRES_ATTENTION --Manager cancels--> order CANCELLED + refund record
```

- A late payment stores the actual received amount and reason
  `PAYMENT_RECEIVED_AFTER_EXPIRY`.
- The related order stores `attentionAt` and `attentionReason` so Web can show accurate waiting
  time and the correct attention category.
- A Manager may accept the payment or cancel the order. Cancelling creates a refund using the
  actual received amount, not the original expected amount.
- Concurrent manual confirmations are serialized with row locks. One request succeeds; a losing
  request receives HTTP `409` and cannot duplicate preparation units, print jobs or audit logs.

### Webhook idempotency

- PayOS webhook signature verification is unchanged.
- Equal provider events acquire a PostgreSQL transaction advisory lock before reading the
  idempotency record.
- `RECEIVED`, `PROCESSED` and `REJECTED` records are treated as already claimed, preventing two
  Render instances from settling the same payment concurrently.

### Station validation

Creating or renaming a station to a name already used by that branch returns:

```json
{
  "statusCode": 409,
  "code": "STATION_NAME_ALREADY_EXISTS",
  "message": "A station with this name already exists in the branch"
}
```

Blank station names are rejected with HTTP `400` before accessing the database.

## Render configuration

The payment-expiry worker runs inside the NestJS process and does not require Docker or an
operating-system cron job.

```env
PAYMENT_EXPIRY_JOB_ENABLED=true
PAYMENT_EXPIRY_JOB_INTERVAL_MS=60000
PAYMENT_EXPIRY_BATCH_SIZE=100
```

The interval must be at least 10 seconds. Keep the worker enabled on Render. Multiple instances may
scan the same rows, but `markExpired` locks each payment and only the first state change publishes
the expiry event.

No new database migration is required for this change set. Render only needs to deploy the new
application commit and receive the three environment variables above. The defaults are safe for
one-minute expiry checks.

## Compatibility decisions

### Draft orders #49

`POST /cashier/checkout` is the current POS path. Legacy draft endpoints remain temporarily so an
older Mobile build is not broken. They should be removed only after every deployed Mobile build no
longer calls `POST /cashier/orders` and its item-edit routes.

### Customer display snapshots #55

The database snapshot is deliberately retained for now. Render can restart or sleep, so removing
the snapshot before a shared cache exists would make a paired customer display lose its current
cart after reconnecting. Event-name migration must be coordinated with both Mobile repositories;
removing persistence is a separate breaking migration.

## Verification

Run before merge:

```bash
pnpm typecheck
pnpm test
pnpm prisma:validate
node scripts/test-manager.mjs
```

The Manager integration runner creates a uniquely named local PostgreSQL database and always drops
that database after the run. It must never point at Render or a shared database.

Verified for this implementation:

- TypeScript typecheck passed.
- Prisma schema validation passed.
- Unit and contract suite passed: 145/145 tests.
- PostgreSQL integration cases for branch-timezone reporting and concurrent payment confirmation
  passed against a temporary migrated database.
