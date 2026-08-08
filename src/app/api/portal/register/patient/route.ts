/**
 * POST /api/portal/register/patient
 *
 * Unauthenticated registration entry point. Creates an Athena patient (and a
 * Hint patient skeleton) for a brand-new prospective member, then mints a
 * short-lived regToken so the client can complete the rest of the wizard
 * (insurance → eligibility → membership → schedule) without a Clerk account.
 *
 * Resiliency:
 *   - IP rate-limit (10/h/IP).
 *   - Idempotency cache (5 min) keyed by name+dob+phone+department so a
 *     double-clicked Continue button doesn't create two Athena records.
 *   - Duplicate detection via Athena enhancedBestMatch — if a strong match
 *     exists we *do not* leak the patient id; we tell the user to sign in.
 *   - All failures captured in Sentry via withPortalErrors.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/capture-exception";
import {
  AthenaApiError,
  enhancedBestMatch,
  createPatient,
  setPrivacyInformationVerified,
  setAllInterfaceConsentsYes,
} from "@/lib/athena/client";
import {
  HintApiError,
  createPatient as createHintPatient,
} from "@/lib/hint/client";
import { mintRegistrationToken, hashDob } from "@/lib/auth/registration-token";
import {
  withPortalErrors,
  parseJsonBody,
  idempotencyGet,
  idempotencySet,
} from "@/lib/portal/api";
import { recordFollowup, mintPendingPatientId } from "@/lib/portal/followup";
import { getPortalFeatureFlags } from "@/lib/portal/feature-flags";
import { createPassiveClerkUser } from "@/lib/identity/passive-clerk";
import { SalesforceClient } from "@/lib/salesforce/client";
import { createRecordTolerant } from "@/lib/salesforce/field-tolerant";
import { captureServerEvent, identifyServerPerson } from "@/lib/posthog/server";
import { hashToOpaqueDistinctId } from "@/lib/posthog/sanitize";
import { mapReferralSourceToSf } from "@/lib/salesforce/referral-source";
import { normalizeLeadSource } from "@/lib/salesforce/normalize-lead-source";

interface RegisterPatientPayload {
  firstname: string;
  lastname: string;
  /** YYYY-MM-DD */
  dob: string;
  sex: string;
  /** E.164 (e.g. +15551234567). The client formats this before sending. */
  mobilephone: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  departmentid: number;
  // ── Optional demographics/consent (MIDI-aligned defaults applied if absent).
  /** HL7 race code (2.16.840.1.113883.5.104) or "declined". */
  race?: string;
  /** HL7 ethnicity code (2.16.840.1.113883.5.50) or "declined". */
  ethnicitycode?: string;
  /** ISO 639-2 code. Default "eng" applied downstream. */
  language6392code?: string;
  /** "true" | "false" — default "false" applied downstream. */
  consenttocall?: string;
  /** "true" | "false" — default "false" applied downstream. */
  consenttotext?: string;
  /** "U" | "S" | "M" | "D" | "W" — default "U" applied downstream. */
  maritalstatus?: string;
  /**
   * Medicare enrollment radio: "yes" | "no" | undefined. Captured for
   * the off-ramp at the demographics step (non-Medicare patients are
   * told membership-only and the wizard short-circuits). Persisted to
   * the audit row but not sent to Athena.
   */
  medicareenrolled?: string;
  // ── Marketing attribution (best-effort; passed straight to Salesforce Lead).
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  utm_id?: string;
  gclid?: string;
  msclkid?: string;
  fbclid?: string;
  /**
   * URL pathname the user landed on (e.g. "/newpatients"). Saved
   * verbatim to the Supabase audit row and stamped on the SF Lead
   * via tolerant custom field `Landing_Page_URL__c`.
   */
  landingpage?: string;
  /** Full referrer URL captured at landing. */
  referrer?: string;
  /** Optional explicit lead source ("Membership", "Website", etc). Defaults to "Online Registration". */
  leadSource?: string;
  /**
   * Wizard "How did you hear about us?" raw selection. Carried through
   * the regToken and mapped to the SF picklist value at the eligibility
   * step (see src/lib/salesforce/referral-source.ts).
   */
  referralsource?: string;
}

