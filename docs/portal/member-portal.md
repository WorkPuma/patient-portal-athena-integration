<!-- Space: dev -->
<!-- Parent: Iris: Self-Scheduling -->
<!-- Title: Member Portal -->
<!-- Label: published -->
<!-- Label: business -->
<!-- Label: patient-portal -->

# Member portal

The authenticated side of the Herself Health patient portal. A signed-in patient lands here to see upcoming visits, manage membership, pay invoices, and message the care team.

## Owners

| Role | Name |
|------|------|
| Process owner | Patient Access Lead |
| Technical owner | Patient Portal engineering |
| Compliance owner | Privacy and Security Officer |

## Outcome

A signed-in patient can self-serve four things:

1. See and reschedule upcoming Athena appointments.
2. View Hint membership, renew it, or cancel it.
3. View Hint invoices and pay them via Rainforest.
4. Open a Salesforce Case (a "message") and read replies.

A patient who cannot sign in or whose Clerk record is not yet linked to a patient is sent through a one-time DOB verification screen before any of the four pages render.

## Pages

| URL | What the patient sees | Backing system |
|-----|-----------------------|----------------|
| `/dashboard` | Upcoming appointment, membership snippet, quick links | Athena (appointments), Hint (membership) |
| `/appointments` | Full list of past and upcoming appointments with status badges | Athena |
| `/appointments/[id]` | Single appointment detail with a cancel/reschedule action | Athena |
| `/appointments/schedule` | Multi-step wizard to book a new visit (calendar → modality → reason → confirm) | Athena |
| `/membership` | Plan name, term dates, status; embed for booking another visit | Hint |
| `/membership/renew` | Renew the current contract | Hint |
| `/membership/pay` | Outstanding invoices with a Pay button | Hint, Rainforest |
| `/membership/cancel` | Cancel the membership | Hint |
| `/messages` | Salesforce Cases (Subject, Status, Priority, CreatedDate) | Salesforce |
| `/messages/new` | Compose a new Case with subject and body | Salesforce |

## Identity gate

Every authenticated page passes through `PortalShell`, which calls `GET /api/portal/auth/session` and routes the patient into one of three states:

| Session state | What renders | Trigger |
|---------------|--------------|---------|
| `disambiguation` | DOB verification screen | The Clerk user's email matches more than one Athena record, or no record yet |
| `registration_incomplete` | Redirect to `/register` | The Clerk user has no `athenaPatientId` and `registrationComplete` is not true |
| `verified` | Requested page | EMPI-resolved Athena patient on file in Clerk metadata |

DOB verification compares the user-entered DOB against an Upstash vector lookup of EMPI candidates, filtered to non-test patients with a minimum match score (`EMPI_VECTOR_MIN_SCORE`).

## Business rules

| Rule | Condition | Action |
|------|-----------|--------|
| M1 — Membership pages always available | The patient is already a member | The membership pages render regardless of the `membership` feature flag (the flag only gates the registration funnel) |
| M2 — Cancel within commitment window | Patient hits Cancel inside the 12-month commitment | Hint enforces the contract terms; the UI shows the early-termination behavior Hint returns |
| M3 — Pay invoice | Patient pays from `/membership/pay` | Rainforest tokenized payment; success message + Hint marks paid; failure leaves invoice open |
| M4 — Messages route to Cases | Patient opens or creates a message | List = `GET /api/portal/salesforce/cases`; create = `POST /api/portal/salesforce/cases` with `Origin: "Her"`, `Status: "New"` |
| M5 — Reschedule allow-list | Patient reschedules a visit | The new slot must be a valid Athena type for that appointment; cancellations write back to Athena |
| M6 — Dot widget | `NEXT_PUBLIC_PORTAL_DOT_ENABLED` is on | Renders the Retell-backed chat widget in the layout; otherwise hidden |

## Compliance and SLA

| Item | Commitment |
|------|------------|
| PHI in transit | TLS 1.2+ on every external call |
| PHI at rest | Clerk holds the user record and minimal metadata; Athena and Hint hold the source-of-truth clinical and billing data |
| Audit trail | Failed external calls write a Supabase follow-up row with the patient id and the step |
| Authentication | Clerk session required on every `/portal/**` page except `/login/**` and `/register/**` |
| Card data | Never enters our servers; Rainforest hosted iframe handles PAN |

## Definitions

- **EMPI** — Enterprise Master Patient Index. The Upstash vector store used to disambiguate a Clerk user to one Athena patient when the email is ambiguous.
- **Disambiguation** — the DOB-verification step that resolves an EMPI candidate set to a single Athena patient.
- **Passive Clerk** — server-side Clerk user provisioning at the demographics step, so the later sign-up is a silent claim rather than a fresh account creation.
- **Case** — Salesforce object the messages feature reads and writes against. The portal does not run a separate inbox.

## References

- Initial visit registration business doc — same parent.
- How-to: [Register a patient and trace the records into Salesforce](#) — same parent.
- `src/components/portal/PortalShell.tsx` — identity gate, nav, public-paths list.
- `src/app/api/portal/auth/session/route.ts` — session state machine.

---

**Owner:** Patient Access Lead · **Last reviewed:** 2026-05-06 · **Review cadence:** quarterly
