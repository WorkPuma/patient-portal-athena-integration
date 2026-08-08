<!-- Space: SAL -->
<!-- Parent: Patient Portal (Next.js) -->
<!-- Title: Initial Visit Registration - Technical Specification -->
<!-- Label: published -->
<!-- Label: technical -->
<!-- Label: patient-portal -->
<!-- Label: registration -->
<!-- Label: insurance -->
<!-- Label: scheduling -->
<!-- Label: stedi -->
<!-- Label: athena -->

# Initial Visit Registration - Technical Specification

## Summary

A public, no-account registration wizard at `/register` in the `patient-portal-athena-integration` Next.js app. Three live steps in the current build: Demographics, Insurance, Schedule. Backed by Athena (patient and scheduling), Stedi (real-time 270/271), Supabase (insurance package catalog and audit table), Hint (skeleton patient), Salesforce (post-booking Onboarding Lead), and Clerk (silent passive provisioning). Session is held in `sessionStorage` via a server-issued `regToken`. No Clerk session is required to complete the flow.

The wizard is the production replacement for the inbound-Lead-plus-phone-call workflow the Onboarding Team has been running for new patients. Onboarding remains the owner of post-booking qualification (see the business guide).

**Environments**

| Alias | Environment | URL |
|-------|-------------|-----|
| Production | Vercel `production` | `https://example-patient-portal.com/register` |
| Staging | Vercel `preview` (patient-portal branch) | `https://my.example-patient-portal.com/register` |

Both environments run identical code. Environment-specific behavior is gated by `VERCEL_ENV` and `ATHENA_BASE_URL` (see BR-REG-07, BR-REG-08).

**Last verified:** 2026-05-05 against production.

## Feature flag state by environment

| Flag | Staging | Production | Effect when off |
|------|---------|------------|-----------------|
| `NEXT_PUBLIC_PORTAL_MODE` | ON | ON | All `/portal/*` routes return 404 |
| `NEXT_PUBLIC_PORTAL_DOT_ENABLED` | OFF | OFF | Chat widget hidden; `api/portal/retell/*` returns 503 |
| `NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED` | OFF | OFF | Membership step hidden in wizard; `/register/membership` redirects to `/register/schedule`; public membership APIs return 410 |
| `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` | OFF | OFF | "Sign in" / "Create my account" CTAs hidden; confirmation page shows "Done" plus reminder text |
| `PORTAL_PASSIVE_CLERK_ENABLED` | ON | ON | Default-on in `.env.example`. Provisions dormant Clerk users keyed by phone after Athena create. |
| `ENABLE_STEDI_ELIGIBILITY` | ON | ON | Stedi POST returns `501 STEDI_DISABLED` when off |

The Membership and Dot flags are intentionally off in both staging and production. The code paths exist so the feature can be turned on later without a code deploy.

## Decision rules in code

