/**
 * POST /api/portal/register/eligibility
 *
 * Two body shapes are supported during the Stedi rollout:
 *
 * 1. Stedi flow (preferred when ENABLE_STEDI_ELIGIBILITY=1 in the env):
 *
 *    {
 *      brandId: "bcbs" | "uhc" | "medicare" | ...,
 *      memberId: "ABC123",
 *      groupNumber?: "00012345",
 *      relationshiptoinsuredid?: 1, // 1 = Self, 2 = Spouse, 3 = Child, 4 = Other
 *      policyholder?: { firstName, lastName, dob }
 *    }
 *
 *    The server runs a Stedi 270/271 against the brand's curated payer ID,
 *    reverse-resolves the 271 to an Athena `insurancepackageid`, attaches
 *    the insurance to the patient via Athena POST /patients/{id}/insurances,
 *    and returns a `NormalizedEligibility` plus the resolved package
 *    metadata (insurancepackageid, insuranceplanname, isGovernmentFunded).
 *
 * 2. Legacy flow ({ insuranceId }) — kept for backward compatibility with
 *    the existing wizard build that still calls /insurance + /eligibility
 *    separately. Mocked in non-prod against Athena's flaky preview tenant.
 *
 * Authenticated by regToken (no Clerk).
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { captureServerException } from "@/lib/capture-exception";
import {
  AthenaApiError,
  addInsurance,
  getInsurancePackageById,
  getPatient,
  getPatientInsurances,
  triggerEligibilityCheck,
  type AthenaInsurance,
} from "@/lib/athena/client";
import { updateRecordTolerant } from "@/lib/salesforce/field-tolerant";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import {
  withPortalErrors,
  parseJsonBody,
  portalError,
  idempotencyGet,
  idempotencySet,
} from "@/lib/portal/api";
import { rateLimit } from "@/lib/rate-limit";
import { recordFollowup, isPendingPatientId } from "@/lib/portal/followup";
import { captureServerEvent } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";
import {
  StediApiError,
  runEligibilityCheck,
  type StediEligibilityProvider,
  type StediEligibilityResponse,
} from "@/lib/stedi/client";
import {
  isAwvEligibleBrand,
  isAwvLookupEnabled,
  runAwvEnrichment,
} from "@/lib/portal/awv-lookup";
import {
  summarizeEligibility,
  explainRejection,
} from "@/lib/stedi/eligibility-summary";
import {
  getBrand,
  resolveBrandForStedi,
  pickRetryBrandFromOtherPayer,
} from "@/lib/stedi/brand-resolver";
import { resolvePackageFromEligibility } from "@/lib/stedi/package-resolver";
import { resolveAthenaInsurancePackageId } from "@/lib/portal/insurance-packages";
import type { NormalizedEligibility } from "@/lib/stedi/types";
import { toPlanDisplay } from "@/lib/portal/plan-display";
import { SalesforceClient } from "@/lib/salesforce/client";
import { createRecordTolerant } from "@/lib/salesforce/field-tolerant";
import { mapReferralSourceToSf } from "@/lib/salesforce/referral-source";
import { normalizeLeadSource } from "@/lib/salesforce/normalize-lead-source";
import type { VerifiedRegistrationToken } from "@/lib/auth/registration-token";

type SfEligibilityStatus =
  | "Active"
  | "Inactive"
  | "Indeterminate"
  | "Guided Handoff";

/**
 * Best-effort lookup of the Athena insurance plan name for a given
 * `insurancepackageid`, used so the Salesforce Lead/Account get a
 * human-readable carrier label (e.g. "Blue Cross Blue Shield of MN PPO")
 * instead of an opaque "Athena package #35017".
 *
 * Strategy: Athena `getPatientInsurances` returns the patient's attached
 * insurances with `insuranceplanname` already populated. After legacy
 * `/insurance/add` runs, the package id we want is one of those rows.
 * Returns `null` if we can't resolve it — callers fall through to a
 * generic label so the Lead still gets created.
 */
async function fetchInsurancePlanName(
  athenaPatientId: string,
  insurancePackageId: number,
): Promise<string | null> {
  // Primary: read from the patient's attached insurances (always populated
  // post-attach in the legacy /insurance flow).
  try {
    const list = await getPatientInsurances(athenaPatientId);
    const match = list.find(
      (i) => Number(i.insurancepackageid) === Number(insurancePackageId),
    );
    if (match?.insuranceplanname?.trim()) {
      return match.insuranceplanname.trim();
    }
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-eligibility",
        step: "fetchInsurancePlanName/getPatientInsurances",
        severity: "non_fatal",
      },
    });
  }

  // Fallback: query Athena's insurancepackages catalog directly by id.
  // Covers the case where the patient's attached insurances haven't
  // propagated yet (sandbox eventual consistency).
  try {
    const pkg = await getInsurancePackageById(insurancePackageId);
    const name = pkg?.insuranceplanname?.trim();
    if (name) return name;
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-eligibility",
        step: "fetchInsurancePlanName/byId",
        severity: "non_fatal",
      },
    });
  }

  return null;
}

/**
 * Best-effort Salesforce Lead create at the eligibility step. Linked to
 * the PersonAccount created at /register/patient via Matched_Account__c.
 * Captures eligibility status + primary insurance + UTMs/lead source so
 * back-office has the full registration context as soon as insurance is
 * known (before the patient even picks a slot).
 *
 * Returns the new Lead Id, or undefined on any failure (logged to
 * Sentry + console). Never throws.
 */
