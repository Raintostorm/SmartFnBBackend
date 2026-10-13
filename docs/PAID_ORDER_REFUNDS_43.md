# Paid order cancellation and external refunds

This document describes backend issue #43 for BM-06, BR-28, BR-49 and BR-50. The platform never transfers refund money and never calls a PayOS refund API. It records what the restaurant must return and whether that external refund has been completed.

## API

### Cancel a paid order or selected lines

`POST /api/v1/manager/orders/{orderId}/cancel-paid`

Role: `MANAGER` of the order branch.

```json
{
  "reason": "Khách đổi ý",
  "refundMethod": "BANK_TRANSFER",
  "orderItemIds": ["order-item-uuid"]
}
```

- Omit `orderItemIds` or send an empty array to cancel the entire order.
- Send one or more line IDs to cancel only those lines.
- `reason` is required and contains 3–500 characters.
- `refundMethod` is `CASH` or `BANK_TRANSFER`.
- Cash refunds are recorded as `COMPLETED` immediately.
- Bank-transfer refunds are created as `PENDING`.
- An `AMOUNT_MISMATCH` underpayment can only be cancelled in full. Its refund amount is the actual `receivedAmount`.
- Delivered, completed and already cancelled orders return HTTP 409.
- Cashier and Barista receive HTTP 403.

The operation locks the payment before the order and runs in a serializable transaction. It cancels the selected preparation units, restores only portions that had not started preparation, records prepared lines as wastage, cancels pending print jobs for a full cancellation, and writes an audit record.

### PayOS money received after cancellation

If a valid PayOS webhook arrives after its order has already been cancelled, the backend keeps the order `CANCELLED`, records the payment as `SUCCESS`, and creates exactly one `PENDING` bank-transfer refund for the amount actually received. It never restores the order or sends it back to the preparation queue. Manager clients receive `manager.order.attention-required` and `refund.pending` events so staff can return the money externally and then complete the refund through the endpoint below.

### Complete an external bank refund

`POST /api/v1/refunds/{refundId}/complete`

Roles: `OWNER` of the chain or `MANAGER` of the branch.

```json
{
  "note": "Đã chuyển khoản cho khách"
}
```

Only a `PENDING` `BANK_TRANSFER` refund can be completed. Repeating the operation returns HTTP 409.

### Read refunds

`GET /api/v1/manager/orders/{orderId}` includes refunds and their affected order lines.

`GET /api/v1/manager/orders?refundStatus=PENDING` filters orders that still have an unresolved refund.

## Realtime events

- `order.cancelled` is sent to the branch and calling display after the transaction commits.
- `refund.pending` is sent to the branch for an external bank refund.
- `manager.order.attention-required` is sent when PayOS confirms money after cancellation.
- `refund.completed` is sent after an Owner or Manager records completion.

## Reporting

Reports keep the original sale on its payment date. Refund obligations are subtracted on `cancellationDate`, including pending external transfers. Responses expose gross revenue, refund amount, pending refund amount and net revenue. This prevents a cancellation today from rewriting a previous day's sales.

## Render deployment

The migration `20261011100000_paid_order_refunds` is additive. Render already runs `pnpm prisma:migrate:deploy` before starting the API, so no manual SQL step is required. Deploy the backend before enabling the real #43 web controls.
