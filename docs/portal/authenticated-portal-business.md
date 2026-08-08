<!-- Space: SAL -->
<!-- Parent: Patient Portal (Next.js) -->
<!-- Title: Authenticated Patient Portal - Future Development -->
<!-- Label: future-development -->
<!-- Label: business -->
<!-- Label: patient-portal -->
<!-- Label: not-shipping -->

# Authenticated Patient Portal - Future Development

The signed-in experience patients would reach after they claim a portal account. Provides self-service access to appointments, membership, and a Salesforce-Case-backed message channel. **Not shipping today.** Code exists end-to-end but is gated by a feature flag that is off in both staging and production.

!!! danger "Not in staging or production"
    The authenticated portal is **future development**. Do not direct patients to `/dashboard`, `/appointments`, `/membership`, or `/messages` in either environment. The `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` flag is off everywhere; the routes return 404 to anonymous users and the registration wizard hides every "Sign in" or "Create account" CTA. Public registration at `/register` is unaffected and remains live in production.

## Ownership

| Role | Person or team |
|------|----------------|
| Process owner | Membership Coordinator Lead (when the surface lights up) |
| Technical owner | Patient Portal product team |
| Compliance owner | Privacy Officer (PHI session controls), Salesforce Admin (Cases triage) |

## Why this is a separate page

The live wizard at `example-patient-portal.com/register` (documented in [Initial Visit Registration - Business Guide](ac:Initial Visit Registration - Business Guide)) is account-free by design. Patients register, attach insurance, and book a visit without a portal login. The authenticated portal is a different surface: it requires an account, opens a self-service surface for existing patients, and pulls live data from Athena, Hint, and Salesforce.

Keeping the two pages separate prevents staff from sending patients into a half-built area. If the page below describes a screen, **the patient cannot reach that screen today**.

## Current flag state

| Flag | Staging | Production | Effect on the authenticated portal |
|------|---------|------------|--------------------------------------|
| `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` | OFF | OFF | Sign-in and Create-account CTAs hidden everywhere; `/login` returns 404 to anonymous browsers; the registration confirmation page never offers an account upsell. |
| `NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED` | OFF | OFF | Existing-member surfaces under `/portal/membership/*` remain reachable for patients who already have a Hint membership; new-member upsells are hidden. |
| `NEXT_PUBLIC_PORTAL_DOT_ENABLED` | OFF | OFF | Dot, the chat assistant, does not render on the authenticated surface either. |
| `PORTAL_PASSIVE_CLERK_ENABLED` | ON | ON | A dormant Clerk account is created silently after Athena patient creation. The patient never sees it; future sign-in is the trigger that lights it up. |

## Planned scope (when the flag is turned on)

| Area | What the patient will be able to do | Backed by |
|------|-------------------------------------|-----------|
| Dashboard | See next appointment, active membership, recent activity | Athena appointments + Hint membership |
| Appointments | View upcoming and past visits; book, cancel, reschedule, change modality | Athena scheduling APIs |
| Membership | See active plan, pay an open invoice, renew contract, cancel | Hint memberships and invoices |
| Messages | Send a message that creates a Salesforce Case for staff to triage and reply | Salesforce Case object |
| Identity | Confirm DOB when EMPI returns multiple candidate records | `portal_identity_links` |

The portal is a member self-service tool, not a clinical inbox. Clinical messaging, lab results, and visit notes are out of scope for the first release.

## How identity will work

A patient becomes an authenticated user when they open the "claim your account" magic link sent after registration. That link:

1. Creates a Clerk session (the dormant account is patched, not duplicated, thanks to passive provisioning).
2. Resolves the patient against EMPI to confirm Athena, Hint, and EMPI identifiers.
3. Writes the resolved triple to `portal_identity_links`.

If EMPI returns multiple candidates for the same person, the patient is asked to confirm DOB before the dashboard renders. Patients who fail the DOB step are routed to a manual help channel.

## Status of each surface

| Surface | Code complete | Test coverage | Decision needed before staging rollout |
|---------|---------------|---------------|-----------------------------------------|
| Dashboard | Yes | Light e2e | Go/no-go on which membership states surface |
| Appointments list and detail | Yes | Light e2e | Confirm cancel/reschedule cutoffs match Athena rules |
| Appointment scheduling (multi-step) | Yes | Light e2e | Provider directory source of truth (Storyblok bios vs Athena scheduling roster) |
| Membership overview | Yes | Light e2e | Pricing display rules for renewal and cancellation |
| Membership pay / renew / cancel | Yes (Hint + Rainforest) | Light e2e | Refund matrix sign-off (must align with the Membership Cancellation SOP) |
| Messages (Salesforce Cases) | Yes | Light e2e | Case record type, owner queue, SLA |
| DOB disambiguation | Yes | Light e2e | Failure-path lockout policy |

"Light" means the path is exercised by Playwright e2e specs, not certified for patient traffic.

## What this is not

- Not a substitute for the clinical chart or for messages with the care team.
- Not connected to lab results, imaging, or visit summaries.
- Not indexed by search engines (the `(portal)` route group sets `noindex`).
- Not a replacement for the public marketing site at `/`.
- Not a parallel registration channel. New patients still register through the public wizard.

## Open decisions blocking a staging rollout

These are decisions, not engineering work. Each must be resolved by the listed owner before the flag flips to ON in staging.

| Question | Owner |
|----------|-------|
| Which membership states (active, lapsed, paused, pending) appear on the dashboard? | Membership Coordinator Lead |
| Cancel and reschedule cutoffs - mirror Athena defaults or override per clinic? | Clinical Operations |
| Salesforce Case record type, owner queue, and SLA for the Messages channel | Salesforce Admin + Care Coordination |
| Refund and waiver behavior at cancel time - inherits from the Membership SOP? | RCM |
| Provider directory of record - Storyblok bios or Athena scheduling roster? | Marketing + Clinical Operations |
| DOB lockout / step-up auth policy after N failures | Privacy Officer |

## Compliance and SLA (placeholder)

The page will require its own compliance and SLA table once the surface goes live. The placeholders below show what will need an owner.

| Requirement | Implementation (planned) | Audit cadence |
|-------------|--------------------------|---------------|
| HIPAA: every authenticated read logged | Each `/api/portal/*` route is wrapped by `withPortalErrors` and writes to Sentry; identity changes write to `portal_identity_links` | Continuous |
| Robots indexing | `noindex` on the `(portal)` route group | Quarterly verification |
| Salesforce Case SLA | TBD by Care Coordination | TBD |

## Definitions

| Term | Definition |
|------|------------|
| EMPI | Enterprise Master Patient Index. The internal link table that resolves a Clerk user to canonical Athena, Hint, and EMPI identifiers. Lives in `portal_identity_links`. |
| Passive Clerk user | A dormant Clerk account created silently after Athena patient creation. Carries Athena patient id and registration token hash in metadata. The patient never receives a password-reset or verification email. |
| DOB disambiguation | The step where a patient confirms date of birth when EMPI matches more than one candidate record. |
| Salesforce Case (Messages) | A `Case` record acting as a portal "message" thread. Used so staff can triage and reply from Salesforce, not a separate inbox. |

## References

- [Initial Visit Registration - Business Guide](ac:Initial Visit Registration - Business Guide) - the live, account-free path
- [Authenticated Patient Portal - Future Technical Plan](ac:Authenticated Patient Portal - Future Technical Plan) - engineering view of this surface
- *End a patient's membership* - RCM SOP that the cancel flow must match before the flag flips on

---

**Owner:** Patient Portal product team · **Last reviewed:** 2026-05-05
