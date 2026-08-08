/**
 * Typed event helpers for the patient-registration funnel and other
 * cross-page flows. Centralizing event names + property shapes here keeps
 * dashboards from drifting and makes it harder to accidentally ship PHI
 * inside a property value.
 *
 * Rule: properties may carry IDs (Athena PID, SF Lead Id, Clerk user id,
 * insurance package id) and categorical values (brand id, eligibility
 * status, plan type). They MUST NOT carry: subscriber/member ID, group
 * number, DOB, name, email, phone, address, free-text notes.
 */

import { posthog } from "../../../instrumentation-client";
import {
  assertOpaqueDistinctId,
  hashToOpaqueDistinctId,
  sanitizeProperties,
} from "./sanitize";
import { readMarketingVisitorIdFromDocument } from "./marketing-visitor";

function safeCapture(event: string, props: Record<string, unknown>): void {
  posthog.capture?.(event, sanitizeProperties(props));
}

/** Distinct id to attach to marketing form POST bodies for server-side stitch. */
export function getMarketingVisitorDistinctIdForSubmit(): string | undefined {
  const fromCookie = readMarketingVisitorIdFromDocument();
  if (fromCookie) return fromCookie;
  const fromSdk = posthog.get_distinct_id?.();
  return typeof fromSdk === "string" && fromSdk.length > 0 ? fromSdk : undefined;
}

/**
 * After a successful marketing form POST, merge the anonymous browsing
 * person (`hh_did` / posthog-js id) into a stable lead hash so the same
 * PostHog person owns pageviews + conversion + any later return visits.
 */
export async function stitchMarketingLeadIdentity(props: {
  email: string;
  leadSource?: string | null;
  landingPage?: string | null;
}): Promise<void> {
  if (!posthog?.identify) return;

  const normalizedEmail = props.email.trim().toLowerCase();
  if (!normalizedEmail) return;

  let leadHash: string;
  try {
    leadHash = await hashToOpaqueDistinctId(`lead:${normalizedEmail}`);
  } catch {
    return;
  }
  if (!assertOpaqueDistinctId(leadHash)) return;

  const visitorId =
    readMarketingVisitorIdFromDocument() ?? posthog.get_distinct_id?.();
  if (
    visitorId &&
    typeof visitorId === "string" &&
    visitorId !== leadHash &&
    !visitorId.startsWith("hh:") &&
    !visitorId.startsWith("user_")
  ) {
    posthog.alias?.(leadHash, visitorId);
  }

  posthog.identify?.(leadHash, {
    hh_id_source: "marketing_lead",
    lead_source: props.leadSource ?? null,
    landing_page: props.landingPage ?? null,
  });
}

// ── Marketing form funnel (client) ─────────────────────────────────────
//
// Canonical PostHog events for the "any page → any form → Salesforce lead"
// funnel. These fire on EVERY marketing form (Storyblok Form / LeadForm /
// WaitlistForm / Event modals / legacy landing pages) so the conversion is
// captured even when the form POSTs to an external Storyblok action that
// never reaches our API routes. They run on the same
// anonymous `hh_did` person as the visitor's pageviews, so a single PostHog
// person owns: $pageview → form_started → form_submitted, and (once the
// server confirms the Salesforce write) lead_form_submitted.
//
// Naming: `form_started` / `form_submitted` (object_verb, snake_case) match
// the rest of this module. They are intentionally distinct from the GA4
// dataLayer `form_start` / `form_submission` names and from the server-side
// authoritative `lead_form_submitted`, so nothing double-counts.

/** Categorical attribution shared across the form funnel events. */
export interface FormFunnelAttribution {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  utmId?: string | null;
  gclid?: string | null;
  msclkid?: string | null;
  fbclid?: string | null;
  landingPage?: string | null;
  referrer?: string | null;
}

export interface FormFunnelMeta {
  /** Stable form category, e.g. "patient_intake", "waitlist", "lead_form". */
  formType: string;
  /** Storyblok/component id or slug when available. */
  formId?: string | null;
  /** Variant/source label so dashboards can split A/B or per-LP forms. */
  formVariant?: string | null;
  leadSource?: string | null;
  /**
   * Whether the visitor accepted the form's consent/TOS/privacy line. For most
   * marketing forms submitting the form IS the consent action, so this is true
   * on submit. Surfaced for compliance evidence + consent-drop-off funnels.
   */
  consentGiven?: boolean | null;
  /** Which consent the form gates on: HIPAA acknowledgment, marketing, or TOS. */
  consentType?: FormConsentType | null;
  /**
   * Extra categorical properties merged onto the event (e.g. event_title,
   * campaign_id). MUST be non-PHI — `safeCapture` runs everything through
   * `sanitizeProperties` as a backstop.
   */
  extra?: Record<string, unknown>;
}

export type FormConsentType = "hipaa" | "marketing" | "terms";
export type FormSubmissionStatus = "success" | "error";

/** Reduce a full referrer URL to its host so we never ship querystring PHI. */
function referrerHostOnly(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname;
  } catch {
    return null;
  }
}