interface RegisterPatientSuccess {
  patientId: string;
  hintPatientId?: string;
  regToken: string;
  /** Salesforce PersonAccount Id (when Salesforce Account create succeeded). */
  salesforceAccountId?: string;
  /** Salesforce Lead Id (created at demographics step). */
  salesforceLeadId?: string;
}

interface RegisterPatientDuplicate {
  duplicate: true;
  message: string;
}

const REQUIRED_FIELDS: (keyof RegisterPatientPayload)[] = [
  "firstname",
  "lastname",
  "dob",
  "sex",
  "mobilephone",
  "departmentid",
];

function dobYyyyMmDdToAthena(dob: string): string {
  const [y, m, d] = dob.split("-");
  return `${m}/${d}/${y}`;
}

/**
 * Athena's createPatient `mobilephone` field rejects E.164 (`+1XXXXXXXXXX`).
 * It accepts 10-digit US numbers or hyphenated/parenthesized formats. We store
 * E.164 in regToken and forward it to Hint, but downgrade to 10 digits for
 * the Athena POST.
 */
function phoneE164ToAthena(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

function rateLimitKeyForMobile(mobile: unknown): string | undefined {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `m:${digits.slice(1)}`;
  if (digits.length === 10) return `m:${digits}`;
  return undefined;
}

export async function POST(request: NextRequest) {
  return withPortalErrors("register-patient", async () => {
    const body = await parseJsonBody<RegisterPatientPayload>(request);
    if (!body) {
      const rlBad = await rateLimit(request, {
        limit: 30,
        window: "1h",
        prefix: "portal-register-patient-invalid",
        failClosed: true,
      });
      if (!rlBad.success) {
        return NextResponse.json(
          { error: "Too many registration attempts. Try again later." },
          { status: 429 }
        );
      }
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    // Bucket by mobile number so Dot's server-to-server calls (same edge
    // IP / prior X-Forwarded-For workaround) don't share one global limit.
    const rl = await rateLimit(request, {
      limit: 10,
      window: "1h",
      prefix: "portal-register-patient",
      identifierOverride: rateLimitKeyForMobile(body.mobilephone),
      failClosed: true,
    });
    if (!rl.success) {
      return NextResponse.json(
        { error: "Too many registration attempts. Try again later." },
        { status: 429 }
      );
    }

    for (const key of REQUIRED_FIELDS) {
      if (
        body[key] === undefined ||
        body[key] === null ||
        String(body[key]).trim() === ""
      ) {
        return NextResponse.json(
          { error: `Missing required field: ${key}` },
          { status: 400 }
        );
      }
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dob)) {
      return NextResponse.json(
        { error: "dob must be in YYYY-MM-DD format" },
        { status: 400 }
      );
    }

    // DOB must be a real past calendar date with the patient at least 18.
    // The form also enforces this client-side; the server backstop catches
    // direct API hits where a future DOB was accepted upstream and Athena
    // soft-failed instead of us rejecting up front. (Incident 2026-05-19.)
    //
    // Validation pipeline:
    //   1. Regex already confirmed YYYY-MM-DD shape.
    //   2. Re-parse Y/M/D and verify the reconstructed UTC date round-trips
    //      to the input — `new Date()` silently normalizes overflow dates
    //      (e.g. 2026-02-31 -> 2026-03-03), which would otherwise be
    //      accepted and then mis-match in Athena EMPI dedup.
    //   3. Reject future dates.
    //   4. Compute age via full-year birthday comparison (NOT fractional
    //      years) so the gate matches RegistrationWizard.tsx exactly on
    //      18th-birthday and 130-year boundaries.
    const [dobYear, dobMonth, dobDay] = body.dob.split("-").map(Number);
    const dobDate = new Date(Date.UTC(dobYear, dobMonth - 1, dobDay));
    if (
      Number.isNaN(dobDate.getTime()) ||
      dobDate.getUTCFullYear() !== dobYear ||
      dobDate.getUTCMonth() + 1 !== dobMonth ||
      dobDate.getUTCDate() !== dobDay
    ) {
      return NextResponse.json(
        { error: "dob is not a valid calendar date" },
        { status: 400 }
      );
    }
    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    if (dobDate > todayUtc) {
      return NextResponse.json(
        { error: "dob cannot be in the future" },
        { status: 400 }
      );
    }
    let ageYears = todayUtc.getUTCFullYear() - dobDate.getUTCFullYear();
    const monthDiff = todayUtc.getUTCMonth() - dobDate.getUTCMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && todayUtc.getUTCDate() < dobDate.getUTCDate())
    ) {
      ageYears -= 1;
    }
    if (ageYears < 18) {
      return NextResponse.json(
        { error: "Patient must be at least 18 years old to self-register" },
        { status: 400 }
      );
    }
    if (ageYears > 130) {
      return NextResponse.json({ error: "dob is not plausible" }, { status: 400 });
    }

    // Athena POST /patients enforces an undocumented 50-char cap on `email`
    // and returns a 400 with "Email is longer than 50 characters". Reject
    // here so we never soft-fail patient_create on email length alone.
    if (body.email && body.email.trim().length > 50) {
      return NextResponse.json(
        { error: "email must be 50 characters or shorter" },
        { status: 400 }
      );
    }

    if (!/^\+\d{10,15}$/.test(body.mobilephone)) {
      return NextResponse.json(
        { error: "mobilephone must be E.164 (e.g. +15551234567)" },
        { status: 400 }
      );
    }

    const idemPayload = {
      firstname: body.firstname.trim().toLowerCase(),
      lastname: body.lastname.trim().toLowerCase(),
      dob: body.dob,
      mobilephone: body.mobilephone,
      departmentid: body.departmentid,
    };

    const cached = await idempotencyGet<RegisterPatientSuccess | RegisterPatientDuplicate>(
      "register-patient",
      idemPayload
    );
    if (cached) {
      return NextResponse.json(cached);
    }

    const athenaDob = dobYyyyMmDdToAthena(body.dob);
    const athenaPhone = phoneE164ToAthena(body.mobilephone);

    let matches: Awaited<ReturnType<typeof enhancedBestMatch>> = [];
    try {
      matches = await enhancedBestMatch({
        firstname: body.firstname,
        lastname: body.lastname,
        dob: athenaDob,
        email: body.email,
        mobilephone: athenaPhone,
        departmentid: body.departmentid,
      });
    } catch (err) {
      captureServerException(err, {
        tags: { portal_route: "register-patient", step: "enhancedBestMatch" },
      });
    }

    if (matches.length > 0 && (matches[0].score ?? 0) >= 23) {
      const dupResponse: RegisterPatientDuplicate = {
        duplicate: true,
        message:
          "We may already have a record for you. Please sign in to continue, or call us if you need help.",
      };
      await idempotencySet("register-patient", idemPayload, dupResponse, 300);
      return NextResponse.json(dupResponse, { status: 200 });
    }

    let patientId = "";
    let pending = false;
    try {
      const created = await createPatient({
        firstname: body.firstname,
        lastname: body.lastname,
        dob: athenaDob,
        sex: body.sex,
        email: body.email,
        mobilephone: athenaPhone,
        address1: body.address1,
        address2: body.address2,
        city: body.city,
        state: body.state,
        zip: body.zip,
        departmentid: body.departmentid,
        // MIDI-aligned defaults live in the client (PORTAL_PATIENT_DEFAULTS);
        // anything the registrant actually answered overrides them.
        race: body.race,
        ethnicitycode: body.ethnicitycode,
        language6392code: body.language6392code,
        consenttocall: body.consenttocall,
        consenttotext: body.consenttotext,
        maritalstatus: body.maritalstatus,
      });
      patientId = created.patientid;

      // ── Post-create consent acknowledgments (best-effort) ────────
      // The patient just walked through the wizard and accepted our
      // Terms / HIPAA Notice of Privacy Practices, so we record the
      // corresponding Athena consents immediately:
      //
      //   1. POST /patients/{id}/privacyinformationverified
      //      — PRIVACYNOTICE (HIPAA Notice acknowledged)
      //      — PATIENTSIGNATURE (Release of Billing Information)
      //      — INSUREDSIGNATURE (Assignment of Benefits)
      //
      //   2. PUT /patients/{id}/interfaceconsents
      //      — Care Quality / HIE: grant "Y" to every vendor the
      //        practice has configured. In Preview the vendor list
      //        is typically empty (0 written); in Prod every active
      //        HIE vendor lights up.
      //
      // Both calls are wrapped in try/catch and any failure is
      // recorded as a soft followup row. They never block the
      // registration flow — if a consent endpoint returns 5xx the
      // patient still gets a regToken and proceeds.
      try {
        await setPrivacyInformationVerified(patientId, {
          signatureName: `${body.firstname} ${body.lastname}`.trim().slice(0, 100),
          departmentId: body.departmentid,
        });
      } catch (privacyErr) {
        const eventId = captureServerException(privacyErr, {
          tags: {
            portal_route: "register-patient",
            step: "privacyInformationVerified",
          },
        });
        await recordFollowup({
          step: "patient_create",
          severity: "soft",
          status: "pending",
          athenaPatientId: patientId,
          firstName: body.firstname,
          lastName: body.lastname,
          phone: body.mobilephone,
          email: body.email,
          payload: { phase: "privacy_information_verified" },
          error: privacyErr,
          errorCode: "ATHENA_PRIVACY_VERIFIED",
          sentryEventId: eventId ?? null,
        });
      }

      try {
        const consentResult = await setAllInterfaceConsentsYes(
          patientId,
          body.departmentid,
        );
        if (consentResult.written > 0) {
          await recordFollowup({
            step: "patient_create",
            outcome: "success",
            athenaPatientId: patientId,
            payload: {
              phase: "interface_consents",
              vendors: consentResult.vendors,
              written: consentResult.written,
            },
          });
        }
      } catch (consentErr) {
        const eventId = captureServerException(consentErr, {
          tags: {
            portal_route: "register-patient",
            step: "interfaceConsents",
          },
        });
        await recordFollowup({
          step: "patient_create",
          severity: "soft",
          status: "pending",
          athenaPatientId: patientId,
          firstName: body.firstname,
          lastName: body.lastname,
          phone: body.mobilephone,
          email: body.email,
          payload: {
            phase: "interface_consents",
            departmentid: body.departmentid,
          },
          error: consentErr,
          errorCode: "ATHENA_INTERFACE_CONSENTS",
          sentryEventId: eventId ?? null,
        });
      }
    } catch (err) {
      // Soft-fail: never block the patient at the entry point. Athena being
      // flaky shouldn't make registration unreachable. We mint a synthetic
      // `pending-<uuid>` patient id, drop a followup row so back-office
      // sees the queued registration with all the form data, and let the
      // wizard advance. Subsequent routes (insurance / eligibility /
      // appointment) detect the prefix and skip Athena calls, recording
      // their own followup rows along the way.
      const sentryEventId = captureServerException(err, {
        tags: { portal_route: "register-patient", step: "createAthenaPatient" },
      });
      const errorCode =
        err instanceof AthenaApiError
          ? `ATHENA_${err.statusCode}`
          : "ATHENA_PATIENT_REGISTER";

      patientId = mintPendingPatientId();
      pending = true;

      await recordFollowup({
        step: "patient_create",
        severity: "soft",
        athenaPatientId: patientId,
        departmentId: body.departmentid,
        firstName: body.firstname,
        lastName: body.lastname,
        phone: body.mobilephone,
        email: body.email,
        payload: {
          dob: body.dob,
          sex: body.sex,
          address1: body.address1,
          city: body.city,
          state: body.state,
          zip: body.zip,
          departmentid: body.departmentid,
          race: body.race,
          ethnicitycode: body.ethnicitycode,
          language6392code: body.language6392code,
          consenttocall: body.consenttocall,
          consenttotext: body.consenttotext,
          maritalstatus: body.maritalstatus,
          medicareEnrolled: body.medicareenrolled,
          referralSource: body.referralsource,
          leadSource: body.leadSource,
          landingPage: body.landingpage,
          referrer: body.referrer,
          utm: {
            source: body.utm_source,
            medium: body.utm_medium,
            campaign: body.utm_campaign,
            content: body.utm_content,
            term: body.utm_term,
            id: body.utm_id,
            gclid: body.gclid,
            msclkid: body.msclkid,
            fbclid: body.fbclid,
          },
          athenaResponseBody:
            err instanceof AthenaApiError
              ? (err.responseBody || "").slice(0, 500)
              : undefined,
        },
        error: err,
        errorCode,
        sentryEventId,
      });
    }

    let hintPatientId: string | undefined;
    // Skip Hint when Athena create soft-failed — there's no real patient to
    // tie the Hint record to yet. Back-office reconciles after promoting
    // the pending Athena id.
    if (!pending && process.env.HINT_API_KEY && body.email) {
      try {
        const hintPatient = await createHintPatient({
          first_name: body.firstname,
          last_name: body.lastname,
          email: body.email,
          dob: body.dob,
          address_line1: body.address1,
          address_city: body.city,
          address_state: body.state,
          address_zip: body.zip,
          phone: body.mobilephone,
        });
        hintPatientId = hintPatient.id;
      } catch (err) {
        // Non-fatal — Hint patient can be created at membership step instead.
        captureServerException(err, {
          tags: {
            portal_route: "register-patient",
            step: "createHintPatient",
            severity: "non_fatal",
          },
        });
        if (err instanceof HintApiError) {
          console.warn(
            `[Portal:register-patient] Hint patient creation soft-failed (${err.statusCode}); membership step will retry.`
          );
        }
      }
    }

    // Salesforce write-through (best-effort, never blocks the response):
    //
    //   1. PersonAccount with SourceSystemIdentifier = Athena patient id
    //      so Athena Pro inbound sync can match on it later.
    //   2. Lead is NOT created here — that happens at /register/eligibility
    //      once we have insurance + Stedi outcome to populate it with.
    //   3. Appointment + Lead↔Account+Appointment linkage happens at
    //      /register/appointments/book.
    const leadSource = body.leadSource || "Online Registration";
    const utmSnapshot = {
      source: body.utm_source,
      medium: body.utm_medium,
      campaign: body.utm_campaign,
      content: body.utm_content,
      term: body.utm_term,
      id: body.utm_id,
      gclid: body.gclid,
      msclkid: body.msclkid,
      fbclid: body.fbclid,
    };
    const landingPage = body.landingpage?.slice(0, 500) || undefined;
    const referringUrl = body.referrer?.slice(0, 500) || undefined;
    const salesforceAccountId = await createOnlineRegistrationAccount({
      patientId,
      pending,
      body,
    });

    const salesforceLeadId = await createOnlineRegistrationLead({
      salesforceAccountId,
      patientId,
      pending,
      body,
    });

    const regToken = await mintRegistrationToken({
      athenaPatientId: patientId,
      hintPatientId,
      departmentId: body.departmentid,
      dobHash: hashDob(body.dob),
      phone: body.mobilephone,
      email: body.email,
      firstName: body.firstname,
      lastName: body.lastname,
      salesforceAccountId,
      salesforceLeadId,
      leadSource,
      referralSource: body.referralsource?.trim() || undefined,
      landingPage,
      referrer: referringUrl,
      utm: utmSnapshot,
    });

    const response: RegisterPatientSuccess = {
      patientId,
      hintPatientId,
      regToken,
      salesforceAccountId,
      salesforceLeadId,
    };
    await idempotencySet("register-patient", idemPayload, response, 300);

    // Server-side funnel event. The browser already fires
    // registration_demographics_submitted from RegistrationWizard.tsx;
    // this is the authoritative server signal that the patient row
    // really landed in Athena (or fell back to pending). Distinct id
    // is the salted hash of the Athena patient id — never the raw id.
    try {
      const distinctId = await hashToOpaqueDistinctId(patientId);
      await captureServerEvent(distinctId, "patient_created_server", {
        pending,
        departmentId: body.departmentid,
        hasHintPatient: Boolean(hintPatientId),
        hasSalesforceAccount: Boolean(salesforceAccountId),
        leadSource,
        landing_page: landingPage,
        salesforce_lead_id: salesforceLeadId,
        utm_source: body.utm_source,
        utm_medium: body.utm_medium,
        utm_campaign: body.utm_campaign,
        utm_content: body.utm_content,
        utm_term: body.utm_term,
        gclid: body.gclid,
        msclkid: body.msclkid,
        fbclid: body.fbclid,
      });

      // Compliant server-side identify: stamp non-PHI linkage props on the
      // opaque person profile so the patient's events are tied to a real
      // (categorical) identity. Raw email/name are NEVER set — sanitizeProperties
      // strips them and the distinct id is a salted hash, per the BAA.
      // Conditionally include SF ids so we never overwrite an existing linkage
      // with null on a later pending/retry call.
      await identifyServerPerson(distinctId, {
        hh_id_source: "patient_registration",
        last_patient_event: "patient_created_server",
        lead_source: leadSource,
        landing_page: landingPage,
        ...(salesforceLeadId ? { salesforce_lead_id: salesforceLeadId } : {}),
        ...(salesforceAccountId
          ? { salesforce_account_id: salesforceAccountId }
          : {}),
      });

      // Unified onboarding funnel event (one event, `step` property) so the
      // full journey can be funnelled without unioning per-milestone names.
      await captureServerEvent(distinctId, "onboarding_step_completed", {
        step: pending ? "patient_pending" : "patient_created",
        flow: "register",
        leadSource,
      });
    } catch {
      // analytics never blocks the response
    }

    // Passive Clerk provisioning. Best-effort, silent — we want the patient
    // to have a dormant account they can later claim via SMS OTP without
    // ever being prompted now. Skipped on soft-fail (`pending`) because no
    // real Athena patient exists yet, and skipped when the flag is off.
    if (!pending && getPortalFeatureFlags().passiveClerk) {
      const passive = await createPassiveClerkUser({
        phone: body.mobilephone,
        email: body.email,
        firstName: body.firstname,
        lastName: body.lastname,
        athenaPatientId: patientId,
        hintPatientId,
        departmentId: body.departmentid,
      });
      if (passive.status === "error") {
        // Audit-log the failure so back-office can reconcile later. The
        // patient never sees this — Athena registration already succeeded.
        await recordFollowup({
          step: "passive_clerk_create",
          severity: "soft",
          outcome: "soft_failed",
          athenaPatientId: patientId,
          hintPatientId,
          departmentId: body.departmentid,
          firstName: body.firstname,
          lastName: body.lastname,
          phone: body.mobilephone,
          email: body.email,
          payload: { sentryEventId: passive.sentryEventId },
        });
      } else if (passive.status !== "skipped") {
        await recordFollowup({
          step: "passive_clerk_create",
          outcome: "success",
          athenaPatientId: patientId,
          hintPatientId,
          departmentId: body.departmentid,
          firstName: body.firstname,
          lastName: body.lastname,
          phone: body.mobilephone,
          email: body.email,
          payload: {
            clerkUserId: passive.clerkUserId,
            mode: passive.status,
          },
        });
      }
    }

    // Audit row — every successful wizard submission is captured to
    // Supabase as the backup of record. The soft-fail path already wrote
    // its own row inside the catch block above, so skip when `pending`.
    if (!pending) {
      await recordFollowup({
        step: "patient_create",
        outcome: "success",
        athenaPatientId: patientId,
        hintPatientId,
        departmentId: body.departmentid,
        firstName: body.firstname,
        lastName: body.lastname,
        phone: body.mobilephone,
        email: body.email,
        payload: {
          dob: body.dob,
          sex: body.sex,
          address1: body.address1,
          address2: body.address2,
          city: body.city,
          state: body.state,
          zip: body.zip,
          departmentid: body.departmentid,
          race: body.race,
          ethnicitycode: body.ethnicitycode,
          language6392code: body.language6392code,
          consenttocall: body.consenttocall,
          consenttotext: body.consenttotext,
          maritalstatus: body.maritalstatus,
          medicareEnrolled: body.medicareenrolled,
          referralSource: body.referralsource,
          leadSource,
          landingPage,
          referrer: referringUrl,
          utm: utmSnapshot,
        },
        result: {
          athenaPatientId: patientId,
          hintPatientId,
          salesforce: {
            accountId: salesforceAccountId ?? null,
          },
        },
      });
    }

    return NextResponse.json(response);
  });
}