| Rule ID | Condition | Code | Action |
|---------|-----------|------|--------|
| BR-REG-01 | `NEXT_PUBLIC_PORTAL_MODE` not `true` | `src/middleware.ts` | All `/portal/*` routes return 404 |
| BR-REG-02 | `NEXT_PUBLIC_PORTAL_DOT_ENABLED` not `true` | `src/app/(portal)/layout.tsx`, `api/portal/retell/*` | Chat widget hidden; tool routes return 503 |
| BR-REG-03 | `NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED` not `true` | `RegistrationWizard.tsx`, `EligibilityCheck.tsx`, `register/membership/page.tsx`, `lib/portal/membership-guard.ts` | Membership step hidden; `/register/membership` redirects; public membership APIs return 410 |
| BR-REG-04 | `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` not `true` | `RegistrationWizard.tsx`, `LoginForm.tsx`, `RegistrationConfirmation.tsx` | Sign-in and Create-account CTAs hidden |
| BR-REG-05 | `PORTAL_PASSIVE_CLERK_ENABLED` is `true` (default) | `register/patient/route.ts` -> `lib/identity/passive-clerk.ts` | After successful Athena create, provision a dormant Clerk user keyed by phone; idempotent |
| BR-REG-06 | `ENABLE_STEDI_ELIGIBILITY` not `true` | `register/eligibility/route.ts` | Stedi POST returns `501 STEDI_DISABLED` |
| BR-REG-07 | `VERCEL_ENV !== "production"` | `register/eligibility` legacy path, `register/membership/payment-setup` | Returns mocked responses; skips Rainforest |
| BR-REG-08 | `VERCEL_ENV === "preview"` or `ATHENA_BASE_URL` contains `preview` | `lib/portal/insurance-packages.ts` `resolveAthenaInsurancePackageId` | Remaps requested package id to `PORTAL_PREVIEW_INSURANCE_PACKAGE_ID` (default 1132 BCBS-MN) |
| BR-REG-09 | Resolved package `isGovernmentFunded === true` | `EligibilityCheck.tsx`, `EligibilityCheckBrand.tsx`, `getRegistrationVariantFromInsurance` | Skip membership; book Initial Visit type 47 (90 min) |
| BR-REG-10 | Resolved package `isGovernmentFunded === false` | `getRegistrationVariantFromInsurance` -> `mbr` | Book MBR Initial Visit type 461 (60 min) |
| BR-REG-11 | Stedi 271 returns COB Other Payer with a known carrier name | `register/eligibility/route.ts` Medicare branch + `pickRetryBrandFromOtherPayer` | One automatic retry against the resolved MA carrier's payer ID |
| BR-REG-12 | Athena `enhancedBestMatch` returns existing patient | `register/patient/route.ts` | Response replaces real patient id with a "sign in instead" message; no duplicate is created |

## Architecture

### High-level system map

```d2
direction: right

patient: { label: Prospective Patient; shape: person }
browser: { label: Next.js (portal route group); shape: rectangle }
api: { label: /api/portal/register/*; shape: rectangle }

athena: { label: Athena; shape: cloud }
hint: { label: Hint; shape: cloud }
stedi: { label: Stedi 270/271; shape: cloud }
clerk: { label: Clerk (passive); shape: cloud }
salesforce: { label: Salesforce; shape: cloud }
supabase: { label: Supabase; shape: cylinder }
upstash: { label: Upstash; shape: cylinder }
sentry: { label: Sentry; shape: cloud }

patient -> browser: HTTPS
browser -> api: regToken (Bearer)
api -> athena: patient + slots + book + attach insurance
api -> hint: skeleton
api -> stedi: 270 request
api -> supabase: package lookup + followup write
api -> clerk: passive user provision
api -> salesforce: lead on booking confirmation
api -> upstash: idempotency + slot cache
api -> sentry: errors
```

### Wizard sequence

```d2
direction: down

start: { label: Patient lands on /register; shape: oval }
demo: { label: 1. RegistrationWizard - demographics; shape: step }
create: { label: POST /register/patient (Athena + Hint + passive Clerk); shape: step }
elig: { label: 2. EligibilityCheckBrand - pick brand + member id; shape: step }
resolver: { label: Insurance Resolver (Stedi + reverse-resolve + attach); shape: hexagon }
govt: { label: isGovernmentFunded?; shape: diamond }
variant_std: { label: Initial Visit type 47 (90 min); shape: step }
variant_mbr: { label: MBR Initial Visit type 461 (60 min); shape: step }
schedule: { label: 3. InitialVisitScheduler - location, provider, slot; shape: step }
book: { label: POST /register/appointments/book; shape: step }
lead: { label: Salesforce Lead -> Onboarding queue; shape: step }
confirm: { label: Confirmation (slot + reminder copy); shape: oval }

start -> demo
demo -> create
create -> elig
elig -> resolver
resolver -> govt
govt -> variant_std: yes
govt -> variant_mbr: no
variant_std -> schedule
variant_mbr -> schedule
schedule -> book
book -> lead
lead -> confirm
```

### Insurance Resolver layers