async function ensureLeadAtEligibility(args: {
  session: VerifiedRegistrationToken;
  primaryInsurance: string | null;
  eligibilityStatus: SfEligibilityStatus;
}): Promise<string | undefined> {
  const { session, primaryInsurance, eligibilityStatus } = args;

  // Mirror the eligibility outcome onto the PersonAccount so it lines up
  // with what the nightly Athena→SF sync writes.
  if (session.salesforceAccountId && primaryInsurance) {
    try {
      const sf = await SalesforceClient.fromEnvironment();
      if (sf) {
        await updateRecordTolerant(
          sf,
          session.salesforceAccountId,
          {
            Primary_Insurance_Plan__c: String(primaryInsurance).slice(0, 255),
          },
          {
            context: "register-eligibility/account-insurance",
            sobject: "Account",
          },
        );
      }
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-eligibility",
          step: "patchAccountPrimaryInsurance",
          severity: "non_fatal",
        },
      });
    }
  }

  // If we already have a Lead created in Step 1, update it with eligibility status + primary insurance
  if (session.salesforceLeadId) {
    try {
      const sf = await SalesforceClient.fromEnvironment();
      if (sf) {
        const updateData: Record<string, unknown> = {
          Eligibility_Status__c: eligibilityStatus,
          Eligibility_Checked_At__c: new Date().toISOString(),
        };
        if (primaryInsurance) {
          updateData.HealthCloudGA__PrimaryInsurance__c = String(
            primaryInsurance,
          ).slice(0, 255);
        }
        await updateRecordTolerant(
          sf,
          session.salesforceLeadId,
          updateData,
          {
            context: "register-eligibility/lead-update",
            sobject: "Lead",
          }
        );
      }
      return session.salesforceLeadId;
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-eligibility",
          step: "updateSalesforceLead",
          severity: "non_fatal",
        },
      });
      console.warn(
        "[Portal:register-eligibility] Salesforce Lead update failed:",
        err,
      );
      return session.salesforceLeadId;
    }
  }

  if (!session.salesforceAccountId) return undefined;
  if (!session.email && !session.phone) return undefined;

  try {
    const sf = await SalesforceClient.fromEnvironment();
    if (!sf) return undefined;

    const leadData: Record<string, unknown> = {
      FirstName: session.firstName,
      LastName: session.lastName,
      Email: session.email,
      MobilePhone: session.phone,
      Company: "Individual",
      // LeadSource may arrive as a raw URL param value
      // ("newpatients", "membership", "google", …) — normalize to the
      // controlled SF picklist before stamping. Falls back to
      // "Website" inside normalizeLeadSource when the raw value is
      // empty, but we override that fallback with the wizard's
      // canonical default of "Online Registration" so existing
      // reporting that filters on it keeps working.
      LeadSource: session.leadSource
        ? normalizeLeadSource(session.leadSource)
        : "Online Registration",
      Matched_Account__c: session.salesforceAccountId,
      Patient_ID__c: session.athenaPatientId,
      Online_Registration_Started__c: true,
      Eligibility_Status__c: eligibilityStatus,
      Eligibility_Checked_At__c: new Date().toISOString(),
    };
    if (primaryInsurance) {
      leadData.HealthCloudGA__PrimaryInsurance__c = String(
        primaryInsurance,
      ).slice(0, 255);
    }
    // Wizard "How did you hear about us?" → SF picklist value. The
    // wizard sends the patient-friendly label (e.g. "Doctor Referral");
    // SF's Lead.How_did_you_hear_about_us__c picklist uses the longer
    // reporting label ("Healthcare Provider"). The mapping table lives
    // in lib/salesforce/referral-source.ts so there's exactly one
    // source of truth.
    const sfReferralSource = mapReferralSourceToSf(session.referralSource);
    if (sfReferralSource) {
      leadData.How_did_you_hear_about_us__c = sfReferralSource;
    }
    const utm = session.utm ?? {};
    if (utm.source) leadData.utm_source__c = utm.source;
    if (utm.medium) leadData.utm_medium__c = utm.medium;
    if (utm.campaign) leadData.utm_campaign__c = utm.campaign;
    if (utm.content) leadData.utm_content__c = utm.content;
    if (utm.term) leadData.utm_term__c = utm.term;
    if (utm.id) leadData.utm_id__c = utm.id;
    if (utm.gclid) leadData.GCLID__c = utm.gclid;
    // Tolerant-write the rest of the attribution context. If the SF
    // org doesn't have these custom fields they're dropped silently
    // by `createRecordTolerant` (INVALID_FIELD retry loop) — no need
    // to gate on schema introspection.
    if (utm.msclkid) leadData.MSCLKID__c = utm.msclkid;
    if (utm.fbclid) leadData.FBCLID__c = utm.fbclid;
    if (session.landingPage) {
      leadData.Landing_Page_URL__c = session.landingPage.slice(0, 255);
    }
    if (session.referrer) {
      leadData.Referrer_URL__c = session.referrer.slice(0, 255);
    }

    for (const k of Object.keys(leadData)) {
      if (leadData[k] === undefined) delete leadData[k];
    }

    const created = await createRecordTolerant(sf, leadData, {
      context: "register-eligibility/lead-create",
      sobject: "Lead",
    });
    return created.id;
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-eligibility",
        step: "createSalesforceLead",
        severity: "non_fatal",
      },
    });
    console.warn(
      "[Portal:register-eligibility] Salesforce Lead create failed:",
      err,
    );
    return undefined;
  }
}

interface LegacyPayload {
  insuranceId: number;
  dateOfService?: string;
}

interface StediPayload {
  brandId: string;
  memberId: string;
  groupNumber?: string;
  relationshiptoinsuredid?: number;
  policyholder?: {
    firstName?: string;
    lastName?: string;
    /** Accepts ISO YYYY-MM-DD or Athena MM/DD/YYYY. */
    dob?: string;
  };
}