/**
 * Hard-coded RecordType id for the PersonAccount on the production org
 * (HH_Prod and HH_UAT share the same RT id for this RT). Setting it
 * explicitly avoids a SOQL round-trip on every registration submit.
 */
const PERSON_ACCOUNT_RECORD_TYPE_ID = "0128b000000YyZ6AAK";

/**
 * Convert YYYY-MM-DD → ISO date for Salesforce PersonBirthdate.
 */
function dobToSalesforce(dob: string | undefined): string | undefined {
  if (!dob) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/**
 * Create a Salesforce PersonAccount representing the new patient. The
 * Account's `SourceSystemIdentifier` is set to the Athena patient id so
 * the inbound Athena Pro sync (when live) can match by source-system id.
 *
 * Returns the Account Id on success, undefined on any failure. Never
 * throws — Salesforce being down must not block the Athena response.
 *
 * Field-tolerant: drops unknown fields and retries once. This keeps the
 * portal working against orgs where the latest custom fields haven't
 * been deployed yet.
 */
async function createOnlineRegistrationAccount(args: {
  patientId: string;
  pending: boolean;
  body: RegisterPatientPayload;
}): Promise<string | undefined> {
  const { patientId, pending, body } = args;
  if (pending) return undefined;
  if (!body.email && !body.mobilephone) return undefined;

  try {
    const sf = await SalesforceClient.fromEnvironment();
    if (!sf) return undefined;

    // Field set + values are aligned with the Prefect Athena→Salesforce
    // patient sync (UAT_PatientAppointmentSync.transform_patients) so the
    // record we create here doesn't drift from what the nightly sync
    // expects to see. Same SourceSystem tag, same identifier fan-out
    // (standard + namespaced + PersonAccount-suffixed), same Type.
    const accountData: Record<string, unknown> = {
      RecordTypeId: PERSON_ACCOUNT_RECORD_TYPE_ID,
      Type: "Person Account",
      FirstName: body.firstname,
      LastName: body.lastname,
      PersonEmail: body.email,
      PersonMobilePhone: body.mobilephone,
      PersonBirthdate: dobToSalesforce(body.dob),
      PersonMailingStreet: body.address1,
      PersonMailingCity: body.city,
      PersonMailingStateCode: body.state,
      PersonMailingPostalCode: body.zip,
      PersonMailingCountryCode: "US",
      PersonGender: body.sex,
      // Athena Pro inbound sync match keys (mirrors the Prefect sync).
      SourceSystemIdentifier: patientId,
      Source_System_ID_Search__c: patientId,
      HealthCloudGA__SourceSystem__c: "AthenaOne-31254",
      HealthCloudGA__SourceSystem__pc: "AthenaOne-31254",
      HealthCloudGA__SourceSystemId__c: patientId,
      HealthCloudGA__SourceSystemId__pc: patientId,
    };

    for (const k of Object.keys(accountData)) {
      if (accountData[k] === undefined) delete accountData[k];
    }

    const created = await createRecordTolerant(sf, accountData, {
      context: "register-patient/account-create",
      sobject: "Account",
    });
    return created.id;
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_route: "register-patient",
        step: "createSalesforceAccount",
        severity: "non_fatal",
      },
    });
    console.warn(
      "[Portal:register-patient] Salesforce Account create failed:",
      err,
    );
    return undefined;
  }
}

