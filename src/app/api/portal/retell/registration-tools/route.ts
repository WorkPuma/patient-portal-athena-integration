/**
 * Retell custom-tool endpoint for Dot, the registration & scheduling
 * assistant. Each `name` here corresponds to a tool the Retell LLM can
 * invoke during a conversation. The handlers chain into the existing
 * `/api/portal/register/*` routes server-to-server so we reuse all the
 * resilience (idempotency, soft-fail, recordFollowup) those routes
 * already implement — Dot is just a different *driver* for the same
 * registration funnel.
 *
 * Cross-turn state lives in `dot-session.ts` keyed by Retell `call_id`
 * (or `chat_id` — Retell text chat reuses the call_id field). A regToken
 * minted by `register_patient` is stored there and forwarded as Bearer
 * for subsequent tool calls; we never expose the regToken to the LLM.
 *
 * Security: Retell signs tool requests with HMAC-SHA256 over the raw
 * body using your Retell API key. We verify in production; in preview
 * we accept unsigned bodies so engineers can curl the endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPortalFeatureFlags } from "@/lib/portal/feature-flags";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";
import {
  shouldEnforceRetellSignature,
  verifyRetellSignature,
} from "@/lib/retell/verify";
import {
  getDotSession,
  mergeDotSession,
  type DotSession,
  type DotSlotOption,
} from "@/lib/portal/dot-session";
import { listActiveLocations } from "@/lib/portal/locations";
import {
  filterProvidersByLocation,
  listProviderDirectory,
} from "@/lib/portal/providers";
import {
  searchPortalInsurancePackages,
  resolveAthenaInsurancePackageId,
} from "@/lib/portal/insurance-packages";
import {
  REGISTRATION_INITIAL_VISIT_TYPE_IDS,
  getRegistrationInitialVisitTypeId,
} from "@/lib/scheduling/appointment-types";
import { recordFollowup } from "@/lib/portal/followup";
import { retryWithBackoff } from "@/lib/async/retry";

// ─── Internal HTTP plumbing ────────────────────────────────────────────────

/**
 * Base URL for server-to-server calls back into the same deployment.
 * Uses the incoming request's host header to determine the correct base URL,
 * ensuring it works across all preview deployments without env var churn.
 */