function formFunnelProperties(
  meta: FormFunnelMeta,
  attr?: FormFunnelAttribution
): Record<string, unknown> {
  return {
    form_type: meta.formType,
    form_id: meta.formId ?? null,
    form_variant: meta.formVariant ?? null,
    lead_source: meta.leadSource ?? null,
    consent_given: meta.consentGiven ?? null,
    consent_type: meta.consentType ?? null,
    landing_page: attr?.landingPage ?? null,
    referrer_host: referrerHostOnly(attr?.referrer),
    utm_source: attr?.utmSource ?? null,
    utm_medium: attr?.utmMedium ?? null,
    utm_campaign: attr?.utmCampaign ?? null,
    utm_content: attr?.utmContent ?? null,
    utm_term: attr?.utmTerm ?? null,
    utm_id: attr?.utmId ?? null,
    gclid: attr?.gclid ?? null,
    msclkid: attr?.msclkid ?? null,
    fbclid: attr?.fbclid ?? null,
    ...(meta.extra ?? {}),
  };
}

/**
 * Fire `form_started` the first time a visitor engages with a form. Callers
 * should guard this so it fires at most once per form instance (e.g. on the
 * first field focus). PostHog itself drops the event when the visitor has not
 * opted in, so no extra consent gate is required here.
 */
export function trackFormStarted(
  meta: FormFunnelMeta,
  attr?: FormFunnelAttribution
): void {
  safeCapture("form_started", formFunnelProperties(meta, attr));
}

/**
 * Fire `form_submitted` when a marketing form is submitted. This ONLY captures
 * the analytics event — it never receives or handles an email. Lead identity
 * stitching is a separate, explicit step via `stitchMarketingLeadIdentity`
 * (which hashes the email to an opaque id) so PHI can never reach an analytics
 * property by construction.
 */
export function trackFormSubmitted(
  meta: FormFunnelMeta,
  attr?: FormFunnelAttribution
): void {
  safeCapture("form_submitted", {
    ...formFunnelProperties(meta, attr),
    submission_status: "success" satisfies FormSubmissionStatus,
  });
}

/**
 * Fire `form_submit_failed` when a form submission errors (network/validation/
 * downstream write). `errorMessage` MUST be a categorical reason code, never a
 * raw server message that could echo user input — `safeCapture` sanitizes keys
 * but cannot scrub free-text values.
 */
export function trackFormSubmitFailed(
  meta: FormFunnelMeta,
  errorReason?: string | null,
  attr?: FormFunnelAttribution
): void {
  safeCapture("form_submit_failed", {
    ...formFunnelProperties(meta, attr),
    submission_status: "error" satisfies FormSubmissionStatus,
    error_reason: errorReason ?? null,
  });
}

// ── Registration funnel ───────────────────────────────────────────────

export function trackRegistrationStarted(props: {
  source?: string | null;
  leadSource?: string | null;
  utmCampaign?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmContent?: string | null;
  landingPage?: string | null;
}): void {
  safeCapture("registration_started", props);
}

/** CTA click from a marketing landing page → my.example-patient-portal.com/register. */
export function trackLandingRegisterCtaClick(props: {
  landingPage: string;
  cta: "book_my_welcome_visit" | "choose_appointment_time";
  destination?: "register";
  pageType?: string;
}): void {
  safeCapture("landing_register_cta_click", props);
}

export function trackRegistrationDemographicsSubmitted(props: {
  medicareEnrolled: "yes" | "no";
  departmentId?: number;
  state?: string;
}): void {
  safeCapture("registration_demographics_submitted", props);
}

export function trackRegistrationOffRamp(props: {
  reason: "medicare_no" | "endFlow" | "guided_handoff" | "athena_failure";
}): void {
  safeCapture("registration_off_ramp", props);
}

export function trackEligibilityChecked(props: {
  brandId: string;
  resolvedPlanName?: string;
  insurancePackageId?: number;
  isGovernmentFunded?: boolean;
  coverageStatus?: "active" | "inactive" | "indeterminate" | "unknown";
  eligibilityStatus?: "Active" | "Inactive" | "Indeterminate" | "Guided Handoff";
  endFlow?: boolean;
  stediPayerIdUsed?: string;
  attachSucceeded?: boolean;
}): void {
  safeCapture("eligibility_checked", props);
}

export function trackInsuranceAttachFailed(props: {
  brandId: string;
  errorCode?: string;
  insurancePackageId?: number;
}): void {
  safeCapture("insurance_attach_failed", props);
}

export function trackScheduleViewed(props: {
  visitTypeId: number;
  durationMinutes: number;
  departmentId?: number;
}): void {
  safeCapture("schedule_viewed", props);
}

export function trackAppointmentBooked(props: {
  appointmentId: string;
  appointmentTypeId: number;
  departmentId: number;
  daysUntilAppointment: number;
}): void {
  safeCapture("appointment_booked", props);
}

/**
 * Allowed categorical reasons for an appointment-booking failure. Keep
 * this enum closed — backend / Athena error strings often embed PHI
 * (patient names in conflict messages, free-text reasons) so callers
 * MUST classify into one of these buckets before reporting.
 */
