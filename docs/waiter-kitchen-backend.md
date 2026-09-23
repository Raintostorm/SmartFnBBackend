# Waiter and Kitchen Staff backend flow

## Implemented flow

1. A Waiter creates a draft order for an open table session.
2. The Waiter adds available branch menu items and submits the order.
3. Submission atomically reserves limited portions and moves every item to `QUEUED`.
4. Kitchen Staff sees the branch queue and atomically moves an item from `QUEUED` to `PREPARING`.
5. Kitchen Staff moves the item to `READY`; the same transaction creates one serving task.
6. A Waiter claims the serving task and confirms service, moving the item to `SERVED`.
7. The order status is derived from all of its items after every kitchen or serving transition.
8. The Waiter may show a live bill preview on the tablet, but cannot create or confirm payment.
9. Manager/Cashier creates and confirms payment, then issues the immutable internal invoice snapshot.

All reads and writes are restricted to the employee's assigned branch. Role guards additionally keep Waiter and Kitchen Staff endpoints separate.

## API routes

| Role          | Method and route                                  | Purpose                                                                  |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Waiter        | `GET /api/v1/waiter/orders/context/current`       | Load the branch, tables, sessions, menu, orders, and active work session |
| Waiter        | `POST /api/v1/waiter/orders`                      | Create a draft order for an open table session                           |
| Waiter        | `GET /api/v1/waiter/orders/:orderId`              | View an order and its items                                              |
| Waiter        | `POST /api/v1/waiter/orders/:orderId/items`       | Add an available item to a draft order                                   |
| Waiter        | `POST /api/v1/waiter/orders/:orderId/submit`      | Reserve portions and send items to the kitchen                           |
| Kitchen Staff | `GET /api/v1/kitchen/queue`                       | List queued and preparing items, oldest first                            |
| Kitchen Staff | `POST /api/v1/kitchen/items/:itemId/start`        | Start preparing a queued item                                            |
| Kitchen Staff | `POST /api/v1/kitchen/items/:itemId/ready`        | Mark an item ready and publish a serving task                            |
| Kitchen Staff | `POST /api/v1/kitchen/items/:itemId/unavailable`  | Report an unavailable item with a reason                                 |
| Waiter        | `GET /api/v1/waiter/serving-tasks`                | List available or personally claimed serving tasks                       |
| Waiter        | `POST /api/v1/waiter/serving-tasks/:taskId/claim` | Claim a ready item for service                                           |
| Waiter        | `POST /api/v1/waiter/serving-tasks/:taskId/serve` | Confirm that the claimed item was served                                 |
| Waiter        | `GET /api/v1/table-sessions/:id/bill-preview`     | Show the current provisional bill on the tablet                          |
| Manager       | `POST /api/v1/table-sessions/:id/payments`        | Create pending cash/QR payment                                           |
| Manager       | `POST /api/v1/payments/:id/confirm`               | Confirm successful payment                                               |
| Manager       | `POST /api/v1/table-sessions/:id/invoices`        | Freeze the paid session as an internal invoice snapshot                  |
| Manager       | `GET /api/v1/invoices/:id/print`                  | Load browser-printable thermal-bill data                                 |

## State rules

The shared state machine in `src/modules/orders/order-state-machine.ts` is the single source of truth:

```text
PENDING -> QUEUED -> PREPARING -> READY -> SERVED
              \            \
               +------------+-> OUT_OF_STOCK
```

Conditional database updates prevent two Kitchen Staff members from starting the same item and prevent two Waiters from claiming the same serving task. A stale serving claim can be reclaimed after the configured timeout.

## Environment configuration

| Variable                             |      Default | Meaning                                         |
| ------------------------------------ | -----------: | ----------------------------------------------- |
| `OPERATIONS_DEFAULT_PAGE_SIZE`       |         `20` | Default kitchen/serving queue page size         |
| `OPERATIONS_MAX_PAGE_SIZE`           |        `100` | Maximum accepted queue page size                |
| `OPERATIONS_MAX_ITEMS_PER_ORDER`     |         `50` | Maximum number of line items in an order        |
| `SERVING_TASK_CLAIM_TIMEOUT_SECONDS` |        `300` | Time before an abandoned claim may be reclaimed |
| `INVOICE_NUMBER_PREFIX`              |        `INV` | Prefix used for immutable internal bill numbers |
| `REALTIME_ENABLED`                   |       `true` | Enable authenticated Socket.IO updates          |
| `REALTIME_PATH`                      | `/socket.io` | Socket.IO transport path                        |
| `REALTIME_CORS_ORIGINS`              |          `*` | Comma-separated allowed client origins          |

## Realtime client contract

Connect to namespace `/operations` with `{ auth: { token: accessToken } }`. After
authentication, listen for `operations.updated`. Each message contains `type`,
`occurredAt`, the relevant `branchId` or `chainId`, and `data`. Clients should use
the event as an invalidation signal and refetch the authoritative API resource;
they must not treat the socket payload as a replacement database.