function internalBaseUrl(request: NextRequest): string {
  const host = request.headers.get("host") || process.env.VERCEL_URL || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}`;
}

interface InternalFetchOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  regToken?: string;
}

async function internalFetch<T>(
  opts: InternalFetchOptions,
  request: NextRequest
): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  /** Raw response body (truncated) for diagnostics on non-2xx. */
  rawBody?: string;
}> {
  const url = `${internalBaseUrl(request)}${opts.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "HerselfHealth-Dot/1.0",
  };
  if (opts.regToken) {
    headers["Authorization"] = `Bearer ${opts.regToken}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    captureServerException(err, {
      tags: { dot_tool: "internal_fetch", path: opts.path },
    });
    return { ok: false, status: 0, data: null, error: "network_error" };
  }

  let rawText = "";
  let parsed: unknown = null;
  try {
    rawText = await res.text();
    parsed = rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const errMsg =
      (parsed as { error?: string } | null)?.error ?? `http_${res.status}`;
    return {
      ok: false,
      status: res.status,
      data: (parsed as T) ?? null,
      error: errMsg,
      rawBody: rawText.slice(0, 1000),
    };
  }
  return { ok: true, status: res.status, data: (parsed as T) ?? null };
}

// ─── Tool helpers ──────────────────────────────────────────────────────────

interface ToolEnvelope {
  call_id?: string;
  chat_id?: string;
  tool_call_id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  // Some Retell payloads nest the args under `parameters`/`args`.
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
  // Retell text-chat envelope nests the chat object under `chat`,
  // with chat_id/call_id inside it. Voice envelopes pass call_id at top.
  chat?: { chat_id?: string; call_id?: string; agent_id?: string };
  call?: { call_id?: string; chat_id?: string };
  // The incoming request, used to derive the correct base URL for internal fetch.
  __request?: NextRequest;
}

function getSessionKey(env: ToolEnvelope): string {
  // Try every place Retell has stuffed the chat/call id over the years.
  // Text chat: env.chat.chat_id
  // Voice:     env.call_id (or env.call.call_id)
  // Older:     env.chat_id
  const candidate =
    env.chat?.chat_id ||
    env.chat?.call_id ||
    env.call?.call_id ||
    env.call?.chat_id ||
    env.call_id ||
    env.chat_id ||
    "";
  return candidate.trim();
}

function getArgs(env: ToolEnvelope): Record<string, unknown> {
  return env.arguments ?? env.parameters ?? env.args ?? {};
}

function ok(
  toolCallId: string | undefined,
  result: Record<string, unknown>
): NextResponse {
  return NextResponse.json({
    tool_call_id: toolCallId ?? "tool_call",
    result: JSON.stringify(result),
  });
}

function err(
  toolCallId: string | undefined,
  message: string,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({
    tool_call_id: toolCallId ?? "tool_call",
    result: JSON.stringify({ ok: false, error: message, ...(extra ?? {}) }),
  });
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return String(v).trim() || undefined;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function boolArg(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const normalized = String(v).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes")
    return true;
  if (normalized === "false" || normalized === "0" || normalized === "no")
    return false;
  return undefined;
}

function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10) {
    return `+${digits}`;
  }
  return null;
}

function normalizeDob(raw: string): string | null {
  const trimmed = raw.trim();
  // Already YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return trimmed;
  // MM/DD/YYYY (or sloppy single-digit)
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    const m = slash[1].padStart(2, "0");
    const d = slash[2].padStart(2, "0");
    return `${slash[3]}-${m}-${d}`;
  }
  // ISO date string from a chatty user ("1959-04-12T00:00:00")
  const isoFull = /^(\d{4})-(\d{2})-(\d{2})T/.exec(trimmed);
  if (isoFull) return `${isoFull[1]}-${isoFull[2]}-${isoFull[3]}`;
  return null;
}

function isoDateFor(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toAthenaDate(iso: string): string {
  // YYYY-MM-DD → MM/DD/YYYY
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

// ─── Tool: register_patient ────────────────────────────────────────────────

interface AthenaRegisterResponse {
  patientId?: string;
  hintPatientId?: string;
  regToken?: string;
  salesforceLeadId?: string;
  duplicate?: boolean;
  message?: string;
}

async function handleRegisterPatient(
  env: ToolEnvelope
): Promise<NextResponse> {
  const args = getArgs(env);
  const sessionKey = getSessionKey(env);

  const firstName = strArg(args, "first_name") || strArg(args, "firstname");
  const lastName = strArg(args, "last_name") || strArg(args, "lastname");
  const dobRaw = strArg(args, "dob") || strArg(args, "date_of_birth");
  const sex = (strArg(args, "sex") || "F").toUpperCase().slice(0, 1);
  const phoneRaw = strArg(args, "phone") || strArg(args, "mobilephone");
  const email = strArg(args, "email");
  const address1 = strArg(args, "address1") || strArg(args, "address");
  const city = strArg(args, "city");
  const state = (strArg(args, "state") || "").trim().toUpperCase();
  const zip = strArg(args, "zip") || strArg(args, "postal_code");
  const departmentId =
    numArg(args, "department_id") || numArg(args, "departmentid") || 5; // safe default: Rosedale (Roseville)
  const consentToCall =
    boolArg(args, "consent_to_call") ??
    boolArg(args, "consenttocall") ??
    true;
  const consentToText =
    boolArg(args, "consent_to_text") ??
    boolArg(args, "consenttotext") ??
    true;

  if (!firstName || !lastName) {
    return err(env.tool_call_id, "Need both first and last name to register.");
  }
  const dob = dobRaw ? normalizeDob(dobRaw) : null;
  if (!dob) {
    return err(
      env.tool_call_id,
      "Need a valid date of birth (e.g. 1959-04-12 or 04/12/1959)."
    );
  }
  if (!phoneRaw) {
    return err(env.tool_call_id, "Need a mobile phone number to register.");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(env.tool_call_id, "Need a valid email address to register.");
  }
  if (!address1 || !city || !state || !zip) {
    return err(
      env.tool_call_id,
      "Need full address details (street, city, state, and ZIP) to register."
    );
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return err(env.tool_call_id, "State must be a 2-letter US code (e.g. MN).");
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    return err(env.tool_call_id, "ZIP must be 5 digits (or ZIP+4).");
  }
  const phone = normalizeE164(phoneRaw);
  if (!phone) {
    return err(
      env.tool_call_id,
      "That phone number doesn't look like a valid US number — please share 10 digits."
    );
  }

  // Attempt registration with up to 2 retries on transient failures.
  const result = await retryWithBackoff(
    () =>
      internalFetch<AthenaRegisterResponse>(
        {
          method: "POST",
          path: "/api/portal/register/patient",
          body: {
            firstname: firstName,
            lastname: lastName,
            dob,
            sex,
            mobilephone: phone,
            email,
            address1,
            city,
            state,
            zip,
            departmentid: departmentId,
            consenttotext: consentToText ? "true" : "false",
            consenttocall: consentToCall ? "true" : "false",
          },
        },
        env.__request!
      ),
    {
      maxAttempts: 3,
      baseDelayMs: 500,
      shouldRetry: (r) => !r.ok || !r.data,
    }
  );

  if (!result.ok || !result.data) {
    // Sentry extras must NOT include PHI. The upstream response and raw
    // body can echo Athena patient identifiers (patientId, member ids,
    // demographics) — keep those in the Supabase followup audit below
    // (intentional, scoped to back-office) and ship only safe metadata
    // to Sentry.
    const sentryEventId = captureServerMessage(
      "Dot register_patient: upstream failure after retries",
      {
        level: "error",
        extra: {
          error: result?.error,
          status: result?.status,
          // Do not pass `result.data` (may contain PHI). The presence
          // of a response body is enough for triage; full payload lives
          // in Supabase keyed by athena_patient_id.
          hasResponseBody:
            result?.data !== null && result?.data !== undefined,
        },
      }
    );
    // Defensive audit: write a Supabase followup directly from the tool
    // layer so we always have a record of the failure (e.g. rate-limit
    // rejection, network error) even when the inner route never ran.
    await recordFollowup({
      step: "patient_create",
      severity: "soft",
      outcome: "soft_failed",
      departmentId,
      firstName,
      lastName,
      phone,
      email,
      payload: {
        source: "dot_register_patient_tool",
        dob,
        sex,
        address1,
        city,
        state,
        zip,
        consentToCall,
        consentToText,
        upstreamStatus: result?.status ?? null,
        upstreamResponse: result?.data ?? null,
        upstreamRawBody: result?.rawBody ?? null,
      },
      error:
        result?.rawBody ||
        result?.error ||
        `register_patient unresolved (status=${result?.status ?? "unknown"})`,
      errorCode: `DOT_REGISTER_PATIENT_${result?.status ?? "UNKNOWN"}`,
      sentryEventId: typeof sentryEventId === "string" ? sentryEventId : null,
    });
    return err(env.tool_call_id, "Let me connect you with a team member to complete your registration.", {
      escalateToHuman: true,
    });
  }

  if (result.data.duplicate) {
    return ok(env.tool_call_id, {
      ok: true,
      duplicate: true,
      message:
        result.data.message ||
        "It looks like we already have a record for you. Please sign in or call us so we can help directly.",
    });
  }

  if (!result.data.regToken || !result.data.patientId) {
    return err(env.tool_call_id, "Registration succeeded but no token returned.");
  }

  await mergeDotSession(sessionKey, {
    regToken: result.data.regToken,
    athenaPatientId: result.data.patientId,
    hintPatientId: result.data.hintPatientId,
    salesforceLeadId: result.data.salesforceLeadId,
    draft: {
      firstName,
      lastName,
      dob,
      sex,
      phone,
      email,
      address1,
      city,
      state,
      zip,
      departmentId,
    },
  });

  return ok(env.tool_call_id, {
    ok: true,
    patient_id: result.data.patientId,
    pending: result.data.patientId.startsWith("pending-"),
    message: `Got it — your file is started, ${firstName}. Now let's grab your insurance and pick a clinic.`,
  });
}

