/**
 * Shared resilience helpers for portal API routes.
 *
 * - `safeJsonResponse` — capture exceptions to Sentry, never leak handler stack.
 * - `idempotencyGuard`  — short-lived Redis "fingerprint" cache so a retried
 *   POST (double-click, network retry) returns the prior response instead of
 *   creating a duplicate row in Athena/Hint/Salesforce.
 * - `parseJsonBody`     — request body parser that defends against empty bodies
 *   and HTML/error-page payloads from upstream tooling.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { cacheGet, cacheSet } from "@/lib/upstash/cache";
import { getPostHogServer } from "@/lib/posthog/server";
import { shouldCapturePostHog } from "@/lib/posthog/environment";
import { captureServerException } from "@/lib/capture-exception";

export type Json = Record<string, unknown> | unknown[] | null;

export interface PortalErrorBody {
  error: string;
  code?: string;
  detail?: string;
  [key: string]: unknown;
}

/**
 * Standardized portal API error envelope.
 *
 * Every 4xx/5xx returned by `/api/portal/**` should serialize to this shape.
 * The patient-portal client (`src/lib/portal/client.ts`) and React error
 * boundaries unwrap it to render targeted error UI instead of a generic
 * "something went wrong" toast:
 *
 *   { ok:false, code, message, fieldHints?, retryable, eventId? }
 *
 * - `code`        is a stable, machine-readable identifier (e.g.
 *                 `BRAND_UNRESOLVED`, `STEDI_400`, `RATE_LIMIT_EXCEEDED`).
 *                 The UI matches on this to decide whether to show inline
 *                 form errors, a banner, or to retry transparently.
 * - `message`     is a single user-facing sentence (no internal detail). UI
 *                 may override this when it has more context.
 * - `fieldHints`  ties errors back to specific form fields for inline
 *                 validation. Keys are JSON-pointer-ish field paths
 *                 (`memberId`, `policyholder.dob`); values are short copy.
 * - `retryable`   true → the UI may auto-retry once (network blip, 5xx).
 *                 false → patient must change input or escalate.
 * - `eventId`     Sentry event id when the error was server-side.
 */
export interface PortalApiErrorEnvelope {
  ok: false;
  code: string;
  message: string;
  fieldHints?: Record<string, string>;
  retryable: boolean;
  eventId?: string;
  /** Optional fragment for verbose debugging in non-prod. */
  detail?: string;
}

/** Build a typed error envelope `NextResponse`. */
export function portalError(args: {
  status: number;
  code: string;
  message: string;
  fieldHints?: Record<string, string>;
  retryable?: boolean;
  eventId?: string;
  detail?: string;
}): NextResponse {
  const body: PortalApiErrorEnvelope & { error: string } = {
    ok: false,
    code: args.code,
    message: args.message,
    // Keep `error` as a duplicate of `message` for backward-compatibility
    // with any existing UI code that still reads `error`. New consumers
    // should branch on `ok === false` and read `code` / `message`.
    error: args.message,
    retryable: args.retryable ?? args.status >= 500,
  };
  if (args.fieldHints) body.fieldHints = args.fieldHints;
  if (args.eventId) body.eventId = args.eventId;
  if (args.detail && process.env.VERCEL_ENV !== "production") {
    body.detail = args.detail.slice(0, 300);
  }
  return NextResponse.json(body, {
    status: args.status,
    headers: args.eventId ? { "x-sentry-id": args.eventId } : undefined,
  });
}

/**
 * Heuristic: detect "the deploy is missing required configuration" errors so
 * we can return a much more actionable 500 (with a stable `code`) instead of
 * the opaque "Internal error" the old catch-all produced.
 *
 * Examples that should hit this branch:
 *   - REGISTRATION_TOKEN_SECRET missing/short (mintRegistrationToken)
 *   - ATHENA_CLIENT_ID/SECRET missing (athena/client.getAccessToken)
 *   - HINT_API_KEY missing when the route requires Hint
 */
function classifyConfigError(message: string): string | null {
  const m = message.toLowerCase();
  if (
    m.includes("registration_token_secret") ||
    m.includes("athena_client_id") ||
    m.includes("athena_client_secret") ||
    m.includes("hint_api_key") ||
    m.includes("upstash_redis_rest")
  ) {
    return "PORTAL_CONFIG_MISSING";
  }
  return null;
}