```d2
direction: down

ui: { label: EligibilityCheckBrand (UI); shape: rectangle }
route: { label: POST /api/portal/register/eligibility; shape: rectangle }
forward: { label: L1 Forward Resolver (brand-resolver.ts); shape: hexagon }
stedi: { label: L2 Stedi 270/271 transport (client.ts + runStediWithFallbacks); shape: cloud }
summary: { label: "L3 Summarizer (eligibility-summary.ts to NormalizedEligibility)"; shape: hexagon }
retry: { label: L4 MA disambiguator (pickRetryBrandFromOtherPayer); shape: diamond }
reverse: { label: L5 Reverse Resolver (package-resolver.ts); shape: hexagon }
primary: { label: L5a id-match (Supabase portal_insurance_packages); shape: cylinder }
fallback: { label: L5b legacy brand table (BRAND_MAPPINGS); shape: hexagon }
remap: { label: "L6 Preview remap (resolveAthenaInsurancePackageId)"; shape: hexagon }
attach: { label: "L7 Athena attach (POST /patients/[id]/insurances)"; shape: cloud }
audit: { label: L8 Audit (recordFollowup -> portal_registration_followups); shape: cylinder }

ui -> route: brandId, memberId, DOB, relationship
route -> forward
forward -> stedi: ordered payer-id list
stedi -> summary: 271
summary -> retry
retry -> stedi: one retry against MA carrier
retry -> reverse
reverse -> primary: edi_payer_id (+gateway aliases)
primary -> reverse: candidates
reverse -> fallback: when id-match misses or Supabase down
reverse -> remap: insurancePackageId
remap -> attach
attach -> audit
route -> audit
```

## Definitions

| Term | Definition | Where it lives |
|------|------------|----------------|
| `regToken` | Server-issued opaque session token for the no-account flow. Carries `athenaPatientId`, `departmentId`, contact info. Intentionally omits raw DOB and sex. | Issued by `register/patient`, sent as `Authorization: Bearer` |
| `NormalizedEligibility` | Stedi 271 reduced to portal-relevant fields (coverage status, payer, plan, EB04 mode-tally, COB other payers, AAA codes) | `src/lib/stedi/types.ts` |
| `PackageResolverResult` | Resolved Athena `insurancepackageid` + brand metadata + confidence tag | `src/lib/stedi/types.ts` |
| `PortalPayerBrand` | Catalog entry mapping a patient-facing brand to one or more Stedi payer IDs and a `productHint` | `src/lib/stedi/brand-resolver.ts` |
| `isGovernmentFunded` | Boolean on `portal_insurance_packages` and `PackageResolverResult` that drives the membership-skip and the visit-type variant | Supabase column + resolver output |
| EB04 | X12 Insurance Type Code (e.g. `C1` commercial, `MA` Medicare A, `MC` Medicaid). Most authoritative signal in the 271. | `src/lib/stedi/eligibility-summary.ts`, `package-resolver.ts` `ALLOWED_PRODUCT_TYPES_BY_EB04` |
| AAA segment | X12 270/271 reject codes. Examples: `41` provider not enrolled, `72/73` member ID mismatch. | Surfaced via `explainRejection` |
| `recordFollowup` | Wrap-the-world helper that writes one row per wizard step to `portal_registration_followups`. Never throws. | `src/lib/portal/followup.ts` |
| Pending patient id | Synthetic `pending-…` id used when Athena create soft-failed. Downstream steps detect it and write follow-up rows instead of calling Athena. | `mintPendingPatientId` / `isPendingPatientId` |

## The Insurance Resolver

The resolver is the most complex piece of the registration flow. It is split into layers so each has one responsibility and can be unit-tested in isolation. The full pipeline runs inside `POST /api/portal/register/eligibility`, the brand-driven branch.

### L1 - Forward Resolver (brand to Stedi payer IDs)

`src/lib/stedi/brand-resolver.ts`

- `PORTAL_PAYER_BRANDS` is a curated catalog of 12 brands covering 98.30% of historical Athena eligibility traffic over the trailing 365 days, validated against `eligibilitytrack`.
- Each brand has a `defaultStediPayerId` and an optional `altStediPayerIds[]`. Order matters: the runner tries IDs in order and stops on the first non-AAA response.
- BCBS, TRICARE, and Medicare are the brands that meaningfully use alternates. BlueCard prefixes outside MN (Anthem, Empire, Highmark) need `00040 / 00803 / 89200` as fallbacks for `00720`.
- The `"other"` brand has `guidedHandoff: true`. The resolver short-circuits to a soft-fail row and never calls Stedi.
- The catalog is in-code today. Phase 2 moves it to a Supabase `portal_payer_brand` table; the function signature is already async-shaped so the swap is mechanical.