// ─── Tool: attach_insurance (payor name only) ──────────────────────────────

async function handleAttachInsurance(
  env: ToolEnvelope
): Promise<NextResponse> {
  const args = getArgs(env);
  const sessionKey = getSessionKey(env);
  const session = await getDotSession(sessionKey);

  const payorName =
    strArg(args, "payor_name") ||
    strArg(args, "insurance_name") ||
    strArg(args, "plan_name");
  const memberId =
    strArg(args, "member_id") ||
    strArg(args, "insurance_member_id") ||
    strArg(args, "insuranceidnumber");
  const groupNumber =
    strArg(args, "group_number") || strArg(args, "policynumber");
  const relationshipToInsuredId =
    numArg(args, "relationship_to_insured_id") ||
    numArg(args, "relationshiptoinsuredid") ||
    1;
  const policyholderFirstName =
    strArg(args, "policyholder_first_name") ||
    strArg(args, "insurancepolicyholderfirstname");
  const policyholderLastName =
    strArg(args, "policyholder_last_name") ||
    strArg(args, "insurancepolicyholderlastname");
  const policyholderDobRaw =
    strArg(args, "policyholder_dob") ||
    strArg(args, "insurancepolicyholderdob");
  const policyholderDob = policyholderDobRaw
    ? normalizeDob(policyholderDobRaw) || policyholderDobRaw
    : undefined;

  if (!session.regToken || !session.athenaPatientId) {
    return err(env.tool_call_id, "We need to register the patient first.", {
      next_action: "register_patient",
    });
  }
  if (!payorName) {
    return err(
      env.tool_call_id,
      "Tell me the insurance company name — e.g. Blue Cross, Medicare, or UnitedHealthcare."
    );
  }
  if (!memberId) {
    return ok(env.tool_call_id, {
      ok: true,
      needs_more_info: true,
      required_fields: ["member_id"],
      message:
        "Thanks. I also need the member ID from your insurance card before I can finish insurance setup.",
    });
  }
  if (
    relationshipToInsuredId !== 1 &&
    (!policyholderFirstName || !policyholderLastName || !policyholderDob)
  ) {
    return ok(env.tool_call_id, {
      ok: true,
      needs_more_info: true,
      required_fields: [
        "policyholder_first_name",
        "policyholder_last_name",
        "policyholder_dob",
      ],
      message:
        "Because the policyholder is not the patient, I need the policyholder first name, last name, and date of birth.",
    });
  }

  // Resolve the payor name to an Athena insurancepackageid via the
  // staged Supabase table the wizard already uses. Prefer the most
  // commonly-used package matching the brand (the table is sorted by
  // patient_insurance_count desc).
  let packages: Awaited<ReturnType<typeof searchPortalInsurancePackages>> =
    [];
  try {
    packages = await searchPortalInsurancePackages(payorName, 5);
  } catch (e) {
    captureServerException(e, {
      tags: { dot_tool: "attach_insurance", stage: "search" },
    });
  }

  // If the staged Supabase search has no hit, fall through to the
  // /api/portal/register/insurance route with a placeholder package id.
  // In preview, that route remaps everything to the BCBS-MN preview id
  // (PORTAL_PREVIEW_INSURANCE_PACKAGE_ID, default 1132). In production,
  // an unmatched payor stays unmatched and the route will reject it —
  // we'll still capture the failure for back-office reconciliation.
  let resolvedPackageId: number;
  let resolvedPlanName: string;
  let resolvedIsGovFunded: boolean;
  if (packages[0]) {
    resolvedPackageId = packages[0].insurancepackageid;
    resolvedPlanName = packages[0].insuranceplanname;
    resolvedIsGovFunded = packages[0].isGovernmentFunded;
  } else {
    const fallback = resolveAthenaInsurancePackageId(1);
    if (!fallback.remapped) {
      // Production with no MDM match → soft fail honestly.
      return ok(env.tool_call_id, {
        ok: true,
        soft: true,
        message: `I couldn't match "${payorName}" to a plan in our system right now. Our team will confirm it with you on the follow-up call.`,
        saved_payor_name: payorName,
      });
    }
    resolvedPackageId = fallback.effectiveId;
    resolvedPlanName = `${payorName} (preview-mapped to BCBS-MN)`;
    resolvedIsGovFunded = false;
  }
  const top = {
    insurancepackageid: resolvedPackageId,
    insuranceplanname: resolvedPlanName,
    isGovernmentFunded: resolvedIsGovFunded,
  };

  // Attempt to attach insurance with up to 2 retries on transient failures.
  const attach = await retryWithBackoff(
    () =>
      internalFetch<{
        insurance?: { insuranceid?: string };
        soft?: boolean;
        pending?: boolean;
        message?: string;
      }>(
        {
          method: "POST",
          path: "/api/portal/register/insurance",
          regToken: session.regToken,
          body: {
            insurancepackageid: top.insurancepackageid,
            insuranceidnumber: memberId,
            policynumber: groupNumber,
            insurancepolicyholderfirstname: policyholderFirstName,
            insurancepolicyholderlastname: policyholderLastName,
            insurancepolicyholderdob: policyholderDob,
            relationshiptoinsuredid: relationshipToInsuredId,
            sequencenumber: 1,
          },
        },
        env.__request!
      ),
    {
      maxAttempts: 3,
      baseDelayMs: 500,
      shouldRetry: (r) => !r.ok,
    }
  );

  await mergeDotSession(sessionKey, {
    draft: {
      insurancePayorName: payorName,
      insurancePackageId: top.insurancepackageid,
      insuranceMemberId: memberId,
      insuranceGroupNumber: groupNumber,
      relationshipToInsuredId: relationshipToInsuredId,
      policyholderFirstName,
      policyholderLastName,
      policyholderDob,
    },
  });

  const insuranceId = String(attach.data?.insurance?.insuranceid || "");
  const attachSoft = Boolean(attach.data?.soft);
  const attachPending = Boolean(attach.data?.pending);
  const attachFailed = !attach.ok || attachSoft || attachPending;

  if (attachFailed) {
    // Sentry extras must NOT carry PHI. memberId, policyholder DOB,
    // policy/group numbers, and upstream Athena response bodies all
    // qualify as PHI and are excluded here. The Supabase followup audit
    // below preserves the full payload for back-office reconciliation.
    const sentryEventId = captureServerMessage(
      "Dot attach_insurance: unresolved, escalating to callback",
      {
        level: "warning",
        extra: {
          payorName,
          status: attach?.status,
          error: attach?.error,
          soft: attachSoft,
          pending: attachPending,
          hasResponseBody:
            attach?.data !== null && attach?.data !== undefined,
        },
      }
    );

    // Defensive audit: write a Supabase followup directly from the tool
    // layer so we always have a record of the failure regardless of where
    // it happened in the chain (token rejection, validation 400, Athena
    // 4xx, network error, etc.). The inner /api/portal/register/insurance
    // route also writes its own row when it actually runs — the duplicate
    // is intentional and back-office can reconcile by athena_patient_id.
    await recordFollowup({
      step: "insurance_attach",
      severity: "soft",
      outcome: "soft_failed",
      athenaPatientId: session.athenaPatientId,
      departmentId: session.draft.departmentId,
      firstName: session.draft.firstName ?? null,
      lastName: session.draft.lastName ?? null,
      phone: session.draft.phone ?? null,
      email: session.draft.email ?? null,
      payload: {
        source: "dot_attach_insurance_tool",
        payorName,
        insurancePackageId: top.insurancepackageid,
        insuranceidnumber: memberId,
        policynumber: groupNumber,
        relationshiptoinsuredid: relationshipToInsuredId,
        policyholderFirstName,
        policyholderLastName,
        policyholderDob,
        upstreamStatus: attach?.status ?? null,
        upstreamSoft: attachSoft,
        upstreamPending: attachPending,
        upstreamResponse: attach?.data ?? null,
        upstreamRawBody: attach?.rawBody ?? null,
      },
      error:
        attach?.rawBody ||
        attach?.error ||
        `attach_insurance unresolved (status=${attach?.status ?? "unknown"})`,
      errorCode: `DOT_ATTACH_INSURANCE_${attach?.status ?? "UNKNOWN"}`,
      sentryEventId: typeof sentryEventId === "string" ? sentryEventId : null,
    });

    const previousFailures = (session.draft.insuranceAttachFailures ?? 0) + 1;
    await mergeDotSession(sessionKey, {
      draft: {
        insuranceAttached: false,
        insuranceAttachFailures: previousFailures,
      },
    });

    // First failure: ask for corrected info (the patient may have given a
    // wrong member ID). Second failure: escalate to human handoff.
    if (previousFailures < 2) {
      return ok(env.tool_call_id, {
        ok: true,
        needs_more_info: true,
        required_fields: ["member_id"],
        payor_name: payorName,
        message:
          `Thanks. Could you double-check the member ID on your ${payorName} card and read it to me again? It usually starts with letters or digits printed near your name.`,
      });
    }

    // Second failure — fire the handoff Lead and stop pushing.
    await internalFetch({
      method: "POST",
      path: "/api/portal/register/handoff",
      body: {
        firstName: session.draft.firstName || "Patient",
        lastName: session.draft.lastName || "Unknown",
        email:
          session.draft.email ||
          `${session.athenaPatientId || "dot"}@unknown.local`,
        phone: session.draft.phone,
        context:
          "Dot could not finalize insurance attach for scheduling; patient needs assisted scheduling callback.",
        mode: "callback_request",
        leadId: session.salesforceLeadId,
        patientId: session.athenaPatientId,
      },
    }, env.__request!);

    return ok(env.tool_call_id, {
      ok: true,
      handoff_required: true,
      payor_name: payorName,
      message:
        "Thanks — I have your details. A team member will reach out to finish your insurance and schedule your appointment.",
    });
  }

  const insuranceAttached = !!insuranceId && !insuranceId.startsWith("pending-");
  await mergeDotSession(sessionKey, {
    draft: { insuranceAttached },
  });

  return ok(env.tool_call_id, {
    ok: true,
    payor_name: payorName,
    matched_plan: top.insuranceplanname,
    is_government_funded: top.isGovernmentFunded,
    insurance_attached: insuranceAttached,
    message: `Great — your insurance is on file. Next, let's pick your clinic and provider.`,
  });
}

