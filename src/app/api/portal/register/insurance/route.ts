/**
 * POST /api/portal/register/insurance
 *
 * Add an insurance package to the in-progress registrant's Athena patient
 * record. Authenticated by a regToken (no Clerk required).
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";
import {
  AthenaApiError,
  addInsurance,
  getPatient,
  getPatientInsurances,
  type AthenaInsurance,
} from "@/lib/athena/client";
import {
  requireRegistrationToken,
  isVerifiedRegistration,
} from "@/lib/auth/registration-session";
import {
  withPortalErrors,
  parseJsonBody,
} from "@/lib/portal/api";
import { resolveAthenaInsurancePackageId } from "@/lib/portal/insurance-packages";
import { recordFollowup, isPendingPatientId } from "@/lib/portal/followup";
import { captureServerEvent } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";

/**
 * Normalize a date string to Athena's required MM/DD/YYYY.
 *
 * Accepts:
 *   - "1985-01-15"   (ISO, what the wizard / E2E send)
 *   - "01/15/1985"   (already-Athena format)
 *   - "1/15/1985"    (sloppy hand-typed)
 * Returns the string as-is if it doesn't look like a date we recognize, so
 * Athena's own validator gives the user a meaningful error rather than us
 * silently corrupting input.
 */
function normalizeDobForAthena(dob: string | undefined): string | undefined {
  if (!dob) return undefined;
  const trimmed = dob.trim();
  // ISO YYYY-MM-DD (what the wizard / E2E send)
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  // Already MM/DD/YYYY (or sloppy single-digit variants — pad them)
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    return `${slash[1].padStart(2, "0")}/${slash[2].padStart(2, "0")}/${slash[3]}`;
  }
  return trimmed;
}

interface AddInsurancePayload {
  insurancepackageid: number;
  insuranceidnumber?: string;
  policynumber?: string;
  insurancepolicyholderfirstname?: string;
  insurancepolicyholderlastname?: string;
  insurancepolicyholderdob?: string;
  relationshiptoinsuredid?: number;
  sequencenumber?: number;
}