### L2 - Stedi 270/271 transport

`src/lib/stedi/client.ts` plus `runStediWithFallbacks` in the eligibility route.

- Issues an X12 270 against `tradingPartnerServiceId`, parses the 271.
- A 400 from Stedi means "bad payer alias for this combination". The runner falls through to the next ID in the brand's list.
- Any other status (5xx, network, auth) bubbles. The route catches it once at the top, writes a soft-fail row, and returns `softEligibilityResponse` so the wizard advances.
- AAA reject codes inside a 200 body are not exceptions; they are returned as part of `NormalizedEligibility.rejectionCodes`.

### L3 - Summarizer

`src/lib/stedi/eligibility-summary.ts`

- `coverageStatus` is `active` only when there are zero AAA codes and the plan status is `Active Coverage` (`1`). Anything else is `inactive` or `unknown`.
- `primaryInsuranceTypeCode` (EB04) is computed by tallying every benefit segment's `insuranceTypeCode`, weighting active-coverage segments 2x. The mode wins. This prevents a single secondary or COB segment from overriding the primary plan type.
- `payerEdiId` is `payer.payorIdentification` trimmed. This is the hand-off to L5.
- `otherPayers` captures Loop 2120C (subscriber other payers), used by L4.
- `rejectionCodes` plus `explainRejection` give the wizard a one-line plain-English message. Raw AAA never reaches the patient.

### L4 - Medicare to MA disambiguator

`pickRetryBrandFromOtherPayer` in `brand-resolver.ts`, called from the Medicare branch of the eligibility route.

- Triggered only when `brandId === "medicare"`, status is `active`, and the 271 includes any COB Other Payer.
- Maps the carrier name to a known brand (`UNITED -> uhc`, `BLUE -> bcbs`, etc.) and reissues exactly **one** retry against that brand's default payer ID.
- If the retry comes back active, the resolver replaces the brand on the in-flight result so L5 lands on the MA-PPO-specific Athena package, not the FFS one.
- Capped at one retry per the rollout plan; further disambiguation is back-office work.

### L5 - Reverse Resolver (271 to Athena `insurancepackageid`)

`src/lib/stedi/package-resolver.ts` (`resolvePackageFromEligibility`).

The reverse resolver is two-tier. **Tier A (id-match) is the primary path.** Tier B (legacy brand table) is the safety net.

#### L5a - Primary: id-match against Supabase

When the 271 carries `payer.payorIdentification`:

1. Look up `portal_insurance_packages` by `edi_payer_id`. The table is hydrated daily by the `portal-insurance-sync` Prefect deployment from `mdm.insurance_reference`, which itself mirrors Athena's `EMCCODE`, the same X12 identifier Stedi returns.
2. Expand gateway aliases: `87726` (UHC) also matches `39026` (UMR) and `25463` (Surest), because UHC routes eligibility through one gateway but submits claims under different EMCCODEs per subsidiary. Map lives in `EDI_GATEWAY_ALIASES` (`lib/portal/insurance-packages.ts`).
3. Pick the best candidate via `pickFromCandidates`, in this exact order:
    - **Step 0 - Override rules.** Sample-validated >=80% purity rules in `PACKAGE_OVERRIDES` (e.g. UHC Surest plan-name signal -> package `746442`; UHC AARP/MA-PPO plan-name signal -> package `70322`). Bypasses everything else when matched.
    - **Step 1 - EB04 filter.** `ALLOWED_PRODUCT_TYPES_BY_EB04` narrows the candidate pool to product-type IDs valid for the X12 Insurance Type Code. `MA`/`MB` -> Medicare PPO/HMO/FFS; `MC` -> Medicaid HMO/Traditional; `C1` -> commercial. EB04 is the most authoritative signal because payers contractually populate it.
    - **Step 2 - Plan-name regex.** `inferProductTypeIdFromPlanLine` looks for explicit signals (`MA-PPO`, `MEDICARE ADVANTAGE`, `EPO`, `HMO`) and pins the product-type ID directly when found.
    - **Step 3 - Brand allowed-set filter.** `ALLOWED_PRODUCT_TYPES_BY_HINT` prevents picking a Medicare package for a brand whose `productHint` is `commercial`, even if the Medicare package is the most popular candidate.
    - **Step 4 - Dominant-package fallback.** When EB04 and planName both come back blank (common for UHC), `DOMINANT_PACKAGE_BY_EDI_EB04` provides a hand-curated dominant package per `(EDI, EB04)` pair. Returns `lowConfidence: true`. Temporary mitigation while `patient_insurance_count` is unreliable.
    - **Step 5 - Head of list.** Falls through to the most-popular-by-volume candidate. Returned with `lowConfidence: true` if more than one candidate survived.