// ─── Tool: list_clinics ────────────────────────────────────────────────────

async function handleListClinics(env: ToolEnvelope): Promise<NextResponse> {
  try {
    const locations = await listActiveLocations();
    return ok(env.tool_call_id, {
      ok: true,
      clinics: locations.map((l) => ({
        slug: l.slug,
        department_id: l.departmentid,
        name: l.shortName,
        full_name: l.name,
        address: l.formattedAddress,
        phone: l.phone,
      })),
    });
  } catch (e) {
    captureServerException(e, { tags: { dot_tool: "list_clinics" } });
    return err(env.tool_call_id, "We couldn't load the clinic list.");
  }
}

// ─── Tool: list_providers ──────────────────────────────────────────────────

async function handleListProviders(env: ToolEnvelope): Promise<NextResponse> {
  const args = getArgs(env);
  const slug = strArg(args, "clinic_slug") || strArg(args, "location");
  try {
    const all = await listProviderDirectory();
    const filtered = slug ? filterProvidersByLocation(all, slug) : all;
    return ok(env.tool_call_id, {
      ok: true,
      providers: filtered.slice(0, 8).map((p) => ({
        provider_id: p.providerid,
        name: p.displayname,
        credentials: p.credentials,
        title: p.title,
        specializations: p.specializations,
      })),
      // The bot can offer "earliest at any provider" as a fast path.
      earliest_option: {
        provider_id: "earliest",
        label: "Earliest available at this clinic",
      },
    });
  } catch (e) {
    captureServerException(e, { tags: { dot_tool: "list_providers" } });
    return err(env.tool_call_id, "We couldn't load the provider list.");
  }
}

