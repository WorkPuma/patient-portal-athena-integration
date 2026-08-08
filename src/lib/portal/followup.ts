/**
 * Audit + soft-fail recorder for the no-account portal registration wizard.
 *
 * EVERY wizard step writes a row here, success or failure:
 *
 *   - On success we capture the input payload + the upstream response
 *     (Athena patient id, insurance row, eligibility summary, appointment
 *     slot). Supabase is the durable backup of record — if Athena / Hint /
 *     Salesforce ever drops data we can replay from this table.
 *
 *   - On failure (Athena 5xx, Stedi outage, payer not enrolled, etc.) the
 *     wizard returns a synthetic success so the patient keeps moving, and
 *     this row carries `outcome = 'soft_failed'` + the error so back-office
 *     reconciles before the visit.
 *
 * `recordFollowup` is intentionally wrap-the-world: it NEVER throws. If
 * Supabase itself is down we log the inner error to Sentry so we don't
 * silently lose patient context, but the calling route still returns its
 * upstream result.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TODO(prod-cutover): purge synthetic E2E rows before this table is used
 * by real back-office workflows.
 *
 * The Playwright matrix and probe scripts have been writing rows here
 * since 2026-05 with emails of the form `e2e+<scenario>+<runid>@e2e.com`
 * (previously `@e2e.test`, also `@e2e.example.com`). Those rows currently
 * pollute every "any row with outcome=soft_failed needs follow-up"
 * report. Before flipping the table to be the source of record for
 * production registrations:
 *
 *   1. Run: DELETE FROM portal_registration_followups
 *          WHERE email ILIKE 'e2e+%@e2e.com'
 *             OR email ILIKE 'e2e+%@e2e.test'
 *             OR email ILIKE 'hh-e2e+%@e2e.example.com'
 *             OR athena_patient_id IS NULL AND payload->>'firstName' ILIKE 'e2e%';
 *   2. Mirror cleanup against Athena Preview test patients, SF UAT
 *      Account/Lead/Appointment__c records with those emails, and Hint
 *      Staging patients (see `tests/e2e/_lib/cleanup.ts` for cancel-
 *      appointment logic; patient delete is a manual back-office task).
 *   3. Add the same email pattern as an exclusion filter to whichever
 *      back-office dashboard / Zeno panel surfaces this table so a stray
 *      future E2E run doesn't generate noise again.
 * ─────────────────────────────────────────────────────────────────────────
 */

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "@/lib/env";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";

export type FollowupStep =
  | "patient_create"
  | "insurance_attach"
  | "eligibility_check"
  | "appointment_book"
  | "passive_clerk_create"
  | "salesforce_lead_create";

export type FollowupSeverity = "info" | "soft" | "hard";
export type FollowupOutcome = "success" | "soft_failed" | "hard_failed";

export interface FollowupRecord {
  step: FollowupStep;
  /**
   * Defaults to 'success' when no `error` is provided, 'soft_failed'
   * otherwise. Pass 'hard_failed' explicitly when the wizard cannot
   * advance past this step.
   */
  outcome?: FollowupOutcome;
  /**
   * Defaults to 'info' for success, 'soft' for soft_failed, 'hard' for
   * hard_failed.
   */
  severity?: FollowupSeverity;
  /**
   * Workflow state override. Defaults to 'resolved' for success and
   * 'pending' otherwise. Pass 'resolved' to silence audit-only rows
   * (e.g. Athena 409 "slot taken") that don't need back-office action.
   */
  status?: "pending" | "in_progress" | "resolved" | "cancelled";
  athenaPatientId?: string | null;
  hintPatientId?: string | null;
  departmentId?: number | null;
  /** Contact info so back-office can reach the patient. */
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  /** The body the wizard submitted. We sanitize before insert. */
  payload?: Record<string, unknown>;
  /**
   * The upstream success response (Athena patient id, eligibility
   * summary, etc.). Sanitized the same way as `payload`. Set this on
   * success calls so Supabase carries a complete backup of record.
   */
  result?: Record<string, unknown>;
  /** The error we caught (Error, string, or anything else). */
  error?: unknown;
  /** Optional explicit code, e.g. ATHENA_INSURANCE_ADD. */
  errorCode?: string | null;
  /** Sentry event id captured by the calling route. */
  sentryEventId?: string | null;
}

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (supabase) return supabase;
  // Service role required — RLS allows writes only from service_role.
  // Use `readSupabaseEnv` so a `\r\n`-polluted env value (seen with
  // `vercel env pull` output) cannot silently produce a malformed URL
  // that drops every audit insert on the floor.
  const env = readSupabaseEnv({ role: "service-role" });
  if (!env) return null;
  supabase = createClient(env.url, env.key, {
    db: { schema: "public" },
    auth: { persistSession: false },
  });
  return supabase;
}

