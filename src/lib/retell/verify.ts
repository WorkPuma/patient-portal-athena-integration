/**
 * Retell-Signature verification for inbound tool/webhook requests.
 *
 * Retell signs every server-to-tool request with HMAC-SHA256 over the raw
 * request body using your account's API key as the secret, and sends the
 * hex digest in the `X-Retell-Signature` header (Retell SDK v5 docs:
 * https://docs.retellai.com/api-references/api-references/agent/web-call/api).
 *
 * Without verification, anyone who guesses the public tool URL could
 * impersonate Retell and trigger Athena patient creates, insurance
 * attaches, or appointment bookings. The header check is cheap and
 * brings the surface area down to "Retell + whoever holds the API key".
 *
 * Optional override: set `RETELL_WEBHOOK_SECRET` to a different secret
 * (e.g. when rotating keys, or when Retell requires a per-agent secret).
 * Falls back to `RETELL_API_KEY` so the default deploy "just works".
 *
 * Set `RETELL_VERIFY_SIGNATURE=0` to skip verification (local dev with
 * ngrok where the body bytes get re-encoded by the tunnel, etc).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyResult {
  ok: boolean;
  reason?: "missing_header" | "missing_secret" | "mismatch" | "skipped";
}

const HEADER_NAMES = [
  "x-retell-signature",
  "retell-signature",
  "x-retellai-signature",
];

function getSecret(): string | undefined {
  return process.env.RETELL_WEBHOOK_SECRET || process.env.RETELL_API_KEY;
}

function readSignature(headers: Headers): string | null {
  for (const name of HEADER_NAMES) {
    const v = headers.get(name);
    if (v) return v.trim();
  }
  return null;
}

function constantTimeEqualsHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a Retell-signed request body against the X-Retell-Signature header.
 *
 * Pass the *raw* request body bytes (or string) — Retell signs the bytes
 * sent on the wire, not the JSON-parsed object. Call sites should
 * `await request.text()` first and parse JSON themselves.
 */
export function verifyRetellSignature(
  rawBody: string,
  headers: Headers
): VerifyResult {
  if (process.env.RETELL_VERIFY_SIGNATURE === "0") {
    return { ok: true, reason: "skipped" };
  }

  const sig = readSignature(headers);
  if (!sig) return { ok: false, reason: "missing_header" };

  const secret = getSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Retell's docs show the signature as a plain hex digest. Some clients
  // prepend "sha256=" — strip both forms before comparing.
  const provided = sig.replace(/^sha256=/i, "");

  if (!constantTimeEqualsHex(expected, provided)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/**
 * Should we hard-fail on a bad/missing signature? In production: yes.
 * In preview / non-prod we accept unsigned bodies so an engineer can
 * curl the endpoint while iterating.
 */
export function shouldEnforceRetellSignature(): boolean {
  if (process.env.RETELL_VERIFY_SIGNATURE === "0") return false;
  if (process.env.RETELL_VERIFY_SIGNATURE === "1") return true;
  // Default: enforce only in production. Preview deploys + local dev get
  // a permissive mode so the bot is testable without setting the secret.
  return process.env.VERCEL_ENV === "production";
}