/**
 * Run a route handler with shared error handling and Sentry capture.
 * Catches anything thrown and returns a normalized 500 JSON body.
 *
 * Behaviour:
 *   - Always captures to Sentry with `portal_route` tag and an `event_id`
 *     header so support can quickly find the trace.
 *   - Detects "missing config" errors (see `classifyConfigError`) and surfaces
 *     `code: PORTAL_CONFIG_MISSING` with the offending env var name so deploy
 *     misconfigurations are obvious in the browser response — these are NEVER
 *     a leak of user data, only of our own env naming.
 *   - For all other errors, includes a short `detail` slice when not running
 *     in production. This makes localhost/preview iteration dramatically
 *     faster without exposing stack traces in prod.
 *
 * The handler can return any `NextResponse` (success or error shapes).
 */
export async function withPortalErrors(
  scopeName: string,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (err) {
    const eventId = captureServerException(err, {
      tags: { portal_route: scopeName },
    });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Portal:${scopeName}]`, err);

    // Mirror the failure to PostHog so error volume per /api/portal/**
    // route shows up alongside funnel events. Never throws — analytics
    // outages must not change response shape. We use a stable synthetic
    // distinct id (`hh:srv-<route-hash>`) because we don't have a
    // signed-in user id in scope here; PostHog still rolls up the event
    // for "api_error" volume insights even without a real Person.
    try {
      if (shouldCapturePostHog()) {
        const ph = getPostHogServer();
        // PostHog is first-party BAA analytics — never consent-gated. Sentry
        // (above) remains the canonical channel for full error context.
        if (ph) {
          // Synthetic per-route distinct id in the `hh:<hex>` opaque
          // shape the rest of the app uses. No PHI — purely derived from
          // the route name.
          const routeHash = createHash("sha256")
            .update(`route:${scopeName}`)
            .digest("hex")
            .slice(0, 32);
          // PHI rule: do NOT send `error.message` to PostHog. Upstream
          // Athena/Stedi/Salesforce error strings frequently embed
          // patient names, MRNs, or claim tokens. Sentry remains the
          // canonical channel for full error context (linked via
          // `sentry_event_id`); PostHog only needs classification +
          // volume signal for funnel correlation.
          ph.capture({
            distinctId: `hh:${routeHash}`,
            event: "api_error",
            properties: {
              portal_route: scopeName,
              error_name: err instanceof Error ? err.name : typeof err,
              config_code: classifyConfigError(message),
              sentry_event_id: eventId,
            },
          });
          // Fire and forget — Vercel functions exit fast.
          void ph.flush().catch(() => {});
        }
      }
    } catch {
      // analytics is best-effort
    }

    const configCode = classifyConfigError(message);
    if (configCode) {
      return portalError({
        status: 500,
        code: configCode,
        message:
          "The portal isn't fully configured. Our team has been notified.",
        retryable: false,
        eventId,
        detail: message,
      });
    }

    return portalError({
      status: 500,
      code: "PORTAL_INTERNAL",
      message:
        "Something went wrong on our side. Please try again in a moment.",
      retryable: true,
      eventId,
      detail: message,
    });
  }
}

/**
 * Parse a JSON request body without throwing on empty/invalid input.
 * Returns `null` if the body is missing or unparseable; the caller decides
 * whether that is a 400 or a benign no-op.
 */
export async function parseJsonBody<T = Record<string, unknown>>(
  request: NextRequest
): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Compute a stable fingerprint for an idempotency lookup.
 * Includes the route name so the same payload to two routes doesn't collide.
 */
export function fingerprint(scope: string, payload: unknown): string {
  const json = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash("sha256")
    .update(`${scope}|${json}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Idempotency guard — call BEFORE doing the side-effecting work.
 *
 * Usage:
 * ```
 * const cached = await idempotencyGet("portal-register-patient", payload);
 * if (cached) return NextResponse.json(cached);
 * // ...do the work...
 * await idempotencySet("portal-register-patient", payload, result, 300);
 * return NextResponse.json(result);
 * ```
 */
export async function idempotencyGet<T>(
  scope: string,
  payload: unknown
): Promise<T | null> {
  const key = `idem:${scope}:${fingerprint(scope, payload)}`;
  return cacheGet<T>(key, { prefix: "portal" });
}

export async function idempotencySet<T>(
  scope: string,
  payload: unknown,
  value: T,
  ttlSeconds = 300
): Promise<void> {
  const key = `idem:${scope}:${fingerprint(scope, payload)}`;
  await cacheSet(key, value, { prefix: "portal", ttl: ttlSeconds });
}