export async function POST(request: NextRequest) {
  return withPortalErrors("register-insurance", async () => {
    const session = await requireRegistrationToken(request);
    if (!isVerifiedRegistration(session)) return session;

    const body = await parseJsonBody<AddInsurancePayload>(request);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }
    if (!body.insurancepackageid) {
      return NextResponse.json(
        { error: "insurancepackageid is required" },
        { status: 400 }
      );
    }

    // Pending patient (Athena create soft-failed earlier in the wizard) —
    // we have nowhere to attach the insurance. Drop a followup row tying
    // the insurance details to the same pending Athena id so back-office
    // reconciles both at once, and return a soft success so the wizard
    // advances cleanly.
    if (isPendingPatientId(session.athenaPatientId)) {
      const followupId = await recordFollowup({
        step: "insurance_attach",
        severity: "soft",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          insurancepackageid: body.insurancepackageid,
          insuranceidnumber: body.insuranceidnumber,
          policynumber: body.policynumber,
          insurancepolicyholderfirstname: body.insurancepolicyholderfirstname,
          insurancepolicyholderlastname: body.insurancepolicyholderlastname,
          insurancepolicyholderdob: body.insurancepolicyholderdob,
          relationshiptoinsuredid: body.relationshiptoinsuredid,
          sequencenumber: body.sequencenumber,
          reason: "patient_create soft-failed earlier — pending Athena id",
        },
        errorCode: "PENDING_PATIENT",
      });
      return NextResponse.json({
        insurance: { insuranceid: `pending-${followupId ?? Date.now()}` },
        insuranceIdSynthesized: true,
        alreadyExisted: false,
        soft: true,
        pending: true,
        followupId,
        message:
          "We have your insurance details — our team will verify and attach " +
          "them before your visit.",
      });
    }

    // Preview-environment remap: the MDM-sourced id the client sent is a
    // production Athena id and won't resolve against Athena's preview
    // registry. resolveAthenaInsurancePackageId() substitutes a known-good
    // BCBS-MN stand-in (id 1132) in preview only; in production this is a
    // pass-through.
    const { effectiveId, remapped, reason } = resolveAthenaInsurancePackageId(
      body.insurancepackageid
    );
    if (remapped) {
      Sentry.addBreadcrumb({
        category: "portal.insurance",
        message: "Remapped insurance package id for preview environment",
        level: "info",
        data: {
          requested: body.insurancepackageid,
          effective: effectiveId,
          reason,
        },
      });
    }

    // Athena requires policyholder demographics on POST insurances and
    // rejects any DOB that isn't strict MM/DD/YYYY (the wizard sends ISO
    // YYYY-MM-DD; the E2E script does too). Mirror the midi flow's
    // to_insurance_payload contract:
    //   - normalize whatever DOB the client sent to MM/DD/YYYY
    //   - when relationship is Self (1) and the client didn't fill the
    //     subscriber fields, hydrate them from the patient record we just
    //     created. The regToken intentionally omits raw DOB/sex (PHI), so
    //     this is the cheapest authoritative source.
    // Athena's POST /patients/{id}/insurances enforces (for non self-pay):
    //   "an insurance ID number, first and last name and sex of insured are
    //   required."
    // So firstname / lastname / dob / SEX must all be present. The wizard's
    // policyholder fields are optional from the user's perspective (they
    // typically only fill in member id when picking "Self"), so we
    // unconditionally hydrate any missing field from the Athena patient
    // record whenever the relationship is Self. Mirrors the midi flow's
    // to_insurance_payload contract.
    const relationshipId = body.relationshiptoinsuredid ?? 1; // default Self
    let policyholderFirstName = body.insurancepolicyholderfirstname;
    let policyholderLastName = body.insurancepolicyholderlastname;
    let policyholderDob = normalizeDobForAthena(body.insurancepolicyholderdob);
    let policyholderSex: string | undefined;
    let policyholderHydrated = false;

    if (relationshipId === 1) {
      try {
        const patient = await getPatient(session.athenaPatientId);
        policyholderFirstName = policyholderFirstName || patient.firstname;
        policyholderLastName = policyholderLastName || patient.lastname;
        // Athena returns dob in MM/DD/YYYY already, but normalize defensively
        // in case a future change starts handing back ISO.
        policyholderDob =
          policyholderDob || normalizeDobForAthena(patient.dob);
        // Athena requires this on non self-pay add — patient.sex is the
        // canonical answer (the regToken intentionally doesn't carry it).
        policyholderSex = patient.sex || undefined;
        policyholderHydrated = true;
      } catch (err) {
        // Don't 500 here — Athena will surface a clearer error than we can.
        captureServerException(err, {
          tags: {
            portal_route: "register-insurance",
            stage: "hydrate-policyholder",
          },
        });
      }
    }

    let alreadyExisted = false;
    try {
      let insurance: AthenaInsurance & { insuranceid?: string };
      try {
        insurance = (await addInsurance({
          patientId: session.athenaPatientId,
          // departmentid is required by Athena on POST /patients/{id}/insurances.
          // Carried on the regToken from the initial /api/portal/register/patient
          // call so we don't have to trust a client-supplied value here.
          departmentid: session.departmentId,
          insurancepackageid: effectiveId,
          insuranceidnumber: body.insuranceidnumber,
          policynumber: body.policynumber,
          insurancepolicyholderfirstname: policyholderFirstName,
          insurancepolicyholderlastname: policyholderLastName,
          insurancepolicyholderdob: policyholderDob,
          insurancepolicyholdersex: policyholderSex,
          relationshiptoinsuredid: relationshipId,
          sequencenumber: body.sequencenumber ?? 1,
        })) as AthenaInsurance & { insuranceid?: string };
      } catch (err) {
        // Athena returns 409 ("An existing insurance package exists. Use PUT
        // to update or DELETE to deactivate.") when the patient already has
        // this package on record. Common in preview, where every requested
        // package is remapped to the same BCBS-MN stand-in (1132): a refresh,
        // a back-button, or a prior wizard run on the same patient all hit
        // this. Treat it as a no-op success — fetch the existing row, return
        // it to the client, and let the eligibility step continue.
        if (
          err instanceof AthenaApiError &&
          err.statusCode === 409 &&
          /existing insurance package/i.test(err.responseBody || "")
        ) {
          alreadyExisted = true;
          Sentry.addBreadcrumb({
            category: "portal.insurance",
            message:
              "Athena 409: insurance package already on patient; reusing existing row",
            level: "info",
            data: {
              athenaPatientId: session.athenaPatientId,
              insurancepackageidRequested: body.insurancepackageid,
              insurancepackageidEffective: effectiveId,
            },
          });
          insurance = {} as AthenaInsurance & { insuranceid?: string };
        } else {
          throw err;
        }
      }

      // Athena's preview tenant frequently returns the inserted insurance row
      // without an `insuranceid` field (the post-insert payload is incomplete
      // — production behaves correctly). Recover by listing the patient's
      // insurances and matching by package id, picking the most-recently-
      // inserted one. This also defends against any future change to the POST
      // response shape.
      let resolvedInsurance: (AthenaInsurance & { insuranceid?: string }) =
        insurance;
      let insuranceIdSynthesized = false;

      if (!resolvedInsurance.insuranceid) {
        try {
          const list = await getPatientInsurances(session.athenaPatientId);
          // Most recent matching package wins. Athena lists newest first in
          // practice; sort defensively in case that ever flips.
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
          if (matches[0]) {
            resolvedInsurance = { ...resolvedInsurance, ...matches[0] };
          }
        } catch (err) {
          captureServerException(err, {
            tags: {
              portal_route: "register-insurance",
              stage: "list-insurances-fallback",
            },
          });
        }
      }

      // If Athena (or our fallback list) still hasn't given us an id — only
      // realistic in preview/sandbox — synthesize a stable placeholder so the
      // wizard advances. The eligibility step is mocked in non-prod anyway,
      // and we tag it so downstream code (and Sentry) can tell it apart.
      if (!resolvedInsurance.insuranceid) {
        resolvedInsurance = {
          ...resolvedInsurance,
          insuranceid: `preview-${Date.now()}`,
        };
        insuranceIdSynthesized = true;
        captureServerMessage(
          "Athena POST /insurances returned no insuranceid; synthesized placeholder",
          {
            level: "warning",
            tags: {
              portal_route: "register-insurance",
              athena_env: (process.env.ATHENA_BASE_URL || "")
                .toLowerCase()
                .includes("preview")
                ? "preview"
                : "production",
            },
            extra: {
              athenaPatientId: session.athenaPatientId,
              insurancepackageidRequested: body.insurancepackageid,
              insurancepackageidEffective: effectiveId,
            },
          }
        );
      }

      // Audit row — capture every successful attach so Supabase is a
      // complete backup of record, including the Athena insurance id we
      // got back. Back-office can replay from `result` if Athena ever
      // loses the row.
      await recordFollowup({
        step: "insurance_attach",
        outcome: "success",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          insurancepackageidRequested: body.insurancepackageid,
          insurancepackageidEffective: effectiveId,
          insuranceidnumber: body.insuranceidnumber,
          policynumber: body.policynumber,
          insurancepolicyholderfirstname: policyholderFirstName,
          insurancepolicyholderlastname: policyholderLastName,
          insurancepolicyholderdob: policyholderDob,
          relationshiptoinsuredid: relationshipId,
          sequencenumber: body.sequencenumber ?? 1,
          policyholderHydrated,
        },
        result: {
          insuranceid: resolvedInsurance.insuranceid,
          insuranceplanname: resolvedInsurance.insuranceplanname ?? null,
          insurancepackageid: resolvedInsurance.insurancepackageid ?? effectiveId,
          insuranceIdSynthesized,
          alreadyExisted,
        },
        errorCode: insuranceIdSynthesized ? "ATHENA_INSURANCEID_SYNTH" : null,
      });

      try {
        const distinctId = await hashToOpaqueDistinctId(session.athenaPatientId);
        await captureServerEvent(distinctId, "insurance_submitted_server", {
          insurance_package_id: effectiveId,
          relationship_to_insured_id: relationshipId,
          already_existed: alreadyExisted,
          insurance_id_synthesized: insuranceIdSynthesized,
          flow: "register",
        });
        await captureServerEvent(distinctId, "onboarding_step_completed", {
          step: "insurance_submitted",
          flow: "register",
        });
      } catch {
        // analytics never blocks the response
      }

      return NextResponse.json({
        insurance: resolvedInsurance,
        insuranceIdSynthesized,
        alreadyExisted,
        // Surface diagnostic context to non-prod clients so the E2E script +
        // eng smoke-tests can assert on it. Zero-cost in prod.
        ...(process.env.VERCEL_ENV !== "production"
          ? {
            _debug: {
              insurancePackageIdRequested: body.insurancepackageid,
              insurancePackageIdEffective: effectiveId,
              remapReason: reason,
              policyholderHydrated,
              insuranceIdSynthesized,
              alreadyExisted,
            },
          }
          : {}),
      });
    } catch (err) {
      // Soft-fail: every other Athena attach error (4xx field issue, 5xx
      // outage, anything we didn't already handle as a 409 above) is
      // logged + queued for back-office and the wizard advances. The
      // patient never sees a registration failure on this step — we'll
      // call them before their visit if we couldn't reconcile.
      const sentryEventId = captureServerException(err, {
        tags: { portal_route: "register-insurance" },
      });
      const followupId = await recordFollowup({
        step: "insurance_attach",
        severity: "soft",
        athenaPatientId: session.athenaPatientId,
        departmentId: session.departmentId,
        firstName: session.firstName,
        lastName: session.lastName,
        phone: session.phone,
        email: session.email,
        payload: {
          insurancepackageidRequested: body.insurancepackageid,
          insurancepackageidEffective: effectiveId,
          insuranceidnumber: body.insuranceidnumber,
          policynumber: body.policynumber,
          insurancepolicyholderfirstname: policyholderFirstName,
          insurancepolicyholderlastname: policyholderLastName,
          insurancepolicyholderdob: policyholderDob,
          relationshiptoinsuredid: relationshipId,
          sequencenumber: body.sequencenumber ?? 1,
          athenaStatus: err instanceof AthenaApiError ? err.statusCode : null,
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
      return NextResponse.json({
        insurance: { insuranceid: `pending-${followupId ?? Date.now()}` },
        insuranceIdSynthesized: true,
        alreadyExisted: false,
        soft: true,
        followupId,
        message:
          "We have your insurance details — our team will verify and attach " +
          "them before your visit.",
      });
    }
  });
}