/**
 * Strip obvious secrets from a payload before persisting. The wizard sends
 * member IDs (PHI but expected here), names, DOBs, and form fields — those
 * stay. We strip any field whose name suggests a token / password / key.
 */
function sanitizePayload(
  payload: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  const REDACT = /token|secret|password|apikey|api_key|authorization|bearer/i;
  for (const [k, v] of Object.entries(payload)) {
    if (REDACT.test(k)) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizePayload(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message.slice(0, 1000);
  if (typeof err === "string") return err.slice(0, 1000);
  try {
    return JSON.stringify(err).slice(0, 1000);
  } catch {
    return String(err).slice(0, 1000);
  }
}

/**
 * Persist a followup record. NEVER throws. Returns the new row id when the
 * insert succeeded so the caller can include it in their Sentry breadcrumb,
 * or null when Supabase wasn't available / the insert failed.
 */
export async function recordFollowup(
  record: FollowupRecord
): Promise<string | null> {
  const client = getClient();
  // Defaults are derived from whether the caller passed an error.
  const outcome: FollowupOutcome =
    record.outcome ??
    (record.error !== undefined && record.error !== null
      ? "soft_failed"
      : "success");
  const severity: FollowupSeverity =
    record.severity ??
    (outcome === "success" ? "info" : outcome === "hard_failed" ? "hard" : "soft");
  const status =
    record.status ?? (outcome === "success" ? "resolved" : "pending");

  if (!client) {
    // Supabase isn't configured for this deploy. Log failures to Sentry
    // so we know we're flying blind, but don't blow up on the success
    // audit path either — those are noisy and not actionable.
    if (outcome !== "success") {
      captureServerMessage(
        "portal_registration_followups: Supabase unavailable, dropping failure log",
        {
          level: "error",
          tags: { portal_followup: record.step, outcome },
          extra: {
            errorMessage: errorMessage(record.error),
          },
        }
      );
    }
    return null;
  }

  try {
    const row = {
      step: record.step,
      outcome,
      status,
      severity,
      athena_patient_id: record.athenaPatientId ?? null,
      hint_patient_id: record.hintPatientId ?? null,
      department_id: record.departmentId ?? null,
      first_name: record.firstName ?? null,
      last_name: record.lastName ?? null,
      phone: record.phone ?? null,
      email: record.email ?? null,
      payload: sanitizePayload(record.payload),
      result:
        outcome === "success" && record.result
          ? sanitizePayload(record.result)
          : null,
      error_message: record.error ? errorMessage(record.error) : null,
      error_code: record.errorCode ?? null,
      sentry_event_id: record.sentryEventId ?? null,
    };

    const { data, error } = await client
      .from("portal_registration_followups")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      captureServerException(error, {
        tags: {
          portal_followup: record.step,
          followup_persist: "supabase_insert_failed",
          outcome,
        },
        extra: {
          originalError: errorMessage(record.error),
        },
      });
      return null;
    }

    return (data?.id as string) ?? null;
  } catch (err) {
    captureServerException(err, {
      tags: {
        portal_followup: record.step,
        followup_persist: "unexpected_throw",
        outcome,
      },
      extra: { originalError: errorMessage(record.error) },
    });
    return null;
  }
}

// ── Pending patient helpers ──────────────────────────────────────────
//
// When Athena's createPatient call fails the wizard mints a "pending"
// regToken whose patientId starts with `pending-`. Subsequent routes
// (insurance, eligibility, appointment) detect that prefix and skip the
// upstream call, recording a followup row instead so back-office can
// reconcile after the real Athena id lands.

const PENDING_PREFIX = "pending-";

export function mintPendingPatientId(): string {
  // crypto.randomUUID is available on the Node runtime (Next 15 RSC default).
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${PENDING_PREFIX}${uuid}`;
}

export function isPendingPatientId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(PENDING_PREFIX);
}