// ─── Tool: find_available_slots ────────────────────────────────────────────

interface AvailableSlotsResponse {
  appointments?: Array<{
    appointmentid: number | string;
    date: string;
    starttime: string;
    providerfullname?: string;
    departmentid?: number | string;
    appointmenttypeid?: number | string;
  }>;
}

function toDotSlotOption(
  slot: NonNullable<AvailableSlotsResponse["appointments"]>[number],
  resolvedDeptId: number,
  apptTypeId: number
): DotSlotOption {
  return {
    appointment_id: Number(slot.appointmentid),
    date: String(slot.date),
    time: String(slot.starttime),
    provider: slot.providerfullname || "First available provider",
    department_id: slot.departmentid ?? resolvedDeptId,
    appointment_type_id: slot.appointmenttypeid ?? apptTypeId,
  };
}

/** Pick up to four slots spread across distinct days for Dot to read aloud. */
function pickDistinctDotSlots(
  all: NonNullable<AvailableSlotsResponse["appointments"]>,
  resolvedDeptId: number,
  apptTypeId: number,
  limit = 4
): DotSlotOption[] {
  const seenDays = new Set<string>();
  const picked: DotSlotOption[] = [];
  for (const slot of all) {
    if (picked.length >= limit) break;
    const day = String(slot.date);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    picked.push(toDotSlotOption(slot, resolvedDeptId, apptTypeId));
  }
  if (picked.length >= limit) return picked;
  for (const slot of all) {
    if (picked.length >= limit) break;
    if (picked.some((p) => p.appointment_id === Number(slot.appointmentid))) {
      continue;
    }
    picked.push(toDotSlotOption(slot, resolvedDeptId, apptTypeId));
  }
  return picked;
}

