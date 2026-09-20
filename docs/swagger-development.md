# Swagger development guide

This project treats Swagger as an executable API contract, not a manually maintained endpoint list.

## Structure

- Request DTOs live next to their module and describe validation rules and input examples.
- Response DTOs describe the public JSON contract independently from Prisma models.
- Shared error, UUID parameter, authentication, and pagination decorators live in `src/common/swagger`.
- Controllers only compose these reusable building blocks and document business-state transitions.
- The generated OpenAPI document is verified by end-to-end tests.

## Waiter and Kitchen Staff tags

| Tag                | Responsibility                                                     |
| ------------------ | ------------------------------------------------------------------ |
| `Waiter · Orders`  | Load working context, create orders, add items, and submit orders. |
| `Kitchen · Queue`  | Read the preparation queue and change item preparation states.     |
| `Waiter · Serving` | Read, claim, and complete ready-item serving tasks.                |

The tags follow the operational handoff: Waiter order → Kitchen preparation → Waiter serving.

## Adding an endpoint

1. Create or reuse a validated request DTO. Do not accept anonymous object bodies.
2. Create or reuse a response DTO. Do not expose a Prisma type as the API contract.
3. Put the endpoint under the tag that owns the operation.
4. Add `ApiOperation` with the business purpose and state preconditions.
5. Document success with `ApiOkResponse` for reads or `ApiCreatedResponse` for commands.
6. Use the shared UUID, authentication, pagination, and mutation-error decorators.
7. Add the operation and required schemas to the OpenAPI contract test.
8. Run type checking, unit tests, and end-to-end tests before merging.

## Status-code convention

- `200`: query completed.
- `201`: a command created a resource or completed a state transition.
- `400`: invalid request data or UUID.
- `401`: missing or invalid access token.
- `403`: authenticated user lacks the required role or branch scope.
- `404`: target order, item, or serving task does not exist in the current scope.
- `409`: the requested transition conflicts with the current state or another worker won the race.

## Local use

With `SWAGGER_ENABLED=true`, open `/api/docs`. The raw contract is available at `/api/docs-json`. The UI preserves the bearer token and supports filtering by tag or text.