type EligibilityPayload = LegacyPayload | StediPayload;

function isStediPayload(body: EligibilityPayload): body is StediPayload {
  return typeof (body as StediPayload).brandId === "string";
}

function shouldMockEligibility(): boolean {
  return process.env.VERCEL_ENV !== "production";
}

function isStediFlowEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ENABLE_STEDI_ELIGIBILITY ?? "");
}

/** YYYY-MM-DD | MM/DD/YYYY → YYYYMMDD for Stedi. Returns null if unparseable. */
function dobToStedi(dob: string | undefined): string | null {
  if (!dob) return null;
  const trimmed = dob.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    return `${slash[3]}${slash[1].padStart(2, "0")}${slash[2].padStart(2, "0")}`;
  }
  return null;
}

/** Same input formats → MM/DD/YYYY for Athena POST /insurances. */
function dobToAthena(dob: string | undefined): string | undefined {
  if (!dob) return undefined;
  const trimmed = dob.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    return `${slash[1].padStart(2, "0")}/${slash[2].padStart(2, "0")}/${slash[3]}`;
  }
  return trimmed;
}

/**
 * Run the brand's Stedi payer IDs in order; return the first response that
 * carries no AAA error code, otherwise the last response we got. Network /
 * 5xx errors throw; 4xx responses are returned (Stedi returns AAA codes
 * inside a 200 body for "soft" rejections — those are not exceptions).
 */
/**
 * Brand-specific rendering provider override. Returns `undefined` to fall
 * back to the default org-level provider (HERSELF HEALTH MN PC, group NPI
 * 1326775420) for every brand except the ones that require an individual NPI
 * on the 270.
 *
 * MN Medicaid (DPWMN) is the only brand on the override path today: MHCP's
 * eligibility endpoint returns AAA*45 ("Invalid/Missing Provider Specialty")
 * against the org NPI, but accepts an individual rendering provider whose
 * NPI is enrolled with MHCP under a primary-care specialty. Verified
 * 2026-05-07 against two real MN Medicaid members; switching to Tracy
 * Kritz's NPI (1376614339, Family Medicine, Highland Park) flipped both
 * checks from AAA*45 to Active Coverage.
 *
 * Override via env if you need to rotate to a different MHCP-enrolled
 * provider (e.g. Tracy is on PTO, MHCP files keep getting out of sync, etc.):
 *   STEDI_MEDICAID_RENDERING_NPI=...
 *   STEDI_MEDICAID_RENDERING_FIRSTNAME=...
 *   STEDI_MEDICAID_RENDERING_LASTNAME=...
 */
function getRenderingProviderForBrand(
  brandId: string
): StediEligibilityProvider | undefined {
  if (brandId !== "medicaid-mn") return undefined;

  const npi = process.env.STEDI_MEDICAID_RENDERING_NPI ?? "1376614339";
  const firstName =
    process.env.STEDI_MEDICAID_RENDERING_FIRSTNAME ?? "Tracy";
  const lastName =
    process.env.STEDI_MEDICAID_RENDERING_LASTNAME ?? "Kritz";

  return { npi, firstName, lastName };
}

async function tryPayerIdsInOrder(
  payerIds: string[],
  subscriber: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    memberId: string;
    groupNumber?: string;
  },
  provider?: StediEligibilityProvider
): Promise<{ payerIdUsed: string; response: StediEligibilityResponse }> {
  let lastErr: unknown = null;
  let lastResponse: StediEligibilityResponse | null = null;
  let lastPayerId: string | null = null;

  async function tryAtIndex(index: number): Promise<{
    payerIdUsed: string;
    response: StediEligibilityResponse;
  } | null> {
    if (index >= payerIds.length) return null;
    const payerId = payerIds[index];
    try {
      const resp = await runEligibilityCheck({
        tradingPartnerServiceId: payerId,
        subscriber,
        provider,
      });
      lastResponse = resp;
      lastPayerId = payerId;
      const aaa = (resp.errors ?? []).map((e) => e.code);
      if (aaa.length === 0) {
        return { payerIdUsed: payerId, response: resp };
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof StediApiError && err.statusCode === 400) {
        return tryAtIndex(index + 1);
      }
      throw err;
    }
    return tryAtIndex(index + 1);
  }

  const success = await tryAtIndex(0);
  if (success) return success;

  if (lastResponse && lastPayerId) {
    return { payerIdUsed: lastPayerId, response: lastResponse };
  }
  throw lastErr ?? new Error("Stedi eligibility: no payer IDs responded");
}

async function runStediWithFallbacks(
  payerIds: string[],
  subscriber: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    memberId: string;
    groupNumber?: string;
  },
  provider?: StediEligibilityProvider
): Promise<{ payerIdUsed: string; response: StediEligibilityResponse }> {
  return tryPayerIdsInOrder(payerIds, subscriber, provider);
}

interface AttachResult {
  insuranceId: string;
  insuranceIdSynthesized: boolean;
  alreadyExisted: boolean;
}

const UNKNOWN_ELIGIBILITY: NormalizedEligibility = {
  coverageStatus: "unknown",
  payerName: null,
  payerEdiId: null,
  planName: null,
  groupNumber: null,
  groupName: null,
  planBeginDate: null,
  planEndDate: null,
  coveredThrough: null,
  activeServiceTypes: [],
  primaryInsuranceTypeCode: null,
  otherPayers: [],
  rejectionCodes: [],
};

const SOFT_FAIL_MESSAGE =
  "We couldn't finish setting up your insurance automatically. Our team " +
  "will reach out within one business day to verify your coverage and " +
  "finish booking your visit.";

