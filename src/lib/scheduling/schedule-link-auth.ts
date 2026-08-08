/**
 * Auth helpers for the schedule-link endpoints.
 *
 * Two distinct trust boundaries:
 *
 *  1. Server-to-server (/mint and /resolve): Salesforce or other apps call
 *     after verifying the patient. We authenticate that caller with a shared
 *     secret, accepting EITHER:
 *       - an HMAC-SHA256 of the raw body in `X-Schedule-Link-Signature`
 *         (preferred; mirrors the Retell verify pattern), OR
 *       - a static bearer in `X-Schedule-Link-Key` equal to the secret
 *         (simpler for a Salesforce Named Credential custom header).
 *     Both compare against `SCHEDULE_LINK_API_KEY` in constant time.
 *
 *  2. Patient-facing endpoints (session/available/book/reschedule) are
 *     authenticated by the opaque schedule-link token itself (Supabase
 *     record + Redis single-use). Legacy JWTs still verify via
 *     schedule-link-token.ts until they expire.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Result of verifying a minted schedule-link token for API handlers. */
export interface MintVerifyResult {
  ok: boolean;
  reason?: "missing_secret" | "missing_credential" | "mismatch" | "skipped";
}

function getMintSecret(): string | undefined {
  return process.env.SCHEDULE_LINK_API_KEY;
}

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still run a compare to avoid early-exit timing, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the mint caller (Salesforce). Pass the RAW request body bytes so
 * the HMAC matches what the caller signed.
 */
export function verifyMintCaller(
  rawBody: string,
  headers: Headers
): MintVerifyResult {
  const secret = getMintSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  // Preferred: HMAC over the raw body.
  const sig = headers.get("x-schedule-link-signature");
  if (sig) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const provided = sig.trim().replace(/^sha256=/i, "");
    return safeEqual(expected, provided)
      ? { ok: true }
      : { ok: false, reason: "mismatch" };
  }

  // Fallback: static shared key header (easy Named Credential setup).
  const key = headers.get("x-schedule-link-key");
  if (key) {
    return safeEqual(key.trim(), secret)
      ? { ok: true }
      : { ok: false, reason: "mismatch" };
  }

  return { ok: false, reason: "missing_credential" };
}

/**
 * Whether to hard-fail an unauthenticated mint request.
 *
 * Order of precedence:
 *  1. Explicit override via SCHEDULE_LINK_ENFORCE_AUTH=1/0.
 *  2. Enforce whenever a key is configured — once SCHEDULE_LINK_API_KEY is
 *     set (staging/preview/prod), the endpoint must require it. Leaving it
 *     unauthenticated just because VERCEL_ENV !== "production" would let
 *     anyone mint patient-scoped tokens against a deployed preview.
 *  3. Always enforce in production as a backstop.
 *  4. Otherwise permissive (local/preview with no secret set) so engineers
 *     can curl the endpoint while wiring up the Salesforce side.
 */
export function shouldEnforceMintAuth(): boolean {
  if (process.env.SCHEDULE_LINK_ENFORCE_AUTH === "0") return false;
  if (process.env.SCHEDULE_LINK_ENFORCE_AUTH === "1") return true;
  if (process.env.SCHEDULE_LINK_API_KEY) return true;
  return process.env.VERCEL_ENV === "production";
}
