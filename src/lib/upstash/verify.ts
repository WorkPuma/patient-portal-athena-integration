/**
 * QStash signature verification for inbound queue worker requests.
 *
 * Every QStash delivery includes an `Upstash-Signature` JWT signed with
 * the project's current/next signing keys (rotated by Upstash). Without
 * verification the queue routes (`/api/portal/queue/*`) are accessible
 * to anyone who guesses the URL, which would let them:
 *   - send arbitrary email through our Resend identity (queue/send-email)
 *   - create Salesforce Cases against any ContactId (queue/salesforce-case)
 *
 * Required env (production):
 *   UPSTASH_QSTASH_CURRENT_SIGNING_KEY
 *   UPSTASH_QSTASH_NEXT_SIGNING_KEY
 *
 * Falls back to the Upstash-default names (`QSTASH_CURRENT_SIGNING_KEY` /
 * `QSTASH_NEXT_SIGNING_KEY`) for compatibility with the @upstash/qstash
 * SDK's bare-name convention.
 *
 * Set `QSTASH_VERIFY_SIGNATURE=0` to skip verification (local dev/preview
 * where QStash isn't configured and the queue helper falls back to a
 * synchronous in-process fetch — see src/lib/upstash/queue.ts).
 */

import { Receiver } from "@upstash/qstash";

export interface QStashVerifyResult {
  ok: boolean;
  reason?:
  | "missing_header"
  | "missing_keys"
  | "invalid_signature"
  | "skipped";
}

let cachedReceiver: Receiver | null = null;

function getReceiver(): Receiver | null {
  if (cachedReceiver) return cachedReceiver;
  const currentSigningKey =
    process.env.UPSTASH_QSTASH_CURRENT_SIGNING_KEY ||
    process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey =
    process.env.UPSTASH_QSTASH_NEXT_SIGNING_KEY ||
    process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) return null;
  cachedReceiver = new Receiver({ currentSigningKey, nextSigningKey });
  return cachedReceiver;
}

/**
 * Verify a QStash-signed request. Pass the raw request body string and
 * the request URL exactly as QStash sees it (including protocol + host).
 */
export async function verifyQStashSignature(
  rawBody: string,
  signature: string | null,
  url: string
): Promise<QStashVerifyResult> {
  if (process.env.QSTASH_VERIFY_SIGNATURE === "0") {
    return { ok: true, reason: "skipped" };
  }
  if (!signature) return { ok: false, reason: "missing_header" };

  const receiver = getReceiver();
  if (!receiver) return { ok: false, reason: "missing_keys" };

  try {
    const ok = await receiver.verify({
      signature,
      body: rawBody,
      url,
    });
    return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}

/**
 * Hard-fail on missing/invalid signature unless explicitly opted out.
 *
 * Security note (incident 2026-05): this previously enforced ONLY when
 * `VERCEL_ENV === "production"`. That left every preview/staging
 * deployment as an unauthenticated mail relay (via `queue/send-email`,
 * which carries the real `RESEND_API_KEY` on `noreply@example-patient-portal.com`)
 * AND an anonymous Salesforce Case-creation endpoint (via
 * `queue/salesforce-case` bound to HH_UAT). Brand-impersonation /
 * spam-from-our-identity for the lifetime that staging was reachable.
 *
 * The new posture is fail-closed: signatures are enforced everywhere
 * unless `QSTASH_VERIFY_SIGNATURE=0` is explicitly set. Local dev and
 * any deploy that genuinely needs to run the in-process fallback (no
 * `UPSTASH_QSTASH_TOKEN`) must opt out by name and acknowledge the
 * risk. Production never sets `QSTASH_VERIFY_SIGNATURE=0`.
 */
export function shouldEnforceQStashSignature(): boolean {
  return process.env.QSTASH_VERIFY_SIGNATURE !== "0";
}