/**
 * Best-effort Salesforce Lead create at the demographics step. Linked to
 * the PersonAccount created at /register/patient via Matched_Account__c.
 * Captures basic demographic info + UTMs/lead source so back-office has
 * the full registration context as soon as Step 1 is submitted (even if
 * the patient drops off on Step 2).
 */
async function createOnlineRegistrationLead(args: {
  salesforceAccountId?: string;
  patientId: string;
  pending: boolean;
  body: RegisterPatientPayload;
}): Promise<string | undefined> {
  const { salesforceAccountId, patientId, pending, body } = args;
  if (pending) return undefined;
  if (!body.email && !body.mobilephone) return undefined;

  try {
    const sf = await SalesforceClient.fromEnvironment();
    if (!sf) return undefined;

    const leadData: Record<string, unknown> = {
      FirstName: body.firstname,
      LastName: body.lastname,
      Email: body.email,
      MobilePhone: body.mobilephone,
      Company: "Individual",
      LeadSource: body.leadSource
        ? normalizeLeadSource(body.leadSource)
        : "Online Registration",
      Matched_Account__c: salesforceAccountId,
      Patient_ID__c: patientId,
      Online_Registration_Started__c: true,
      Eligibility_Status__c: "Indeterminate",
    };

    const sfReferralSource = mapReferralSourceToSf(body.referralsource);
    if (sfReferralSource) {
      leadData.How_did_you_hear_about_us__c = sfReferralSource;
    }

    if (body.utm_source) leadData.utm_source__c = body.utm_source;
    if (body.utm_medium) leadData.utm_medium__c = body.utm_medium;
    if (body.utm_campaign) leadData.utm_campaign__c = body.utm_campaign;
    if (body.utm_content) leadData.utm_content__c = body.utm_content;
    if (body.utm_term) leadData.utm_term__c = body.utm_term;
    if (body.utm_id) leadData.utm_id__c = body.utm_id;
    if (body.gclid) leadData.GCLID__c = body.gclid;
    if (body.msclkid) leadData.MSCLKID__c = body.msclkid;
    if (body.fbclid) leadData.FBCLID__c = body.fbclid;

    if (body.landingpage) {
      leadData.Landing_Page_URL__c = body.landingpage.slice(0, 255);
    }
    if (body.referrer) {
      leadData.Referrer_URL__c = body.referrer.slice(0, 255);
    }

    for (const k of Object.keys(leadData)) {
      if (leadData[k] === undefined) delete leadData[k];
    }

    const created = await createRecordTolerant(sf, leadData, {
      context: "register-patient/lead-create",
      sobject: "Lead",
    });

    // Salesforce Lead Ids start with `00Q`. If `createRecordTolerant` came
    // back with a non-Lead Id, it almost certainly hit a cross-object
    // duplicate match (Lead.Lead_to_Person_Account_Dup matches against
    // PersonAccount, and the tolerant helper reuses the matched id even
    // when that id is for a different sobject). Treat that as a hard
    // failure so back-office knows the Lead does NOT exist, instead of
    // pretending an Account id is a Lead id.
    if (!created?.id || !created.id.startsWith("00Q")) {
      const wrongPrefixErr = new Error(
        `Salesforce Lead create returned non-Lead id ${created?.id ?? "<missing>"
        } (likely cross-object duplicate match against PersonAccount).`
      );
      const sentryEventId = captureServerException(wrongPrefixErr, {
        level: "error",
        tags: {
          portal_route: "register-patient",
          step: "createSalesforceLead",
          severity: "hard_failed",
          sf_failure_mode: "cross_object_duplicate_match",
        },
        extra: {
          patientId,
          salesforceAccountId,
          returnedId: created?.id ?? null,
        },
      });
      await recordFollowup({
        step: "salesforce_lead_create",
        outcome: "hard_failed",
        severity: "hard",
        status: "pending",
        athenaPatientId: patientId,
        firstName: body.firstname,
        lastName: body.lastname,
        phone: body.mobilephone,
        email: body.email,
        payload: {
          salesforceAccountId,
          leadSource: leadData.LeadSource,
        },
        error: wrongPrefixErr,
        errorCode: "SF_LEAD_CROSS_OBJECT_DUP",
        sentryEventId,
      });
      return undefined;
    }

    return created.id;
  } catch (err) {
    // Hard fail — back-office cannot reach this patient until a Lead is
    // created. Capture as an *error* (not non_fatal) so it pages on
    // Sentry, and write a durable Supabase row so reconciliation has
    // the full context (patient id, account id, contact info, payload).
    const sentryEventId = captureServerException(err, {
      level: "error",
      tags: {
        portal_route: "register-patient",
        step: "createSalesforceLead",
        severity: "hard_failed",
      },
      extra: {
        patientId,
        salesforceAccountId,
      },
    });
    console.error(
      "[Portal:register-patient] Salesforce Lead create failed:",
      err,
    );
    await recordFollowup({
      step: "salesforce_lead_create",
      outcome: "hard_failed",
      severity: "hard",
      status: "pending",
      athenaPatientId: patientId,
      firstName: body.firstname,
      lastName: body.lastname,
      phone: body.mobilephone,
      email: body.email,
      payload: {
        salesforceAccountId,
        leadSource: body.leadSource ?? "Online Registration",
      },
      error: err,
      errorCode: "SF_LEAD_CREATE_FAILED",
      sentryEventId,
    });
    return undefined;
  }
}