/**
 * Soft-fail eligibility response. The wizard treats this as the END of
 * the registration flow: without an attached insurance package, Athena
 * rejects appointment creation. The Lead has already been (or is about
 * to be) created so back-office can pick up from there.
 *
 * Pass `endFlow: false` in extras only if the caller has separately
 * confirmed the patient's Athena record has a usable insurance row.
 */
function softEligibilityResponse(extras: Record<string, unknown> = {}) {
  return NextResponse.json({
    eligibility: UNKNOWN_ELIGIBILITY,
    soft: true,
    guidedHandoff: true,
    endFlow: true,
    message: SOFT_FAIL_MESSAGE,
    handoffMessage: SOFT_FAIL_MESSAGE,
    insurance: null,
    insuranceIdSynthesized: false,
    attachError: null,
    ...extras,
  });
}

async function attachInsuranceToAthena(params: {
  athenaPatientId: string;
  departmentId: number;
  insurancepackageid: number;
  insuranceidnumber: string;
  policynumber?: string;
  policyholderFirstName?: string;
  policyholderLastName?: string;
  policyholderDob?: string;
  policyholderSex?: string;
  relationshipId: number;
}): Promise<AttachResult> {
  const { effectiveId } = resolveAthenaInsurancePackageId(
    params.insurancepackageid
  );

  let alreadyExisted = false;
  let insurance: AthenaInsurance & { insuranceid?: string };
  try {
    insurance = (await addInsurance({
      patientId: params.athenaPatientId,
      departmentid: params.departmentId,
      insurancepackageid: effectiveId,
      insuranceidnumber: params.insuranceidnumber,
      policynumber: params.policynumber,
      insurancepolicyholderfirstname: params.policyholderFirstName,
      insurancepolicyholderlastname: params.policyholderLastName,
      insurancepolicyholderdob: params.policyholderDob,
      insurancepolicyholdersex: params.policyholderSex,
      relationshiptoinsuredid: params.relationshipId,
      sequencenumber: 1,
    })) as AthenaInsurance & { insuranceid?: string };
  } catch (err) {
    // Athena 409 ("existing insurance package") — recover via list, mirror
    // the behavior of /api/portal/register/insurance.
    if (
      err instanceof AthenaApiError &&
      err.statusCode === 409 &&
      /existing insurance package/i.test(err.responseBody || "")
    ) {
      alreadyExisted = true;
      insurance = {} as AthenaInsurance & { insuranceid?: string };
    } else {
      throw err;
    }
  }

  let insuranceId = insurance.insuranceid || "";
  if (!insuranceId) {
    try {
      const list = await getPatientInsurances(params.athenaPatientId);
      const matches = list
        .filter(
          (i) =>
            Number(i.insurancepackageid) === Number(effectiveId) &&
            !!i.insuranceid
        )
        .sort((a, b) =>
          String(b.insuranceid || "").localeCompare(
            String(a.insuranceid || "")
          )
        );
      if (matches[0]?.insuranceid) insuranceId = matches[0].insuranceid;
    } catch (err) {
      captureServerException(err, {
        tags: {
          portal_route: "register-eligibility",
          stage: "list-insurances-fallback",
        },
      });
    }
  }

  let insuranceIdSynthesized = false;
  if (!insuranceId) {
    insuranceId = `preview-${Date.now()}`;
    insuranceIdSynthesized = true;
  }

  return { insuranceId, insuranceIdSynthesized, alreadyExisted };
}

