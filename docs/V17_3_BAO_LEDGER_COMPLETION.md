# V17.3 — Bảo: cash ledger and retired-flow completion

## Scope

This change completes the remaining Backend work assigned to Bảo in the latest
V17.3 gap report. It affects Cashier/Barista support APIs and management reports;
it does not add back table-service workflows.

## Cash ledger contract

Existing paths are preserved:

- `GET /api/v1/branches/{branchId}/cash-ledger`
- `GET /api/v1/restaurant-chains/{chainId}/cash-ledger`

Both endpoints accept `from`, `to`, `direction`, `sourceType`, `paymentMethod`,
`cashierId`, `page`, and `pageSize` (maximum 100). The response contains:

- paginated ledger rows;
- branch, order code, call number, business date, Vietnam display time, actor,
  and refund reason/note;
- summary values `cashCollected`, `qrCollected`, `cashRefunded`, `netCash`, and
  `netTotal`;
- per-branch summaries on the chain endpoint.

All refund outflows are recorded as `CASH`, including refunds of orders that were
originally paid through PayOS. A partial unique database index guarantees only
one inflow for each payment even if webhook, recheck, and manual confirmation
race. The existing source idempotency key remains in place.

## Reports

The Branch Manager report cancellation preview now returns:

- `cancelledBy` with employee identity;
- a `refunds` list containing requested/completed actors, status, amount, reason,
  and note.

## Removed V17.3-incompatible surfaces

- Removed `POST /api/v1/refunds/{refundId}/complete`, the legacy bank-transfer
  refund completion endpoint.
- Removed attendance, shift-template, assignment, and work-session controllers
  from the application.
- Removed `WAITER` and `KITCHEN` from the application role enum and all active
  authorization declarations. `BARISTA` retains access to kitchen/bar areas.

Legacy database tables and old role rows are not dropped by this change. Keeping
them avoids destructive production migration while the corresponding APIs and
identities are no longer reachable by the running application.

## Deployment

Render runs migrations through `pnpm prisma:migrate:deploy` before starting the
API. Migration `20261113110000_ledger_payment_uniqueness` deduplicates historical
payment inflows while temporarily disabling the append-only deletion trigger,
then restores the trigger and creates the partial unique index.

## Verification

Run:

```bash
CI=true pnpm --config.manage-package-manager-versions=false build
pnpm --config.manage-package-manager-versions=false test
pnpm --config.manage-package-manager-versions=false prisma:validate
```
