# Schedule-link opaque tokens (mint + resolve)

Cross-app contract for on-demand patient self-scheduling links.

## Overview

Salesforce (or any trusted app) asks the portal to mint a **one-time opaque
token**, texts `https://my…/schedule?t=<token>` to the patient, and may later
**resolve** that token to patient/context claims. The URL never contains a
raw Athena patient id.

| Store | Role |
|-------|------|
| Supabase `portal_schedule_links` | Durable token → claims + status |
| Upstash Redis `portal:schedule-link:{token}` | Single-use consume race at book |

## Auth (server-to-server)

Shared secret `SCHEDULE_LINK_API_KEY`:

- Preferred: `X-Schedule-Link-Signature: <hmac-sha256-hex of raw body>`
- Fallback: `X-Schedule-Link-Key: <SCHEDULE_LINK_API_KEY>`

Same handshake for **mint** and **resolve**.

## Mint

`POST /api/portal/schedule-link/mint`

```json
{
  "athenaPatientId": "123456",
  "salesforceAccountId": "001…",
  "departmentId": 21,
  "phone": "+1…",
  "firstName": "Ada",
  "ttlSeconds": 259200,
  "createdBy": "salesforce"
}
```

Response:

```json
{
  "ok": true,
  "url": "https://my.example-patient-portal.com/schedule?t=…",
  "expiresAt": 1710000000,
  "token": "…",
  "jti": "…"
}
```

`jti` is an alias of `token` for older callers.

## Resolve

`POST /api/portal/schedule-link/resolve`

```json
{ "token": "…" }
```

Response (success):

```json
{
  "ok": true,
  "token": "…",
  "status": "active",
  "expiresAt": 1710000000,
  "createdAt": 1709900000,
  "athenaPatientId": "123456",
  "salesforceAccountId": "001…",
  "departmentId": 21,
  "firstName": "Ada"
}
```

Phone is not returned from resolve (audit-only at mint). Status is
`active` | `used` | `revoked`. Expired active links return `410`.

## Patient booking

Patient opens `/schedule?t=<token>` (no Clerk login). Session / available /
book / reschedule accept the opaque token in the JSON body. Booking burns
Redis then marks Supabase `used`. Recoverable Athena errors reactivate both.

## Migration

Apply `supabase/migrations/20260712_portal_schedule_links.sql` before
deploying mint that writes opaque tokens.

## Legacy JWTs

In-flight SMS links that still carry an HS256 JWT continue to verify via
`SCHEDULE_LINK_SECRET` until they expire. New mints are opaque-only.