4. Reclassify `isGovernmentFunded` via `classifyAsGovernmentFunded`, which catches Medicare Supplemental Plans (where `government_insurance` is null in the source but the product type is "Medicare ...") and overrides upstream falsy values. See `docs/portal/coverage-classification-sanity-check.md`.

#### L5b - Fallback: legacy brand table

`resolvePackageFromBrandTable` runs when:

- Stedi 271 has no `payerEdiId`, or
- The id-match lookup returns zero candidates (EDI not yet mirrored), or
- The Supabase lookup throws (outage, RLS misconfiguration).

The brand table (`BRAND_MAPPINGS`) is the pre-id-match heuristic - one to a few packages per brand, with optional `planMatcher` regexes. Validated against the DEV-3961 22-patient sample. Returns `confidence: "heuristic" | "deterministic" | "fallback"`.

The reason string returned by the resolver always includes both the path taken (`id-match` vs `fallback`) and the narrowing logic, so Sentry breadcrumbs and the `portal_registration_followups.result` row are debuggable without re-running the 271.

### L6 - Preview-environment package remap

`resolveAthenaInsurancePackageId` in `lib/portal/insurance-packages.ts`.

- `portal_insurance_packages` carries production Athena IDs. Athena Preview has its own registry; almost no production ID resolves there.
- Detected via `ATHENA_BASE_URL` containing `preview` (most authoritative) with `VERCEL_ENV === "preview"` as a backstop.
- Remaps any requested ID to `PORTAL_PREVIEW_INSURANCE_PACKAGE_ID` (default `1132`, BCBS-MN). Verified to resolve in Preview by `scripts/probe-athena-preview-insurance.ts`.
- Production: unconditional pass-through. The remap never runs in prod.

### L7 - Athena attach

`addInsurance` from `@/lib/athena/client`.

- POST `/patients/{id}/insurances` with normalized policyholder demographics. Self relationships hydrate firstName/lastName/DOB/sex from the existing Athena patient record so the wizard never has to ask the patient again.
- 409 ("existing insurance package") is recovered by listing the patient's insurances and matching by package ID, then returning the existing row. Common in preview where every patient ends up on the same `1132` stand-in.
- Other 4xx/5xx are caught at the route level, written to a soft-fail row with raw `responseBody` truncated to 500 chars, and the wizard advances.
- A missing `insuranceid` on the post-insert response is recovered via list-and-match. If still missing, a `preview-{ts}` placeholder is synthesized and tagged `ATHENA_INSURANCEID_SYNTH`.

### L8 - Audit layer

`recordFollowup` writes one row per resolver invocation to `portal_registration_followups`. Success rows carry the full upstream response in `result` so Supabase is a complete backup of record. Soft-fail rows carry the error code, status, raw response body (truncated), and a Sentry event id for cross-linking.

## Initial Visit type selection

`src/lib/scheduling/appointment-types.ts`

`getRegistrationVariantFromInsurance(insurance)` maps the resolver's `isGovernmentFunded` to:

- `"standard"` (default) -> Initial Visit type **47** in-person, **223** telehealth. 90-minute slot. Required for Medicare/Medicaid AWV-style new-patient intake.
- `"mbr"` (only when explicitly `isGovernmentFunded === false`) -> MBR Initial Visit type **461** in-person, **223** telehealth. 60-minute slot. The membership-billable visit.

`REGISTRATION_INITIAL_VISIT_TYPE_IDS` is the allowlist enforced by both `register/appointments/available` and `register/appointments/book`. Anything outside `{47, 142, 223, 461}` is rejected with `REGISTRATION_TYPE_NOT_ALLOWED` so a `regToken` can never be repurposed to enumerate or book Routine, Urgent, or AWV slots.

`142` ("Any 90 (Initial)") is kept in the allowlist for backwards-compat with stale clients. Empirical Preview-tenant slot coverage (60-day horizon, `scripts/probe-athena-initial-slot-coverage.ts`) showed `47/461` resolve at every clinic, while `142` only resolves at Highland Park.

## File and endpoint inventory

### Files (registration-only)

| Path | Role |
|------|------|
| `src/middleware.ts` | Portal-mode rewrite, Clerk protection, public allow-list for `/api/portal/register/*` |
| `src/lib/portal/feature-flags.ts` | `getPortalFeatureFlags`, `getClientPortalFeatureFlags`, defaults |
| `src/lib/portal/membership-guard.ts` | `membershipDisabledResponse()` (410 Gone) |
| `src/app/(portal)/layout.tsx` | ClerkProvider, PortalShell, conditional PortalChatWidget mount, `noindex` |
| `src/app/(portal)/portal/register/page.tsx` | Renders `RegistrationWizard` |
| `src/app/(portal)/portal/register/eligibility/page.tsx` | Picks `EligibilityCheckBrand` vs legacy `EligibilityCheck` |
| `src/app/(portal)/portal/register/membership/page.tsx` | Redirects to `/register/schedule` when membership flag off |
| `src/app/(portal)/portal/register/schedule/page.tsx` | Renders `InitialVisitScheduler` |
| `src/app/(portal)/portal/register/confirmation/page.tsx` | Renders `RegistrationConfirmation` |
| `src/components/portal/registration/RegistrationWizard.tsx` | Demographics form, dynamic progress bar |
| `src/components/portal/registration/EligibilityCheckBrand.tsx` | Brand cards + member-id capture + Stedi-driven combined check |
| `src/components/portal/registration/EligibilityCheck.tsx` | Legacy typeahead path |
| `src/components/portal/registration/InitialVisitScheduler.tsx` | Location -> provider -> slot, variant-aware Initial Visit type |
| `src/components/portal/registration/RegistrationConfirmation.tsx` | Confirmation copy, conditional account upsell |
| `src/components/portal/registration/registration-client.ts` | `regToken` storage and `registerFetch` |
| `src/components/portal/PortalChatWidget.tsx` | Retell Dot widget (flag off in both envs) |
| `src/lib/identity/passive-clerk.ts` | `createPassiveClerkUser` (idempotent dormant Clerk provisioning) |
| `src/lib/portal/insurance-packages.ts` | `lookupPortalInsuranceByEdiPayerId`, `EDI_GATEWAY_ALIASES`, `resolveAthenaInsurancePackageId` |
| `src/lib/portal/followup.ts` | `recordFollowup`, `mintPendingPatientId`, `isPendingPatientId` |
| `src/lib/portal/api.ts` | `withPortalErrors`, idempotency, JSON parsing |
| `src/lib/portal/providers.ts`, `locations.ts` | Curated provider + clinic directories used as allowlists |
| `src/lib/stedi/client.ts` | Stedi HTTP client and `runEligibilityCheck` |
| `src/lib/stedi/brand-resolver.ts` | `PORTAL_PAYER_BRANDS`, MA retry helper |
| `src/lib/stedi/eligibility-summary.ts` | `summarizeEligibility`, `explainRejection` |
| `src/lib/stedi/package-resolver.ts` | id-match primary + legacy fallback, with `pickFromCandidates` 5-step funnel |
| `src/lib/scheduling/appointment-types.ts` | Initial Visit type variant + allowlist |
| `supabase/migrations/20260417_portal_insurance_packages.sql` | Catalog table |
| `supabase/migrations/20260425_portal_insurance_packages_add_edi_payer_id.sql` | `edi_payer_id`, `insurance_product_type_id` |
| `supabase/migrations/20260425_portal_registration_followups.sql` | Audit + queue table |
| `scripts/sync-portal-insurance.ts` | Ad-hoc upsert from `mdm.insurance_reference` |