export async function POST(request: NextRequest) {
  return withPortalErrors("register-eligibility", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const body = await parseJsonBody<EligibilityPayload>(request);
    if (!body) {
      return portalError({
        status: 400,
        code: "INVALID_BODY",
        message: "We couldn't read your submission. Please try again.",
        retryable: false,
      });
    }

    // ── Stedi-driven combined flow ────────────────────────────────────
    if (isStediPayload(body)) {
      if (!isStediFlowEnabled()) {
        return portalError({
          status: 501,
          code: "STEDI_DISABLED",
          message:
            "Real-time eligibility verification is not enabled in this environment.",
          retryable: false,
        });
      }

      // ── Idempotency: a retried submit (double-click, network blip) returns
      // the prior response instead of running another paid Stedi call and
      // creating duplicate Athena insurance rows. Keyed on the (regToken,
      // brandId, memberId, dob, relationship) tuple. 5-minute window.
      const idemPayload = {
        athenaPatientId: session.athenaPatientId,
        brandId: body.brandId,
        memberId: (body.memberId || "").trim(),
        groupNumber: (body.groupNumber || "").trim(),
        relationshiptoinsuredid: body.relationshiptoinsuredid ?? 1,
        policyholderDob: body.policyholder?.dob,
      };
      const idemHit = await idempotencyGet<Record<string, unknown>>(
        "register-eligibility",
        idemPayload
      );
      if (idemHit) {
        return NextResponse.json({
          ...idemHit,
          fromIdempotencyCache: true,
        });
      }

      // Tighter rate limit on the Stedi path — each call costs real money.
      const rl = await rateLimit(request, {
        limit: 10,
        window: "1m",
        prefix: "portal-register-elig-stedi",
        failClosed: true,
      });
      if (!rl.success) {
        return portalError({
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          message:
            "You're submitting eligibility checks too quickly. Please wait a moment and try again.",
          retryable: true,
        });
      }

      const memberId = (body.memberId || "").trim();
      if (!body.brandId) {
        return portalError({
          status: 400,
          code: "BRAND_REQUIRED",
          message: "Please pick your insurance carrier before continuing.",
          retryable: false,
          fieldHints: { brandId: "Select your insurance carrier." },
        });
      }

      // Guided-handoff brands ("Other / Not sure" and any future card we
      // explicitly mark guidedHandoff) intentionally skip Stedi — there is no
      // payer to call. We still want a `portal_registration_followups` row so
      // back-office can verify coverage before the visit. memberId is optional
      // here because the patient may not know it yet.
      const brandMeta = getBrand(body.brandId);
      if (brandMeta?.guidedHandoff) {
        const followupId = await recordFollowup({
          step: "eligibility_check",
          outcome: "soft_failed",
          athenaPatientId: session.athenaPatientId,
          departmentId: session.departmentId,
          firstName: session.firstName,
          lastName: session.lastName,
          phone: session.phone,
          email: session.email,
          payload: {
            flow: "stedi",
            brandId: body.brandId,
            memberId: memberId || null,
            groupNumber: body.groupNumber,
            relationshiptoinsuredid: body.relationshiptoinsuredid,
            policyholder: body.policyholder,
            reason:
              "guided_handoff brand selected — no Stedi call, manual verification required",
          },
          errorCode: "GUIDED_HANDOFF",
        });
        await ensureLeadAtEligibility({
          session,
          primaryInsurance: brandMeta.displayName ?? null,
          eligibilityStatus: "Guided Handoff",
        });
        return NextResponse.json({
          eligibility: UNKNOWN_ELIGIBILITY,
          guidedHandoff: true,
          endFlow: true,
          followupId,
          brandId: body.brandId,
          message:
            "Thanks. Our team will reach out within one business day to verify your insurance and finish booking your visit.",
          handoffMessage:
            "Thanks. Our team will reach out within one business day to verify your insurance and finish booking your visit.",
        });
      }

      if (!memberId) {
        return portalError({
          status: 400,
          code: "MEMBER_ID_REQUIRED",
          message: "Please enter your Member ID before checking eligibility.",
          retryable: false,
          fieldHints: { memberId: "Member ID is required." },
        });
      }

      // Pending patient (Athena create soft-failed earlier in the wizard)
      // — we can't run a real eligibility check (no patient to attach to)
      // and the back-office queue already has the registration row. Drop
      // a follow-on row tying the insurance details to the same pending
      // patient and return a soft success so the wizard advances.
      if (isPendingPatientId(session.athenaPatientId)) {
        const followupId = await recordFollowup({
          step: "eligibility_check",
          severity: "soft",
          athenaPatientId: session.athenaPatientId,
          departmentId: session.departmentId,
          firstName: session.firstName,
          lastName: session.lastName,
          phone: session.phone,
          email: session.email,
          payload: {
            brandId: body.brandId,
            memberId,
            groupNumber: body.groupNumber,
            relationshiptoinsuredid: body.relationshiptoinsuredid,
            policyholder: body.policyholder,
            reason: "patient_create soft-failed earlier — pending Athena id",
          },
          errorCode: "PENDING_PATIENT",
        });
        return softEligibilityResponse({
          followupId,
          brandId: body.brandId,
          pending: true,
        });
      }

      const resolved = resolveBrandForStedi(body.brandId);
      if (!resolved) {
        // "Other / not sure" or unknown brandId — surface a guided handoff
        // signal so the wizard can route to manual verification. Capture
        // it as a soft fail so back-office reaches out about coverage.
        const followupId = await recordFollowup({
          step: "eligibility_check",
          outcome: "soft_failed",
          athenaPatientId: session.athenaPatientId,
          departmentId: session.departmentId,
          firstName: session.firstName,
          lastName: session.lastName,
          phone: session.phone,
          email: session.email,
          payload: {
            flow: "stedi",
            brandId: body.brandId,
            memberId,
            groupNumber: body.groupNumber,
            relationshiptoinsuredid: body.relationshiptoinsuredid,
            policyholder: body.policyholder,
            reason: "brand could not be resolved (Other / Not sure)",
          },
          errorCode: "BRAND_UNRESOLVED",
        });
        await ensureLeadAtEligibility({
          session,
          primaryInsurance: getBrand(body.brandId)?.displayName ?? null,
          eligibilityStatus: "Guided Handoff",
        });
        return NextResponse.json({
          eligibility: UNKNOWN_ELIGIBILITY,
          guidedHandoff: true,
          endFlow: true,
          followupId,
          message:
            "Thanks. Our team will reach out within one business day to verify your insurance and finish booking your visit.",
          handoffMessage:
            "Thanks. Our team will reach out within one business day to verify your insurance and finish booking your visit.",
        });
      }

      const relationshipId = body.relationshiptoinsuredid ?? 1;

      // Subscriber demographics for the 270. For Self (the dominant case)
      // pull from the Athena patient record we already created. For non-Self
      // require the client to supply policyholder fields.
      let firstName: string | undefined = body.policyholder?.firstName;
      let lastName: string | undefined = body.policyholder?.lastName;
      let dobIso: string | undefined = body.policyholder?.dob;
      let sex: string | undefined;

      if (relationshipId === 1) {
        try {
          const patient = await getPatient(session.athenaPatientId);
          firstName = firstName || patient.firstname;
          lastName = lastName || patient.lastname;
          dobIso = dobIso || patient.dob;
          sex = patient.sex || undefined;
        } catch (err) {
          captureServerException(err, {
            tags: {
              portal_route: "register-eligibility",
              stage: "hydrate-patient",
            },
          });
        }
      }

      const dobStedi = dobToStedi(dobIso);
      if (!firstName || !lastName || !dobStedi) {
        return portalError({
          status: 400,
          code: "SUBSCRIBER_INCOMPLETE",
          message:
            "We need the policyholder's first name, last name, and date of birth to verify coverage.",
          retryable: false,
          fieldHints: {
            "policyholder.firstName": !firstName ? "Required" : "",
            "policyholder.lastName": !lastName ? "Required" : "",
            "policyholder.dob": !dobStedi ? "Enter MM/DD/YYYY" : "",
          },
        });
      }

      // ── 270/271 round-trip ─────────────────────────────────────────
      let payerIdUsed: string;
      let stediResp: StediEligibilityResponse;
      try {
        const result = await runStediWithFallbacks(
          resolved.stediPayerIds,
          {
            firstName,
            lastName,
            dateOfBirth: dobStedi,
            memberId,
            groupNumber: body.groupNumber || undefined,
          },
          getRenderingProviderForBrand(body.brandId)
        );
        payerIdUsed = result.payerIdUsed;
        stediResp = result.response;
      } catch (err) {
        // Soft-fail: Stedi outage / bad payer / network blip should never
        // block the wizard. Log + record a followup row so back-office can
        // re-run the check (or call the patient) before the visit.
        const sentryEventId = captureServerException(err, {
          tags: {
            portal_route: "register-eligibility",
            stage: "stedi-270",
            brand_id: body.brandId,
          },
        });
        const followupId = await recordFollowup({
          step: "eligibility_check",
          severity: "soft",
          athenaPatientId: session.athenaPatientId,
          departmentId: session.departmentId,
          firstName: session.firstName,
          lastName: session.lastName,
          phone: session.phone,
          email: session.email,
          payload: {
            brandId: body.brandId,
            memberId,
            groupNumber: body.groupNumber,
            relationshiptoinsuredid: body.relationshiptoinsuredid,
            policyholder: body.policyholder,
            stediStatusCode:
              err instanceof StediApiError ? err.statusCode : null,
          },
          error: err,
          errorCode:
            err instanceof StediApiError
              ? `STEDI_${err.statusCode}`
              : "STEDI_REQUEST_FAILED",
          sentryEventId,
        });
        await ensureLeadAtEligibility({
          session,
          primaryInsurance: getBrand(body.brandId)?.displayName ?? null,
          eligibilityStatus: "Indeterminate",
        });
        return softEligibilityResponse({
          followupId,
          brandId: body.brandId,
        });
      }

      let summary = summarizeEligibility(stediResp);

      // ── Medicare disambiguation: if CMS came back active with an MA
      // carrier in Loop 2120C Other Payer, retry exactly once against the
      // MA carrier's Stedi payer ID. Cap at 1 retry per the plan.
      if (
        body.brandId === "medicare" &&
        summary.coverageStatus === "active" &&
        summary.otherPayers.length > 0
      ) {
        const otherName = summary.otherPayers.find((op) => op.name)?.name ?? null;
        const retryBrand = pickRetryBrandFromOtherPayer(otherName);
        if (retryBrand && retryBrand.brandId !== body.brandId) {
          try {
            const retry = await runEligibilityCheck({
              tradingPartnerServiceId: retryBrand.defaultStediPayerId,
              subscriber: {
                firstName,
                lastName,
                dateOfBirth: dobStedi,
                memberId,
              },
            });
            const retrySummary = summarizeEligibility(retry);
            if (retrySummary.coverageStatus === "active") {
              summary = retrySummary;
              payerIdUsed = retryBrand.defaultStediPayerId;
              // Override the brand for the reverse resolver so we land on
              // the MA-carrier-specific Athena package, not the FFS one.
              const maResolved = resolveBrandForStedi(retryBrand.brandId);
              if (maResolved) {
                resolved.brand = maResolved.brand;
              }
            }
          } catch (err) {
            captureServerException(err, {
              tags: {
                portal_route: "register-eligibility",
                stage: "stedi-medicare-retry",
              },
            });
          }
        }
      }

      // ── Reverse resolve to Athena package ──────────────────────────
      const pkg = await resolvePackageFromEligibility(resolved.brand, summary);
      if (
        pkg.confidence === "fallback" ||
        pkg.confidence === "unresolved" ||
        pkg.lowConfidence
      ) {
        Sentry.addBreadcrumb({
          category: "portal.eligibility",
          level: "warning",
          message: "Reverse package resolver low-confidence match",
          data: {
            brandId: body.brandId,
            payerIdUsed,
            confidence: pkg.confidence,
            lowConfidence: pkg.lowConfidence,
            reason: pkg.reason,
          },
        });
      }

      // Build the patient-facing view-model server-side. The UI must read
      // from this — never from raw `pkg.insurancePackageId` or the
      // X12-shaped `summary` — so internal IDs / EDI codes never reach the
      // DOM. See src/lib/portal/plan-display.ts.
      const planDisplay = toPlanDisplay({
        brandDisplayName: resolved.brand.displayName,
        resolver: pkg,
        planNameFrom271: summary.planName,
        coverageStatus: summary.coverageStatus,
      });

      // ── Attach to Athena (best-effort: AAA / inactive still attach
      //    so the wizard advances and back-office can verify later) ────
      let insuranceAttach: AttachResult | null = null;
      let attachError: string | null = null;
      if (pkg.insurancePackageId) {
        try {
          insuranceAttach = await attachInsuranceToAthena({
            athenaPatientId: session.athenaPatientId,
            departmentId: session.departmentId,
            insurancepackageid: pkg.insurancePackageId,
            insuranceidnumber: memberId,
            policynumber: body.groupNumber || summary.groupNumber || undefined,
            policyholderFirstName: firstName,
            policyholderLastName: lastName,
            policyholderDob: dobToAthena(dobIso),
            policyholderSex: sex,
            relationshipId,
          });
        } catch (err) {
          // Soft-fail: the 270 succeeded (we have real coverage data to
          // show the patient) but Athena rejected the attach. Wizard
          // still shows the eligibility result; back-office reconciles
          // the attach from this row.
          const sentryEventId = captureServerException(err, {
            tags: {
              portal_route: "register-eligibility",
              stage: "athena-attach",
              brand_id: body.brandId,
            },
          });
          await recordFollowup({
            step: "insurance_attach",
            severity: "soft",
            athenaPatientId: session.athenaPatientId,
            departmentId: session.departmentId,
            firstName: session.firstName,
            lastName: session.lastName,
            phone: session.phone,
            email: session.email,
            payload: {
              brandId: body.brandId,
              memberId,
              groupNumber: body.groupNumber,
              insurancepackageid: pkg.insurancePackageId,
              insuranceplanname: pkg.insurancePlanName,
              relationshipId,
              athenaStatus:
                err instanceof AthenaApiError ? err.statusCode : null,
              athenaResponseBody:
                err instanceof AthenaApiError
                  ? (err.responseBody || "").slice(0, 500)
                  : undefined,
            },
            error: err,
            errorCode:
              err instanceof AthenaApiError
                ? `ATHENA_${err.statusCode}`
                : "ATHENA_INSURANCE_ADD",
            sentryEventId,
          });
          attachError =
            err instanceof Error
              ? err.message.slice(0, 200)
              : "Unknown error attaching insurance";
        }
      }

      const rejectionMessage = explainRejection(summary.rejectionCodes);

      // Audit row — every Stedi eligibility check (including AAA/inactive
      // results, which are valid responses) gets captured to Supabase so
      // back-office has the full eligibility history per patient. Soft-
      // failures (Stedi outage, attach 5xx) wrote their own rows above.
      const sfStatus: SfEligibilityStatus =
        summary.coverageStatus === "active"
          ? "Active"
          : summary.coverageStatus === "inactive"
            ? "Inactive"
            : "Indeterminate";
      const resolvedInsuranceName =
        pkg.insurancePlanName ||
        summary.payerName ||
        resolved.brand.displayName ||
        null;
      const sfLeadId = await ensureLeadAtEligibility({
        session,
        primaryInsurance: resolvedInsuranceName,
        eligibilityStatus: sfStatus,
      });

      // If we couldn't attach a real insurance package to Athena (no
      // package id, attach errored, or the brand was a guided-handoff),
      // booking won't be possible — Athena rejects appointment creation
      // without a usable insurance row. End the flow here with a friendly
      // handoff message; the Lead has already been created so back-office
      // can pick it up.
      const insuranceUsable =
        !!insuranceAttach && !attachError && !!pkg.insurancePackageId;
      const endFlow = !insuranceUsable;

      await recordFollowup({
        step: "eligibility_check",
        outcome: "success",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          flow: "stedi",
          brandId: body.brandId,
          memberId,
          groupNumber: body.groupNumber,
          relationshiptoinsuredid: body.relationshiptoinsuredid,
          policyholder: body.policyholder,
        },
        result: {
          stediPayerIdUsed: payerIdUsed,
          coverageStatus: summary.coverageStatus,
          payerName: summary.payerName,
          planName: summary.planName,
          groupNumber: summary.groupNumber,
          coveredThrough: summary.coveredThrough,
          rejectionCodes: summary.rejectionCodes,
          insurancepackageid: pkg.insurancePackageId,
          insuranceplanname: pkg.insurancePlanName,
          resolvedInsuranceName,
          isGovernmentFunded: pkg.isGovernmentFunded,
          confidence: pkg.confidence,
          insurance: insuranceAttach
            ? {
              insuranceid: insuranceAttach.insuranceId,
              alreadyExisted: insuranceAttach.alreadyExisted,
              insuranceIdSynthesized: insuranceAttach.insuranceIdSynthesized,
            }
            : null,
          attachError,
          endFlow,
          salesforce: {
            accountId: session.salesforceAccountId ?? null,
            leadId: sfLeadId ?? null,
            eligibilityStatus: sfStatus,
            primaryInsurance: resolvedInsuranceName,
          },
        },
        // Tag the row when the attach soft-failed mid-flow so the queue
        // surfaces it even though we returned the eligibility cleanly.
        errorCode: attachError ? "ATHENA_ATTACH_DEGRADED" : null,
      });

      const responseBody = {
        eligibility: summary,
        rejectionMessage,
        brandId: body.brandId,
        stediPayerIdUsed: payerIdUsed,
        insurancepackageid: pkg.insurancePackageId,
        insuranceplanname: pkg.insurancePlanName,
        isGovernmentFunded: pkg.isGovernmentFunded,
        confidence: pkg.confidence,
        lowConfidence: pkg.lowConfidence,
        // Typed view-model for the UI; safe to render directly.
        planDisplay,
        insurance: insuranceAttach
          ? {
            insuranceid: insuranceAttach.insuranceId,
            alreadyExisted: insuranceAttach.alreadyExisted,
          }
          : null,
        insuranceIdSynthesized:
          insuranceAttach?.insuranceIdSynthesized ?? false,
        attachError,
        // When true, the wizard ends here (no scheduling step). Athena
        // rejects appointment creation without an attached insurance
        // package, so we surface a "we'll be in touch" handoff instead.
        // The Lead has already been created so back-office can follow up.
        endFlow,
        handoffMessage: endFlow
          ? "We couldn't finish setting up your insurance automatically. Our team will reach out within one business day to verify your coverage and finish booking your visit."
          : null,
      };

      await idempotencySet(
        "register-eligibility",
        idemPayload,
        responseBody,
        300
      );

      // Background Medicare AWV enrichment. Only fires when:
      //   ENABLE_MEDICARE_AWV_LOOKUP=1 AND brand ∈ {medicare, MA carriers}.
      // Runs after the response is sent (next/server `after`) so the user
      // never waits on the ~5-7s chain (MBI Lookup → CMS BZ → SF stamps).
      // All errors are swallowed inside runAwvEnrichment.
      if (isAwvLookupEnabled() && isAwvEligibleBrand(body.brandId)) {
        const awvArgs = {
          brandId: body.brandId,
          knownMbi: body.brandId === "medicare" ? memberId : null,
          patient: {
            firstName,
            lastName,
            dateOfBirth: dobStedi,
            // Herself Health is MN-only today. If/when we expand outside MN
            // this should come from the patient's address on the token.
            state: "MN",
          },
          salesforceLeadId: sfLeadId ?? null,
          salesforceAccountId: session.salesforceAccountId ?? null,
        };
        after(async () => {
          try {
            await runAwvEnrichment(awvArgs);
          } catch (err) {
            // Defense in depth — runAwvEnrichment is supposed to swallow.
            captureServerException(err, {
              tags: {
                portal_route: "register-eligibility",
                step: "awv-after-callback",
                severity: "non_fatal",
              },
            });
          }
        });
      }

      try {
        const distinctId = await hashToOpaqueDistinctId(session.athenaPatientId);
        await captureServerEvent(distinctId, "insurance_verified_server", {
          eligibility_status: sfStatus,
          coverage_status: summary.coverageStatus ?? null,
          brand_id: body.brandId,
          insurance_package_id: pkg.insurancePackageId ?? null,
          is_government_funded: pkg.isGovernmentFunded ?? null,
          end_flow: endFlow,
          flow: "stedi",
        });
        await captureServerEvent(distinctId, "onboarding_step_completed", {
          step: "insurance_verified",
          eligibility_status: sfStatus,
          flow: "register",
        });
      } catch {
        // analytics never blocks the response
      }

      return NextResponse.json(responseBody);
    }

    // ── Legacy {insuranceId} flow ─────────────────────────────────────
    if (!body.insuranceId) {
      return portalError({
        status: 400,
        code: "INSURANCE_ID_REQUIRED",
        message: "We're missing the insurance package on this request.",
        retryable: false,
      });
    }

    if (shouldMockEligibility()) {
      const mockEligibility = {
        eligibilitystatus: "Eligible (mocked – preview env)",
        eligibilityreason: "Synthetic response: VERCEL_ENV !== production",
        mocked: true,
        mockedAt: new Date().toISOString(),
        insuranceid: body.insuranceId,
        dateofservice:
          body.dateOfService || new Date().toISOString().slice(0, 10),
      };
      const mockPlanName = await fetchInsurancePlanName(
        session.athenaPatientId,
        body.insuranceId,
      );
      const mockLeadId = await ensureLeadAtEligibility({
        session,
        primaryInsurance: mockPlanName,
        eligibilityStatus: "Active",
      });
      await recordFollowup({
        step: "eligibility_check",
        outcome: "success",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          flow: "legacy-mock",
          insuranceId: body.insuranceId,
          dateOfService: body.dateOfService,
        },
        result: {
          ...mockEligibility,
          resolvedInsuranceName: mockPlanName,
          salesforce: {
            accountId: session.salesforceAccountId ?? null,
            leadId: mockLeadId ?? null,
            eligibilityStatus: "Active",
            primaryInsurance: mockPlanName,
          },
        },
      });
      return NextResponse.json({ eligibility: mockEligibility });
    }

    if (isPendingPatientId(session.athenaPatientId)) {
      const followupId = await recordFollowup({
        step: "eligibility_check",
        severity: "soft",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          flow: "legacy",
          insuranceId: body.insuranceId,
          dateOfService: body.dateOfService,
          reason: "patient_create soft-failed earlier — pending Athena id",
        },
        errorCode: "PENDING_PATIENT",
      });
      return softEligibilityResponse({ followupId });
    }

    try {
      const eligibility = await triggerEligibilityCheck(
        session.athenaPatientId,
        body.insuranceId,
        body.dateOfService
      );
      const legacyPlanName = await fetchInsurancePlanName(
        session.athenaPatientId,
        body.insuranceId,
      );
      const legacyLeadId = await ensureLeadAtEligibility({
        session,
        primaryInsurance: legacyPlanName,
        eligibilityStatus: "Active",
      });
      await recordFollowup({
        step: "eligibility_check",
        outcome: "success",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          flow: "legacy",
          insuranceId: body.insuranceId,
          dateOfService: body.dateOfService,
        },
        result: {
          eligibility,
          resolvedInsuranceName: legacyPlanName,
          salesforce: {
            accountId: session.salesforceAccountId ?? null,
            leadId: legacyLeadId ?? null,
            eligibilityStatus: "Active",
            primaryInsurance: legacyPlanName,
          },
        },
      });
      return NextResponse.json({ eligibility });
    } catch (err) {
      const sentryEventId = captureServerException(err, {
        tags: { portal_route: "register-eligibility" },
      });
      const followupId = await recordFollowup({
        step: "eligibility_check",
        severity: "soft",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          flow: "legacy",
          insuranceId: body.insuranceId,
          dateOfService: body.dateOfService,
          athenaStatus: err instanceof AthenaApiError ? err.statusCode : null,
        },
        error: err,
        errorCode:
          err instanceof AthenaApiError
            ? `ATHENA_${err.statusCode}`
            : "ATHENA_ELIGIBILITY",
        sentryEventId,
      });
      return softEligibilityResponse({ followupId });
    }
  });
}
