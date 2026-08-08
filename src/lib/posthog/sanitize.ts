/**
 * PHI/PII safety belt for PostHog telemetry.
 *
 * PostHog is BAA-covered for Herself Health, but the principle of least
 * privilege still applies: we send opaque identifiers and categorical
 * properties only. This module is the single runtime enforcement point
 * for that policy and is consumed by every PostHog call path:
 *
 *   - PostHogProvider.tsx (browser identify)
 *   - lib/posthog/events.ts (typed client capture)
 *   - lib/posthog/server.ts (server capture)
 *
 * Defense-in-depth on top of the SDK-level `mask_personal_data_properties`
 * + `mask_all_element_attributes` configured in instrumentation-client.ts.
 *
 * Salt: NEXT_PUBLIC_POSTHOG_ID_SALT (Infisical `telos` project). When
 * absent we still produce a hash, but a non-rotatable per-deploy fallback
 * is used so the salt doesn't silently default in prod.
 *
 * ⚠️ PRIVACY LIMITATION (CodeAnt .env.example:84): the salt is `NEXT_PUBLIC_`,
 * so it ships in the browser bundle and is therefore NOT secret. A public salt
 * does not stop an actor with access to PostHog's `hh:<hex>` distinct ids from
 * brute-forcing the (small, sequential) Athena-PID space to re-identify
 * patients. It is `NEXT_PUBLIC_` because `hashToOpaqueDistinctId` runs in the
 * browser too (`usePostHogIdentity.ts`, the pre-claim anonymous→identity
 * bridge), and the client + server hashes MUST match to land on one Person —
 * so a server-only salt would break identity stitching unless the hashing also
 * moves server-side.
 *
 * TODO(privacy, TIC): move ALL identity hashing server-side and deliver the
 * resulting `hh:<hex>` to the client via a trusted channel (e.g. write it to
 * Clerk publicMetadata at claim time, or a small authenticated endpoint), then
 * rename the salt to the server-only `POSTHOG_ID_SALT`. Until then the salt
 * provides defense-in-depth only, NOT cryptographic secrecy. (Note: the raw
 * Athena PID is already client-readable via Clerk publicMetadata, so the salt
 * being public does not expose anything new for the visitor's OWN id — the
 * residual risk is bulk re-identification on the PostHog side.)
 */

import { isValidAnonId } from "./anon-id";

/**
 * Property keys that must never leave the app. Sanitization is
 * case-insensitive and matches both camelCase and snake_case variants.
 * Add to this list as new PHI/PII surfaces appear — never remove.
 */
export const BLOCKED_PROPERTY_KEYS: ReadonlySet<string> = new Set(
  [
    // Direct identifiers
    "email",
    "emailaddress",
    "phone",
    "phonenumber",
    "mobilephone",
    "homephone",
    "firstname",
    "lastname",
    "middlename",
    "fullname",
    "name",
    "patientname",
    "dob",
    "dateofbirth",
    "birthdate",
    "ssn",
    "socialsecuritynumber",
    // Address
    "address",
    "address1",
    "address2",
    "street",
    "streetaddress",
    "city",
    "zip",
    "zipcode",
    "postalcode",
    // Insurance / clinical identifiers
    "mrn",
    "memberid",
    "membernumber",
    "subscriberid",
    "subscribernumber",
    "groupnumber",
    "policynumber",
    "mbi",
    "medicareid",
    "medicaidid",
    "athenapatientid",
    "patientid",
    // Free-text fields that historically have carried PHI by accident
    "notes",
    "chiefcomplaint",
    "reasonforvisit",
  ].map((k) => k.toLowerCase())
);

function normalizeKey(key: string): string {
  // Lower-case + strip underscores so `member_id` and `memberId` both
  // collapse to `memberid` for the blocklist comparison.
  return key.toLowerCase().replace(/_/g, "");
}

/**
 * Strip any property whose key matches the blocklist. Mutating-style
 * sanitize would be slightly faster, but every caller passes a fresh
 * literal so the copy is cheap and the return-a-new-object shape is
 * less surprising. Returns an empty object when given undefined.
 */
export function sanitizeProperties(
  properties?: Record<string, unknown>
): Record<string, unknown> {
  if (!properties) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (BLOCKED_PROPERTY_KEYS.has(normalizeKey(key))) {
      if (process.env.NODE_ENV !== "production") {

        console.warn(
          `[posthog/sanitize] dropped blocked property key "${key}"`
        );
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Opaque distinctId shape we allow PostHog to see. Anything else gets
 * rejected by `assertOpaqueDistinctId`. Keep this regex narrow so that
 * any future drift in identifier shape is loud at runtime.
 *
 * Also accepts the first-party anonymous visitor UUID (`hh_did`) so
 * server-side conversion events stitch to middleware / browser pageviews.
 */
const OPAQUE_DISTINCT_ID_PATTERN = /^(user_[A-Za-z0-9]+|hh:[a-f0-9]{16,64})$/;

export function isOpaqueDistinctId(distinctId: string): boolean {
  if (OPAQUE_DISTINCT_ID_PATTERN.test(distinctId)) return true;
  return isValidAnonId(distinctId);
}

/**
 * Throws (via console + early return upstream) when an obviously PHI-
 * shaped identifier is about to be sent to PostHog. The patterns here
 * are intentionally conservative — we'd rather drop a legitimate event
 * than identify a person by a raw Athena PID or an email.
 */
export function assertOpaqueDistinctId(distinctId: string): boolean {
  if (isOpaqueDistinctId(distinctId)) return true;
  if (process.env.NODE_ENV !== "production") {

    console.error(
      `[posthog/sanitize] rejected non-opaque distinctId "${distinctId}" — ` +
      "use Clerk user id (user_*) or hh:<sha256-hex> only"
    );
  }
  return false;
}

const ID_SALT =
  // NOTE: this salt is NOT secret — it is `NEXT_PUBLIC_` because the same
  // hash runs in the browser (see the PRIVACY LIMITATION + TODO in the module
  // header). It raises the bar for casual re-identification and is rotatable
  // on incident, but is not a cryptographic key. Do NOT rely on it for secrecy.
  (typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_POSTHOG_ID_SALT) ||
  "portal-analytics-salt"; // fallback only — set the env var in Infisical

/**
 * Hash a raw identifier (e.g. Athena patient id) into the opaque
 * `hh:<hex>` shape PostHog accepts. Uses Web Crypto, which is available
 * in every browser we support AND in Node 18+ (which is our minimum
 * runtime), so a single code path covers both client and server.
 *
 * Throws if `globalThis.crypto.subtle` is missing — caller should treat
 * that as "drop the identify" rather than fall through to a raw ID.
 */
export async function hashToOpaqueDistinctId(rawId: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "hashToOpaqueDistinctId: Web Crypto SubtleCrypto unavailable in this runtime"
    );
  }
  const input = `${ID_SALT}:${rawId}`;
  const data = new TextEncoder().encode(input);
  const buf = await subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `hh:${hex}`;
}