### API endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/portal/register/patient` | Create Athena + Hint patient, mint `regToken`, optionally provision dormant Clerk user | None (rate-limited + idempotent) |
| GET | `/api/portal/register/locations` | Curated clinic directory | regToken |
| GET | `/api/portal/register/providers` | Curated provider directory | regToken |
| GET | `/api/portal/register/insurance/brands` | Brand catalog for Stedi UI | regToken |
| GET | `/api/portal/register/insurance/search` | Typeahead on `portal_insurance_packages` (legacy) | regToken |
| POST | `/api/portal/register/insurance` | Attach package in Athena (legacy path) | regToken |
| POST | `/api/portal/register/eligibility` | Brand + member-id -> Stedi 270/271 -> reverse-resolve -> Athena attach | regToken |
| GET | `/api/portal/register/appointments/available` | Open Initial Visit slots (allowlist enforced) | regToken |
| POST | `/api/portal/register/appointments/book` | Book Initial Visit (allowlist enforced) + create Salesforce Lead | regToken |
| POST | `/api/portal/register/handoff` | Salesforce Lead from chat widget | None |
| POST | `/api/portal/register/membership/*` | Membership routes; return `410 Gone` while flag off in both envs | regToken |

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `NEXT_PUBLIC_PORTAL_MODE` | Master switch for the `/portal/*` route group | `false` (ON in staging and prod) |
| `NEXT_PUBLIC_PORTAL_DOT_ENABLED` | Mount the Retell Dot chat widget; gate Retell tool/chat routes | `false` (OFF in staging and prod) |
| `NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED` | Show Membership step in wizard; allow `/register/membership` and its APIs | `false` (OFF in staging and prod) |
| `NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED` | Show "Sign in" / "Create my account" CTAs | `false` (OFF in staging and prod) |
| `PORTAL_PASSIVE_CLERK_ENABLED` | Provision dormant Clerk users at patient-create time | `true` (ON in staging and prod) |
| `NEXT_PUBLIC_ENABLE_STEDI_ELIGIBILITY` | Client-side switch for `EligibilityCheckBrand` vs legacy | `false` (ON in staging and prod) |
| `ENABLE_STEDI_ELIGIBILITY` | Server-side switch; off returns `501 STEDI_DISABLED` | `false` (ON in staging and prod) |
| `STEDI_API_KEY` | Stedi Healthcare eligibility API key | Required when Stedi enabled |
| `PORTAL_PREVIEW_INSURANCE_PACKAGE_ID` | Preview-tenant Athena package stand-in | `1132` (BCBS-MN) |
| `ATHENA_BASE_URL` | Drives the preview-vs-prod detection in `resolveAthenaInsurancePackageId` | Required |
| `VERCEL_ENV` | Backstop for preview detection; gates legacy mocks | Vercel-supplied |
| `CLERK_*` | Clerk publishable + secret keys | Required |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Insurance package catalog + follow-up writes | Required |

## Data stores

| Table (Supabase) | Purpose |
|------------------|---------|
| `portal_insurance_packages` | Local copy of `mdm.insurance_reference` keyed by `edi_payer_id` and `insurance_product_type_id`. Hydrated daily by Prefect `portal-insurance-sync` (06:30 CT). |
| `portal_registration_followups` | One row per consequential decision in the wizard. Includes `step`, `outcome`, `severity`, `error_code`, raw payload + result + truncated response body. |
| `portal_identity_links` | Clerk user -> EMPI / Athena id / Hint id mapping (used by the future authenticated portal). |
| `portal_sessions`, `portal_auth_tokens` | Session and token state for the no-account flow |
| `portal_appointment_types` | Portal-specific scheduling type config (mirrored to `appointment-types.ts`) |
| `portal_conversations` | Retell chat session state (Dot is OFF in both envs; table exists for future use) |

