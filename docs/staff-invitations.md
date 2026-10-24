# Staff onboarding by email

All routes below have the `/api/v1` prefix. Owner may invite MANAGER, CASHIER and BARISTA in their assigned chains; Manager may invite CASHIER and BARISTA only in their own branch. ADMIN does not create restaurant staff.

## Create invitations

Owner: `POST /employees/invitations`

```json
{"name":"Nguyen Van An","email":"an@example.com","role":"CASHIER","branchId":"<branch UUID>"}
```

Manager: `POST /manager/staff` (branch is derived from authenticated Manager, not request body).

```json
{"email":"an@example.com","role":"BARISTA","employeeCode":"BAR-001","firstName":"An","lastName":"Nguyen"}
```

No username or password is accepted. The account starts INACTIVE with `staffInvitationState=PENDING`. Owner creation returns `{account, invitationExpiresAt, emailStatus}`; Manager creation returns account fields with `invitationExpiresAt` and `emailStatus`. Neither exposes password/setup token. `POST /employees/managers` remains an email-only alias.

## Accept invitation

Email opens `${PUBLIC_WEB_URL}/setup-password?token=...`. FE must render a password form and POST `{token,password}` to public `/auth/setup-password`. The existing password validation applies. The SHA-256 token digest is stored in password_setup_tokens; the email outbox holds the delivery payload, so restrict database/outbox access and never expose it to FE.

Links expire after 24 hours and can be consumed once. Acceptance verifies current user, employee, branch, business and subscription before changing the account to ACTIVE / ACCEPTED. Pending or cancelled invitations cannot authenticate even if status was accidentally set ACTIVE.

## Manage invitations

| Action | Owner | Manager |
| --- | --- | --- |
| List | GET /employees | GET /manager/staff |
| Resend | POST /employees/:id/invitation/resend | POST /manager/staff/:id/invitation/resend |
| Cancel | POST /employees/:id/invitation/cancel | POST /manager/staff/:id/invitation/cancel |
| Reset password by email | POST /employees/:id/reset-password | POST /manager/staff/:id/reset-password |
| Lock/unlock | PATCH /employees/:id/status | PATCH /manager/staff/:id/status |

Resend/cancel/reset body: `{ "reason": "Useful reason, 3–500 characters" }`. Status adds `status: ACTIVE | INACTIVE | SUSPENDED`. Resend invalidates the previous link, revokes sessions and enforces a 60-second cooldown (429). Pending accounts cannot be manually activated (409); they must accept the invitation. Locked/cancelled accounts cannot reset or activate via email. A locked pending account can be returned to INACTIVE and then resent.

Cancellation retains the account for audit, disables it and invalidates tokens/sessions. It does not free the email or account quota. Existing and pending accounts count toward the subscription quota, including Owner accounts; creation is serialized per chain and returns 409 at the limit or on concurrent serialization conflict (retry). List responses include `user.staffInvitationState`; null means a legacy account. Owner lists expose only the latest token expiry, never its hash/value. Manager lists also have `invitationStatus` and `invitationExpiresAt`.

Audit records include initiating user ID, role, target and reason. Owner audit actorEmployeeId is null. Email is delivered only after the transaction commits; PENDING/FAILED emailStatus means the account exists but delivery is not confirmed. Correct email configuration and resend rather than creating the account again.

## Deployment / compatibility

1. Apply migration with `pnpm prisma:migrate:deploy` against the intended database before starting the new build. Existing active accounts are preserved; inactive accounts with unused setup tokens are backfilled as PENDING.
2. Configure `PUBLIC_WEB_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` using the existing email/Resend configuration and a verified sender. Do not put these secrets in FE.
3. Deploy FE's setup-password page and update creation forms to send email rather than username/password.
4. Smoke test invitation, pending-login denial, acceptance, login, resend, cancellation and cross-branch denial in staging.

Removed routes: `POST /auth/managers`, `POST /auth/staff`, `POST /employees/accounts`. Existing username/password logins remain supported; legacy non-email accounts retain the Owner password-reset endpoint. New email accounts must use email password setup. No production migration or email delivery is performed by the local tests.