export type AppointmentBookFailureReason =
  | "slot_taken"
  | "slot_invalid"
  | "patient_not_found"
  | "patient_ineligible"
  | "duplicate_appointment"
  | "athena_5xx"
  | "athena_4xx"
  | "network_error"
  | "validation_error"
  | "unknown";

const ALLOWED_BOOK_FAIL_REASONS: ReadonlySet<AppointmentBookFailureReason> =
  new Set<AppointmentBookFailureReason>([
    "slot_taken",
    "slot_invalid",
    "patient_not_found",
    "patient_ineligible",
    "duplicate_appointment",
    "athena_5xx",
    "athena_4xx",
    "network_error",
    "validation_error",
    "unknown",
  ]);

export function trackAppointmentBookFailed(props: {
  reason: AppointmentBookFailureReason;
  appointmentTypeId?: number;
  departmentId?: number;
}): void {
  // Runtime guard in case a JS caller bypasses the TS type.
  const reason: AppointmentBookFailureReason = ALLOWED_BOOK_FAIL_REASONS.has(
    props.reason
  )
    ? props.reason
    : "unknown";
  safeCapture("appointment_book_failed", { ...props, reason });
}

// ── Identify helpers ───────────────────────────────────────────────────

/**
 * Identify with an opaque ID. Pass the Athena patient id once it exists
 * (post-demographics submit) and switch to the Clerk user id post-claim.
 *
 * Properties are limited to non-PHI categorical values:
 *   - patient_state: "MN" etc.
 *   - registration_source: lead source
 *   - eligibility_status_last: "Active"
 */
export function identifyOpaque(
  distinctId: string,
  setOnce?: Record<string, string | number | boolean | null>,
  setEveryTime?: Record<string, string | number | boolean | null>
): void {
  if (!distinctId) return;
  // Hard gate: any caller that hasn't pre-hashed an upstream identifier
  // (Athena PID, member id, etc.) gets dropped here instead of leaking
  // PHI into PostHog Person rows. See sanitize.ts for the allowed shape.
  if (!assertOpaqueDistinctId(distinctId)) return;
  posthog.identify?.(
    distinctId,
    sanitizeProperties(setEveryTime ?? undefined) as Record<
      string,
      string | number | boolean | null
    >,
    sanitizeProperties(setOnce ?? undefined) as Record<
      string,
      string | number | boolean | null
    >
  );
}

/**
 * Merge an anonymous browsing session into the now-identified person.
 * Call this exactly once, right after the first identify().
 */
/**
 * Merge a known anonymous distinct id (the auto-generated one PostHog
 * assigns on first pageview) into the now-identified person. Per
 * PostHog's contract this MUST be called BEFORE `identify()` for the
 * cross-session merge to take effect — once `identify()` runs, the
 * current distinct id has already changed and `alias()` becomes a
 * no-op (or worse, aliases the new id to itself).
 *
 * Both arguments are required:
 *   - `anonymousDistinctId`: the pre-login id (read via `posthog.get_distinct_id()`)
 *   - `identifiedDistinctId`: the post-login opaque id (Clerk user_*, hh:<hex>)
 *
 * Both ids are passed through `assertOpaqueDistinctId` — anon IDs
 * generated by PostHog itself start with `user_` shapes acceptable to
 * the regex; if PostHog ever changes that, this guard will drop the
 * alias safely rather than leak PHI.
 */
export function aliasAnonymousToIdentity(
  anonymousDistinctId: string,
  identifiedDistinctId: string
): void {
  if (!anonymousDistinctId || !identifiedDistinctId) return;
  if (!assertOpaqueDistinctId(identifiedDistinctId)) return;
  // PostHog signature: alias(alias, distinctId) — links `alias` (the
  // new identified id) to `distinctId` (the old anonymous id).
  posthog.alias?.(identifiedDistinctId, anonymousDistinctId);
}

export function resetPostHog(): void {
  posthog.reset?.();
}

// ── Membership ────────────────────────────────────────────────────────

export function trackMembershipCancelInitiated(props: {
  withinGuarantee: boolean;
}): void {
  safeCapture("membership_cancel_initiated", props);
}

export function trackMembershipCancelled(props: {
  withinGuarantee: boolean;
}): void {
  safeCapture("membership_cancelled", props);
}

// ── Invoices ──────────────────────────────────────────────────────────

export function trackInvoicePaid(): void {
  safeCapture("invoice_paid", {});
}

export function trackInvoicePaymentFailed(props: {
  errorMessage: string;
}): void {
  // Strip any free-text that could contain PHI — keep only the first
  // 100 chars of the API error message (these are categorical strings
  // from HINT Health, not patient data, but we cap to be safe).
  safeCapture("invoice_payment_failed", {
    error_message: String(props.errorMessage).slice(0, 100),
  });
}

// ── Portal appointment actions ────────────────────────────────────────

export function trackAppointmentCancelled(props: {
  appointmentId: string;
}): void {
  safeCapture("appointment_cancelled", props);
}
