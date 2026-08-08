<!-- Space: SAL -->
<!-- Parent: Patient Portal (Next.js) -->
<!-- Title: Authenticated Patient Portal - Future Technical Plan -->
<!-- Label: future-development -->
<!-- Label: technical -->
<!-- Label: patient-portal -->
<!-- Label: not-shipping -->
<!-- Label: clerk -->
<!-- Label: athena -->
<!-- Label: hint -->
<!-- Label: salesforce -->

# Authenticated Patient Portal - Future Technical Plan

## Summary

Engineering view of the signed-in surface. **Not in staging or production.** The code lives in the `(portal)` route group alongside the public registration wizard, but every page under `/dashboard`, `/appointments`, `/membership`, and `/messages` is gated by `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` and `auth.protect()` in `src/middleware.ts`. The flag is off in both environments. Identity is established by Clerk and linked to Athena, Hint, and EMPI identifiers via `portal_identity_links`. Reads come from `/api/portal/athena/*`, `/api/portal/hint/*`, and `/api/portal/salesforce/cases`. The route group sets `robots: { index: false, follow: false }`.

For business scope, planned audience, and the open decisions blocking a staging rollout, see [Authenticated Patient Portal - Future Development](ac:Authenticated Patient Portal - Future Development).

**Last verified:** 2026-05-05 against the patient-portal feature branch.

!!! danger "Not for staging or production"
    This is planned engineering work, not a live surface. Public registration at `/register` is unaffected and remains live in production. Do not enable patient access to authenticated routes until the open decisions in the business page are resolved.

## Feature flag state by environment

| Flag | Staging | Production | Effect when off |
|------|---------|------------|-----------------|
| `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` | OFF | OFF | Sign-in and Create-account CTAs hidden; `/login` returns 404 to anonymous users; the registration confirmation page never offers an account upsell |
| `NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED` | OFF | OFF | Wizard membership step hidden; new-member upsells suppressed. Existing-member surfaces under `/portal/membership/*` remain reachable for patients with a Hint membership |
| `NEXT_PUBLIC_PORTAL_DOT_ENABLED` | OFF | OFF | Chat widget hidden on the authenticated surface |
| `PORTAL_PASSIVE_CLERK_ENABLED` | ON | ON | Dormant Clerk accounts created silently after Athena patient creation |

The flag state matches `Initial Visit Registration - Technical Specification` because the wizard and the authenticated portal share the same feature-flag module (`src/lib/portal/feature-flags.ts`).

## Architecture

### Surface map

```d2
direction: right

patient: { label: Authenticated Patient (planned); shape: person }
shell: { label: PortalShell + ClerkProvider; shape: rectangle }
session_api: { label: "GET /api/portal/auth/session"; shape: rectangle }

dashboard: { label: "/dashboard"; shape: rectangle }
appts: { label: "/appointments"; shape: rectangle }
mem: { label: "/membership"; shape: rectangle }
msgs: { label: "/messages"; shape: rectangle }
dob: { label: DobVerification; shape: rectangle }

athena_api: { label: "/api/portal/athena/*"; shape: cloud }
hint_api: { label: "/api/portal/hint/*"; shape: cloud }
sf_api: { label: "/api/portal/salesforce/cases"; shape: cloud }
identity_links: { label: portal_identity_links; shape: cylinder }

patient -> shell: signed-in request
shell -> session_api: who am I?
session_api -> identity_links: lookup
session_api -> shell: user + flags
shell -> dob: disambiguationRequired
shell -> dashboard: render
dashboard -> athena_api: appointments
dashboard -> hint_api: membership
appts -> athena_api: list / book / cancel / reschedule
mem -> hint_api: invoices / renew / cancel
msgs -> sf_api: list / create case
```

### Identity establishment (planned flow)

```d2
direction: down

claim_link: { label: Magic link from confirmation email; shape: oval }
clerk_signup: { label: Clerk sign-up (patches dormant user); shape: step }
claim_link_api: { label: "POST /api/portal/register/claim/link"; shape: step }
empi: { label: EMPI lookup; shape: hexagon }
candidates: { label: Multiple candidates?; shape: diamond }
dob_verify: { label: "POST /api/portal/identity/verify-dob"; shape: step }
write_link: { label: Insert into portal_identity_links; shape: step }
dashboard: { label: "/dashboard"; shape: oval }

claim_link -> clerk_signup
clerk_signup -> claim_link_api
claim_link_api -> empi
empi -> candidates
candidates -> dob_verify: yes
candidates -> write_link: no
dob_verify -> write_link
write_link -> dashboard
```

## Definitions

