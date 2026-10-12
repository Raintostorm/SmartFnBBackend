# PayOS expiry and late payment handling

This contract covers issues #45 and #61 for counter orders.

## States

- A PayOS payment becomes `EXPIRED` when PayOS reports `EXPIRED` or its local `expiresAt` has passed.
- Expiration does not cancel the order automatically. The order remains unpaid so the Cashier can choose another payment method or cancel it.
- If PayOS later confirms money for that expired payment, the payment becomes `REQUIRES_ATTENTION` and the order becomes `REQUIRES_ATTENTION` with reason `PAYMENT_RECEIVED_AFTER_EXPIRY`.
- A late payment never allocates a call number, creates preparation units, creates print jobs, or sends work to the Barista.
- If the order was already cancelled, the existing #43 flow keeps it cancelled and creates one pending external refund.

## Realtime

- `payment.expired` tells branch clients that a QR can no longer be used.
- `manager.order.attention-required` with reason `PAYMENT_RECEIVED_AFTER_EXPIRY` tells Manager clients to review money received after expiry.

All transitions lock the payment row and are idempotent. The normal PayOS webhook and Cashier recheck use the same settlement service.
