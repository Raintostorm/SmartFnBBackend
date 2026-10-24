# PayOS payment confirmation and recovery

## Purpose

Cashier QR payments normally finish through the PayOS webhook. The recovery flow prevents a paid
order from remaining `PENDING` when that webhook is delayed, rejected, or never reaches Render.

## Confirmation flow

1. The cashier creates one PayOS payment for the finalized order.
2. PayOS sends the signed callback to
   `POST /api/v1/webhooks/payos/{webhookCode}`.
3. The backend verifies the signature and settles the payment through the shared settlement service.
4. The backend marks the order paid, assigns its call number, queues preparation, and emits realtime
   events for the cashier, barista, customer display, and calling display.

Settlement is idempotent. A webhook, a cashier recheck, and the recovery worker may race without
charging or submitting the order twice.

## Recovery paths

- The Mobile cashier screen polls the order and calls
  `POST /api/v1/cashier/payments/{paymentId}/payos/recheck` every 10 seconds while the QR is open.
- Mobile also rechecks when the app returns to the foreground and exposes a **Kiểm tra lại** button.
- The pending order and payment identifiers are stored per employee and branch, so closing or
  refreshing the app restores the same checkout instead of creating another QR.
- Render runs `PayosReconciliationWorker`. It rechecks a bounded batch of recent pending payments
  directly with PayOS every 30 seconds.
- Cancelling an unpaid order first cancels its pending PayOS payment, preventing money from arriving
  on a QR that the cashier already discarded.

## Render environment

```env
PAYOS_RECONCILIATION_JOB_ENABLED=true
PAYOS_RECONCILIATION_JOB_INTERVAL_MS=30000
PAYOS_RECONCILIATION_LOOKBACK_MS=1800000
PAYOS_RECONCILIATION_BATCH_SIZE=20
```

`PAYOS_MASTER_KEY` remains required to decrypt each restaurant chain's PayOS channel credentials.

## Important PayOS configuration rule

The Smart F&B subscription merchant and a restaurant payment channel must not share one PayOS
credential set. PayOS stores one webhook URL per payment channel; confirming a second URL with the
same credentials can replace the first URL.

- `PLATFORM_PAYOS_*`: Smart F&B Owner subscription payments only.
- Credentials entered through `PUT /restaurant-chains/{chainId}/payos-channel`: customer payments
  for that restaurant chain only.

After changing Render's public URL or a restaurant channel, save the channel again so the backend
confirms its current per-channel webhook URL with PayOS.

## Verification checklist

1. Create a QR from Mobile and transfer the exact amount with the generated description.
2. Confirm the order changes from `CONFIRMED/UNPAID` to `SUBMITTED/PAID` without restarting Mobile.
3. Temporarily block the webhook, pay another QR, and verify automatic recheck recovers it within
   about 10–30 seconds.
4. Close Mobile while a QR is pending, reopen with the same employee and station, and verify the same
   order and QR are restored.
5. Cancel an unpaid QR order and verify PayOS no longer accepts payment on that QR.