async function handleFindAvailableSlots(
  env: ToolEnvelope
): Promise<NextResponse> {
  const args = getArgs(env);
  const sessionKey = getSessionKey(env);
  const session = await getDotSession(sessionKey);

  if (!session.regToken) {
    return err(env.tool_call_id, "We need to register you first.", {
      next_action: "register_patient",
    });
  }
  if (!session.draft.insuranceAttached) {
    return err(
      env.tool_call_id,
      "Before I can schedule, I need complete insurance details on file.",
      { next_action: "attach_insurance" }
    );
  }

  const clinicSlug =
    strArg(args, "clinic_slug") || session.draft.clinicSlug || undefined;
  const departmentId =
    numArg(args, "department_id") || session.draft.departmentId;
  const providerArg =
    strArg(args, "provider_id") ||
    (session.draft.providerId !== undefined
      ? String(session.draft.providerId)
      : undefined);
  const isEarliest =
    !providerArg || providerArg.toLowerCase() === "earliest";
  const providerId = isEarliest ? undefined : Number(providerArg);

  // Default lookahead window: today → 28 days. The bot is welcome to
  // pass narrower ranges if the patient says "next week" etc.
  const startIso = strArg(args, "start_date") || isoDateFor(0);
  const endIso = strArg(args, "end_date") || isoDateFor(28);

  // Pin to the registration Initial Visit allowlist. We don't know
  // commercial-vs-government with certainty without Stedi (which we're
  // intentionally skipping in Dot's flow), so default to the 90-min
  // standard Initial Visit type which any clinic can fulfill.
  const apptTypeId = getRegistrationInitialVisitTypeId("in_person", "standard");

  // Resolve clinic_slug → department_id when only the slug was given.
  let resolvedDeptId = departmentId;
  if (!resolvedDeptId && clinicSlug) {
    try {
      const locations = await listActiveLocations();
      const hit = locations.find((l) => l.slug === clinicSlug);
      if (hit) resolvedDeptId = hit.departmentid;
    } catch {
      // fall through; upstream will validate
    }
  }

  if (!resolvedDeptId) {
    return err(
      env.tool_call_id,
      "Pick a clinic first so I know where to look for openings.",
      { next_action: "list_clinics" }
    );
  }

  const params = new URLSearchParams({
    departmentid: String(resolvedDeptId),
    appointmenttypeid: String(apptTypeId),
    startdate: toAthenaDate(startIso),
    enddate: toAthenaDate(endIso),
  });
  if (providerId !== undefined) params.set("providerid", String(providerId));

  const result = await internalFetch<AvailableSlotsResponse>({
    method: "GET",
    path: `/api/portal/register/appointments/available?${params.toString()}`,
    regToken: session.regToken,
  }, env.__request!);

  if (!result.ok || !result.data) {
    return err(env.tool_call_id, "We couldn't load openings right now.", {
      retryable: true,
    });
  }

  const all = result.data.appointments ?? [];
  if (all.length === 0) {
    return ok(env.tool_call_id, {
      ok: true,
      slots: [],
      message:
        "I don't see any openings in the next four weeks at that clinic. Want me to widen the search or try a different location?",
    });
  }

  const picked = pickDistinctDotSlots(all, resolvedDeptId, apptTypeId);

  await mergeDotSession(sessionKey, {
    lastSlots: picked,
    draft: {
      clinicSlug,
      departmentId: resolvedDeptId,
      providerId: isEarliest ? "earliest" : providerId,
    },
  });

  return ok(env.tool_call_id, {
    ok: true,
    slots: picked.map((s, idx) => ({
      option: idx + 1,
      appointment_id: s.appointment_id,
      date: s.date,
      time: s.time,
      provider: s.provider,
    })),
    message: `Here are the next ${picked.length} openings — read them out and ask which one works.`,
  });
}

// ─── Tool: book_visit ──────────────────────────────────────────────────────