## Error handling

| Error | Where | Resolution |
|-------|-------|------------|
| `STEDI_DISABLED` (501) | `register/eligibility` POST | Set `ENABLE_STEDI_ELIGIBILITY=true` on the server |
| Stedi 400 on payer alias | `runStediWithFallbacks` | Auto-falls through to next configured payer ID for the brand |
| Stedi `AAA` codes in 271 | `eligibility-summary` `explainRejection` | Soft-fail row written; patient sees one-line plain-English message |
| Stedi 5xx / network | `register/eligibility` catch | Soft-fail row, wizard advances |
| Athena `enhancedBestMatch` duplicate | `register/patient` | Caller sees "sign in instead" copy; real id is not returned |
| Athena 409 on insurance attach | `register/insurance` + `register/eligibility` | Recovered via list-and-match; treated as success |
| Athena 4xx/5xx on attach | `register/eligibility`, `register/insurance` | Soft-fail row with `responseBody` truncated to 500 chars |
| Athena 409 on book ("slot taken") | `register/appointments/book` | Returned to UI as `ATHENA_SLOT_TAKEN`, audit-only `status=resolved` row |
| Pending patient ID downstream | All register routes | Skip Athena call; write follow-up row tagged `PENDING_PATIENT`; return synthetic success |
| Membership API hit while flagged off | `lib/portal/membership-guard.ts` | Returns `410 Gone` |
| Dot tool call while flagged off | `api/portal/retell/*` | Returns `503` |
| Passive Clerk failure | `register/patient` | Audit row tagged `passive_clerk_create`; no patient impact |

## Monitoring

| Signal | Where | Alert threshold |
|--------|-------|-----------------|
| Sentry breadcrumbs and exceptions | `withPortalErrors` (`src/lib/portal/api.ts`); each register route; `recordFollowup` | Spike alarm on >10 errors per 5 min, per route |
| Audit trail | `portal_registration_followups` (one row per consequential decision) | Daily soft-fail review by RCM |
| Idempotency cache | Upstash via `lib/portal/api.ts` (`Idempotency-Key` on patient create, eligibility, book) | Cache miss rate spike |
| Slot cache | Upstash, 60s TTL keyed by `(department, provider, type, dateRange)` | None |
| Resolver confidence | `PackageResolverResult.confidence` and `lowConfidence`; logged as Sentry breadcrumb when not `id-match` | Trend review weekly |
| E2E coverage | `tests/e2e/portal-her-flow.spec.ts`, `portal-clerk-athena.spec.ts`, `tests/dot/SCENARIOS.md` | CI green on PR |

## Known TODOs in the codebase

- `register/claim/send/route.ts` - SMS channel is wired as a stub; not yet enabled.
- `register/membership/plans/route.ts` - explicit `TODO(prod)` and `TODO(sandbox)` for specific Hint SKUs and amounts. Currently 410 anyway.
- `brand-resolver.ts` - Phase 2 will move the brand catalog from in-code constants to a Supabase `portal_payer_brand` table.
- `package-resolver.ts` - `DOMINANT_PACKAGE_BY_EDI_EB04` is a temporary mitigation while `patient_insurance_count` in Supabase remains unreliable. Remove once the Prefect sync populates it.

## Related documentation

- [Initial Visit Registration - Business Guide](ac:Initial Visit Registration - Business Guide)
- [Authenticated Patient Portal - Future Development](ac:Authenticated Patient Portal - Future Development)
- [Authenticated Patient Portal - Future Technical Plan](ac:Authenticated Patient Portal - Future Technical Plan)
- *Stedi Eligibility Disambiguation* (`docs/stedi/disambiguation-analysis-2026-04-v2.md`)
- *Coverage Classification Sanity Check* (`docs/portal/coverage-classification-sanity-check.md`)

---

**Owner:** Patient Portal product team · **Last reviewed:** 2026-05-05