| Term | Definition | Where it lives |
|------|------------|----------------|
| `getPortalUser` | Server helper that resolves the Clerk user to an EMPI/Athena/Hint identity bundle | `src/lib/auth/clerk-session.ts` |
| `requireVerifiedIdentity` | Wrapper that 401s when the linked identity is missing or unverified | `src/lib/auth/clerk-session.ts` |
| `disambiguationRequired` | Boolean on the session response set when EMPI returns multiple candidates | `/api/portal/auth/session` |
| `registrationComplete` | Boolean on the session response set when the registration wizard reached confirmation | `/api/portal/auth/session` |
| Salesforce Case (Messages) | A `Case` record acting as a portal "message" thread | `/api/portal/salesforce/cases` |
| Passive Clerk user | A dormant Clerk account created silently after Athena patient creation. Patched, not duplicated, when the patient signs in for the first time. | `src/lib/identity/passive-clerk.ts` |

## File and endpoint inventory

### Files (authenticated surfaces only)

| Path | Role |
|------|------|
| `src/middleware.ts` | `auth.protect()` on `/dashboard`, `/appointments`, `/membership`, `/messages` |
| `src/app/(portal)/layout.tsx` | `ClerkProvider`, `PortalShell`, `noindex` metadata |
| `src/components/portal/PortalShell.tsx` | Sidebar, `UserButton`, identity gate |
| `src/components/portal/identity/DobVerification.tsx` | DOB step for EMPI disambiguation |
| `src/app/(portal)/portal/dashboard/page.tsx` | Shell page |
| `src/components/portal/dashboard/Dashboard.tsx` | Loads session, Athena appointments, Hint membership, scheduling overlay |
| `src/app/(portal)/portal/appointments/page.tsx` | List page |
| `src/app/(portal)/portal/appointments/schedule/page.tsx` | Authenticated scheduling page |
| `src/app/(portal)/portal/appointments/[id]/page.tsx` | Detail page |
| `src/components/portal/appointments/AppointmentList.tsx` | List view + scheduling overlay |
| `src/components/portal/appointments/AppointmentDetail.tsx` | Detail view |
| `src/components/portal/appointments/AppointmentScheduler.tsx` | Multi-step scheduler |
| `src/components/portal/appointments/SchedulingWizard.tsx` | Wizard container |
| `src/components/portal/appointments/steps/*.tsx` | Calendar, modality, visit reason, confirm steps |
| `src/app/(portal)/portal/membership/page.tsx` | Overview |
| `src/app/(portal)/portal/membership/{pay,renew,cancel}/page.tsx` | Payment, renewal, cancellation pages |
| `src/components/portal/membership/MembershipOverview.tsx` | Hint membership + entry points |
| `src/components/portal/membership/{PayInvoice,RenewContract,CancelMembership}.tsx` | Membership actions |
| `src/app/(portal)/portal/messages/page.tsx` | Salesforce Case list |
| `src/app/(portal)/portal/messages/new/page.tsx` | New case composer |
| `src/components/portal/messages/MessageList.tsx` | List of cases |
| `src/components/portal/messages/NewMessage.tsx` | Create case |
| `src/lib/auth/clerk-session.ts` | `getPortalUser`, `requireVerifiedIdentity`, `ensurePortalIdentityLinked` |
| `src/lib/identity/passive-clerk.ts` | `createPassiveClerkUser` (idempotent dormant Clerk provisioning) |
| `src/app/api/portal/auth/session/route.ts` | Session endpoint consumed by the shell |
| `src/app/api/portal/identity/{verify-dob,link,reset}/route.ts` | DOB disambiguation and identity link maintenance |
| `src/app/api/portal/clerk/sync-metadata/route.ts` | Sync Clerk public metadata after identity changes |
| `src/app/api/portal/athena/**/*.ts` | Patient, appointments, insurance, book, cancel, reschedule, eligibility, visit history |
| `src/app/api/portal/hint/**/*.ts` | Patient, membership, invoices, enroll, renew, cancel |
| `src/app/api/portal/salesforce/cases/route.ts` | List and create Cases (Messages backend) |
| `src/app/api/portal/queue/{send-email,salesforce-case}/route.ts` | Async email and case queue endpoints |
| `supabase/migrations/20260321_portal_identity_links.sql` | `portal_identity_links` |
| `supabase/migrations/20260322_portal_appointment_types.sql` | Portal-specific scheduling type config |

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/portal/auth/session` | Returns Clerk user + EMPI flags (`disambiguationRequired`, `registrationComplete`) |
| POST | `/api/portal/identity/verify-dob` | Submit DOB to resolve EMPI disambiguation |
| POST | `/api/portal/identity/link` | Manual link operations |
| POST | `/api/portal/identity/reset` | Reset link metadata (admin/internal) |
| POST | `/api/portal/clerk/sync-metadata` | Push EMPI/Athena/Hint identifiers into Clerk public metadata |
| GET, POST | `/api/portal/athena/*` | Patient, appointments, insurance, book, cancel, reschedule, eligibility, visit history |
| GET, POST | `/api/portal/hint/*` | Patient, membership, invoices, enroll, renew, cancel |
| GET, POST | `/api/portal/salesforce/cases` | List and create Cases used by Messages |
| POST | `/api/portal/queue/send-email` | Queued email send (Resend) |
| POST | `/api/portal/queue/salesforce-case` | Async case creation |

## Configuration

| Variable | Purpose | Source of truth |
|----------|---------|-----------------|
| `NEXT_PUBLIC_PORTAL_MODE` | Master switch; required to expose any portal route | `.env` |
| `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` | Toggles all sign-in / authenticated CTAs (off in both envs today) | `.env` |
| `CLERK_*` | Publishable + secret keys; required for the entire authenticated surface | Vault |
| `ATHENA_*` | API client credentials | Vault |
| `HINT_*` | Hint API credentials | Vault |
| `SALESFORCE_*` | Connected app credentials for Cases | Vault |
| `SUPABASE_*` | Service-role key for `portal_identity_links` reads/writes | Vault |
| `RESEND_*` | Transactional email | Vault |

## Decision rules in code

| Rule ID | Condition | Code | Action |
|---------|-----------|------|--------|
| BR-AUTH-01 | Clerk session present, identity link missing | `getPortalUser` | Returns `requiresClaim = true`; UI sends user to `/register` to claim |
| BR-AUTH-02 | EMPI returns >1 candidate | `getPortalUser` | `disambiguationRequired = true`; UI renders `DobVerification` |
| BR-AUTH-03 | DOB verification fails N times | `verify-dob` route | Surface "contact support" copy. Lockout policy not yet defined (open decision). |
| BR-AUTH-04 | Hint patient missing for a Clerk user with Athena id | Dashboard / membership routes | Membership UI degrades gracefully; pay/renew/cancel disabled |
| BR-AUTH-05 | Salesforce auth fails | `/api/portal/salesforce/cases` | Messages list shows an empty state with retry; new-case form returns 503 |
| BR-AUTH-06 | `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` is `false` | `RegistrationWizard.tsx`, `LoginForm.tsx`, `RegistrationConfirmation.tsx`, `(portal)/login/page.tsx` | Auth UI hidden everywhere; `/login` returns 404 to anonymous browsers |

## Status of each surface

| Surface | Code complete | Tests | Decisions blocking a staging flag flip |
|---------|---------------|-------|-----------------------------------------|
| Identity claim + DOB disambiguation | Yes | Light e2e | DOB lockout policy |
| Dashboard | Yes | Light e2e | Which membership states surface |
| Appointments list and detail | Yes | Light e2e | Cancel/reschedule cutoffs |
| Appointment scheduling wizard | Yes | Light e2e | Provider directory source of truth (Storyblok bios vs Athena scheduling roster) |
| Membership overview | Yes | Light e2e | Pricing display rules |
| Membership pay / renew / cancel | Yes | Light e2e | Refund matrix (must align with Membership SOP) |
| Messages | Yes | Light e2e | Case record type, owner queue, SLA |

## Error handling

| Error | Where | Resolution |
|-------|-------|------------|
| 401 from `requireVerifiedIdentity` | All authenticated APIs | Shell redirects to `/login`; if Clerk session is present, prompts identity claim |
| `disambiguationRequired` | `/api/portal/auth/session` | UI renders `DobVerification` |
| Hint 4xx on membership reads | `MembershipOverview` | Show degraded state; no pay/renew/cancel actions |
| Salesforce auth failure | `/api/portal/salesforce/cases` | Messages show empty state; create returns 503; logs to Sentry |
| Athena conflict on cancel/reschedule | Athena route handlers | Return structured error; UI shows the cutoff message |

## Monitoring (planned)

| Signal | Where | Notes |
|--------|-------|-------|
| Sentry | `withPortalErrors` wrapper used by all portal routes | Already in place; volume will rise once auth UI lights up |
| Audit trail | `portal_identity_links` mutations are timestamped; identity reset writes a Sentry breadcrumb | Already in place |
| E2E coverage | `tests/e2e/portal-clerk-athena.spec.ts` | Will need expansion before flipping the flag |
| Production load test | Athena and Hint API call volumes per dashboard render | Open work item |

## Out of scope for the first release

- Lab results, imaging, visit notes, problem list, medication reconciliation.
- Direct clinical messaging (Messages is a Salesforce Case channel, not a clinical inbox).
- Bill-pay outside the Hint membership invoice flow.
- Mobile app (web responsive only).

## Open work before any flag flip

- DOB lockout / step-up auth policy (Privacy Officer).
- Provider directory source of truth - Storyblok bios vs Athena scheduling roster (`src/lib/portal/providers.ts`).
- Refund and waiver behavior in `CancelMembership` must match the Membership Cancellation SOP matrix.
- Salesforce Case record type and owner queue selection.
- Production load test for Athena and Hint API call volumes per dashboard render.

## Related documentation

- [Authenticated Patient Portal - Future Development](ac:Authenticated Patient Portal - Future Development) - business scope
- [Initial Visit Registration - Technical Specification](ac:Initial Visit Registration - Technical Specification) - the path that establishes identity
- [Initial Visit Registration - Business Guide](ac:Initial Visit Registration - Business Guide) - live, account-free patient flow
- *End a patient's membership* - RCM SOP that the cancel surface must match before launch

---

**Owner:** Patient Portal product team · **Last reviewed:** 2026-05-05