async function handleBookVisit(env: ToolEnvelope): Promise<NextResponse> {
  const args = getArgs(env);
  const sessionKey = getSessionKey(env);
  const session = await getDotSession(sessionKey);

  if (!session.regToken) {
    return err(env.tool_call_id, "We need to register you first.", {
      next_action: "register_patient",
    });
  }
  if (!session.draft.insuranceAttached) {
    return err(
      env.tool_call_id,
      "I need complete insurance details before I can book your appointment.",
      { next_action: "attach_insurance" }
    );
  }

  // Two ways to specify the slot:
  //  1. `option` (1..N) referring to the last list shown to the patient.
  //  2. `appointment_id` directly (when the LLM has it from a prior tool).
  let slot: DotSlotOption | undefined;
  const option =
    numArg(args, "option") ??
    numArg(args, "slot_option") ??
    numArg(args, "slot_index") ??
    numArg(args, "slot_number") ??
    numArg(args, "choice");
  const apptId = numArg(args, "appointment_id");
  if (option && session.lastSlots && option >= 1 && option <= session.lastSlots.length) {
    slot = session.lastSlots[option - 1];
  } else if (apptId && session.lastSlots) {
    slot = session.lastSlots.find((s) => s.appointment_id === apptId);
  } else if (apptId) {
    slot = {
      appointment_id: apptId,
      date: strArg(args, "date") || "",
      time: strArg(args, "time") || "",
      provider: strArg(args, "provider") || "",
      department_id: numArg(args, "department_id") || 0,
      appointment_type_id:
        numArg(args, "appointment_type_id") ||
        getRegistrationInitialVisitTypeId("in_person", "standard"),
    };
  }

  if (!slot) {
    return err(
      env.tool_call_id,
      "I don't have a slot picked yet — find available slots first."
    );
  }

  const apptTypeId = Number(slot.appointment_type_id);
  if (!REGISTRATION_INITIAL_VISIT_TYPE_IDS.has(apptTypeId)) {
    return err(
      env.tool_call_id,
      "That appointment type isn't allowed for registration; pick a slot from the list I gave you."
    );
  }

  const result = await internalFetch<{
    appointment?: { appointmentid?: string | number };
    soft?: boolean;
    pending?: boolean;
    message?: string;
    code?: string;
  }>({
    method: "POST",
    path: "/api/portal/register/appointments/book",
    regToken: session.regToken,
    body: {
      appointmentId: slot.appointment_id,
      appointmenttypeid: apptTypeId,
      bookingnote: "Initial visit booked via Dot (chat agent)",
    },
  }, env.__request!);

  if (!result.ok && result.status === 409) {
    return ok(env.tool_call_id, {
      ok: false,
      slot_taken: true,
      message:
        "Sorry — that time was just taken. Want me to read three other openings?",
    });
  }
  if (!result.ok || !result.data) {
    return err(env.tool_call_id, "We couldn't book that slot.", {
      retryable: true,
    });
  }

  const appointmentId = result.data.appointment?.appointmentid;
  await mergeDotSession(sessionKey, {
    bookedAppointmentId: appointmentId,
  });

  return ok(env.tool_call_id, {
    ok: true,
    appointment_id: appointmentId,
    soft: result.data.soft ?? false,
    pending: result.data.pending ?? false,
    confirmed_for: { date: slot.date, time: slot.time, provider: slot.provider },
    message: `You're booked for ${slot.date} at ${slot.time} with ${slot.provider}. Someone from our team will reach out shortly to confirm any remaining details.`,
  });
}

// ─── Tool: schedule_followup ──────────────────────────────────────────────
//
// Always called after a successful book_visit. Creates a Salesforce Lead
// with mode=post_booking_confirmation so member services has a queue to
// work — confirms member-id, demographics, addresses any insurance
// nuance Dot intentionally skipped.

async function handleScheduleFollowup(
  env: ToolEnvelope
): Promise<NextResponse> {
  const sessionKey = getSessionKey(env);
  const session = await getDotSession(sessionKey);
  const args = getArgs(env);

  if (!session.draft.firstName || !session.draft.lastName) {
    return err(
      env.tool_call_id,
      "I don't have a name on file yet — register the patient first."
    );
  }
  if (!session.draft.email && !session.draft.phone) {
    return err(env.tool_call_id, "Need an email or phone for the follow-up.");
  }

  const summary = buildFollowupContext(session, strArg(args, "context"));

  const result = await internalFetch<{
    success?: boolean;
    leadId?: string;
    contactWindow?: { message?: string };
  }>({
    method: "POST",
    path: "/api/portal/register/handoff",
    body: {
      firstName: session.draft.firstName,
      lastName: session.draft.lastName,
      email: session.draft.email || `${session.athenaPatientId}@unknown.local`,
      phone: session.draft.phone,
      context: summary,
      mode: "post_booking_confirmation",
      patientId: session.athenaPatientId,
      appointmentId: session.bookedAppointmentId,
      leadId: session.salesforceLeadId,
    },
  }, env.__request!);

  if (!result.ok || !result.data?.success) {
    captureServerMessage("Dot schedule_followup: handoff failed", {
      level: "warning",
      extra: { error: result.error },
    });
    // Soft-success — the Athena booking already happened; we don't
    // want to scare the patient if Salesforce is briefly down.
    return ok(env.tool_call_id, {
      ok: true,
      soft: true,
      message:
        "I've recorded everything. Our team will reach out shortly to confirm the rest.",
    });
  }

  return ok(env.tool_call_id, {
    ok: true,
    lead_id: result.data.leadId,
    message:
      result.data.contactWindow?.message ||
      "All set — someone will reach out shortly to confirm any remaining details.",
  });
}

