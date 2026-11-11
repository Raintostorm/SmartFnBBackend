# Password reset v17.3

## Public API for mobile Cashier/Barista

All paths below are relative to `/api/v1`. These endpoints require no access token.

1. `POST /auth/password-reset-requests` with `{ "email": "cashier@example.com" }`.
   Within the IP limit the response is `202` and always says `Nếu email đúng, hướng dẫn đặt lại đã được gửi đi`, including for unknown, locked, or cancelled accounts. The sixth request from the same IP in one hour returns `429` with the same generic wording.
2. For an eligible Cashier or Barista, the backend sends a one-time link to the account email. It expires in 30 minutes. One email is allowed per account in 2 minutes, at most five in one hour. Requesting a link does **not** invalidate the current password or sessions.
3. The email opens the public web page `/setup-password?token=…` on phone or tablet. For a native password form, call `GET /auth/password-reset/verify?token=…`, then `POST /auth/password-reset/confirm` with `{ "token": "…", "newPassword": "…" }`. The password must contain at least 8 characters, one letter and one digit, differ from the account email and previous password. A successful confirmation revokes existing sessions and the old password. Login again with the new password.

The mobile app only needs to add the Forgot password entry and can open the web link; this repository does not change mobile UI.

## Management roles

Store Manager → Brand Manager of its chain; Brand Manager → Platform Staff or Platform Admin; Platform Staff → Platform Admin. Platform Admin has no public forgot-password flow. A request is visible at `GET /password-reset-requests` and the badge count at `GET /password-reset-requests/count`. Superiors use `POST /password-reset-requests/:id/approve`, `POST /password-reset-requests/:id/reject` with `{ "note": "…" }`, or `POST /password-reset-requests/:id/resend` if the approved link needs replacement. An approval immediately invalidates the old password and sessions and sends a 24-hour link to the account email. Requests expire after 24 hours.

Realtime events `password-reset.requested` and `password-reset.resolved` are sent on the `/operations` namespace to the `platform` room or the relevant chain room. The same changes also appear as `operations.updated` for existing web subscribers. Always reload the REST list or count when an event arrives.