function buildFollowupContext(
  session: DotSession,
  extra: string | undefined
): string {
  const parts: string[] = [
    `Dot booked an Initial Visit for patient ${session.athenaPatientId ?? "unknown"}.`,
  ];
  if (session.bookedAppointmentId) {
    parts.push(`Athena appointment id: ${session.bookedAppointmentId}.`);
  }
  if (session.draft.insurancePayorName) {
    parts.push(`Patient stated payor: ${session.draft.insurancePayorName}.`);
  }
  if (session.draft.insuranceMemberId) {
    parts.push(`Member id collected: ${session.draft.insuranceMemberId}.`);
  }
  if (session.draft.insuranceGroupNumber) {
    parts.push(`Group number: ${session.draft.insuranceGroupNumber}.`);
  }
  if (session.draft.clinicSlug) {
    parts.push(`Clinic: ${session.draft.clinicSlug}.`);
  }
  if (extra) parts.push(extra);
  return parts.join(" ").slice(0, 1500);
}

// ─── Tool: request_callback ───────────────────────────────────────────────
//
// Pre-booking escape hatch. Dot calls this when the patient asks for a
// human earlier in the conversation (or when registration soft-fails
// hard enough that we shouldn't try to keep going).

async function handleRequestCallback(
  env: ToolEnvelope
): Promise<NextResponse> {
  const args = getArgs(env);
  const sessionKey = getSessionKey(env);
  const session = await getDotSession(sessionKey);

  const firstName =
    strArg(args, "first_name") ||
    strArg(args, "firstname") ||
    session.draft.firstName;
  const lastName =
    strArg(args, "last_name") ||
    strArg(args, "lastname") ||
    session.draft.lastName;
  const email = strArg(args, "email") || session.draft.email;
  const phoneRaw = strArg(args, "phone") || session.draft.phone;
  const reason = strArg(args, "reason") || "Patient asked for a human.";

  if (!firstName || !lastName) {
    return err(env.tool_call_id, "Need first and last name to request a callback.");
  }
  if (!email && !phoneRaw) {
    return err(
      env.tool_call_id,
      "Need an email or phone so we know how to reach the patient."
    );
  }

  const phone = phoneRaw ? normalizeE164(phoneRaw) || phoneRaw : undefined;

  const result = await internalFetch<{
    success?: boolean;
    leadId?: string;
    contactWindow?: { message?: string };
  }>({
    method: "POST",
    path: "/api/portal/register/handoff",
    body: {
      firstName,
      lastName,
      email: email || `${phone}@unknown.local`,
      phone,
      context: `Dot callback request: ${reason}`,
      mode: "callback_request",
      leadId: session.salesforceLeadId,
      patientId: session.athenaPatientId,
    },
  }, env.__request!);

  if (!result.ok || !result.data?.success) {
    return err(env.tool_call_id, "We couldn't queue the callback.", {
      retryable: true,
    });
  }

  return ok(env.tool_call_id, {
    ok: true,
    lead_id: result.data.leadId,
    message:
      result.data.contactWindow?.message ||
      "All set — someone from our team will reach out shortly.",
  });
}

// ─── Router ────────────────────────────────────────────────────────────────

const TOOL_HANDLERS: Record<
  string,
  (env: ToolEnvelope) => Promise<NextResponse>
> = {
  register_patient: handleRegisterPatient,
  attach_insurance: handleAttachInsurance,
  list_clinics: handleListClinics,
  list_providers: handleListProviders,
  find_available_slots: handleFindAvailableSlots,
  book_visit: handleBookVisit,
  schedule_followup: handleScheduleFollowup,
  request_callback: handleRequestCallback,
};

export async function POST(request: NextRequest) {
  // Defense-in-depth: when Dot is disabled, refuse all tool calls so a
  // stale Retell agent (or a manual probe) cannot drive registration.
  if (!getPortalFeatureFlags().dot) {
    return NextResponse.json(
      { disabled: true, error: "Dot is disabled in this environment." },
      { status: 503 }
    );
  }

  const rawBody = await request.text();

  // Verify Retell signature in production (permissive in preview/local).
  const verification = verifyRetellSignature(rawBody, request.headers);
  if (!verification.ok && shouldEnforceRetellSignature()) {
    captureServerMessage("Dot tool call: invalid signature", {
      level: "warning",
      extra: { reason: verification.reason },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let envelope: ToolEnvelope;
  try {
    envelope = rawBody ? (JSON.parse(rawBody) as ToolEnvelope) : {};
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const name = (envelope.name || "").trim();
  const handler = TOOL_HANDLERS[name];

  if (!handler) {
    return NextResponse.json({
      tool_call_id: envelope.tool_call_id || "tool_call",
      result: JSON.stringify({
        ok: false,
        error: `Unknown tool: ${name || "(none)"}`,
      }),
    });
  }

  // Inject the request so handlers can derive the correct internal base URL.
  envelope.__request = request;

  try {
    return await handler(envelope);
  } catch (e) {
    captureServerException(e, {
      tags: { dot_tool: name, route: "registration-tools" },
    });
    return NextResponse.json({
      tool_call_id: envelope.tool_call_id || "tool_call",
      result: JSON.stringify({
        ok: false,
        error: "Tool execution failed",
      }),
    });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    name: "Dot registration tools",
    tools: Object.keys(TOOL_HANDLERS),
  });
}
