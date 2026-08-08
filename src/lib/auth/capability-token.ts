/**
 * One-time opaque capability tokens (DEV-4474).
 *
 * Replaces bearer/URL credentials (e.g. a raw appointmentId in a survey
 * URL) with a server-stored, single-use, short-lived, opaque capability.
 *
 * Security model:
 *   - The token is a 32-byte random value, base64url-encoded. It carries
 *     NO claims — the payload (appointmentId, etc.) lives only server-side
 *     in hhv2.capabilities. A leaked token therefore leaks no PHI.
 *   - Only the sha256 hash of the token is stored, so a DB dump cannot
 *     reveal usable tokens.
 *   - Capabilities are single-use: redeem() flips state active -> used
 *     atomically; a second redeem fails.
 *   - Short TTL (default 7 days for surveys; caller can override).
 *   - Lookups by hash are constant-time-ish (indexed PK lookup); the
 *     token itself is never compared in application memory.
 */

import { randomBytes, createHash } from "node:crypto";

export type CapabilityKind = "survey" | "registration" | "schedule";

export interface CapabilityPayload {
  [key: string]: unknown;
}

export interface RedeemedCapability {
  kind: CapabilityKind;
  payload: CapabilityPayload;
}

export class CapabilityError extends Error {
  constructor(
    message: string,
    public reason: "missing" | "invalid" | "expired" | "used" | "unavailable"
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

/** Hash an opaque token to its storage key (sha256 hex). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a new random opaque token (base64url, 43 chars). Not stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

const DEFAULT_TTL_MS: Record<CapabilityKind, number> = {
  survey: 7 * 24 * 60 * 60 * 1000,
  registration: 60 * 60 * 1000,
  schedule: 24 * 60 * 60 * 1000,
};

/**
 * Create + persist a one-time capability. Returns the opaque token (hand
 * to the link generator) — it is never retrievable again.
 */
export async function mintCapability(
  kind: CapabilityKind,
  payload: CapabilityPayload,
  opts: { ttlMs?: number } = {}
): Promise<string> {
  const { mintCapabilityRow } = await import("@/lib/supabase/capability-store");
  const token = generateToken();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS[kind];
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  await mintCapabilityRow({
    tokenHash: hashToken(token),
    kind,
    payload,
    expiresAt,
  });
  return token;
}

/**
 * Verify a capability WITHOUT consuming it (read-only checks: exists,
 * active, not expired). Use redeem() for single-use consumption.
 */
export async function verifyCapability(
  token: string | null | undefined,
  expectedKind: CapabilityKind
): Promise<CapabilityPayload> {
  if (!token) throw new CapabilityError("Missing capability", "missing");
  const { getCapabilityRow } = await import("@/lib/supabase/capability-store");
  const row = await getCapabilityRow(hashToken(token));
  if (!row) throw new CapabilityError("Invalid capability", "invalid");
  if (row.kind !== expectedKind) {
    throw new CapabilityError("Wrong capability kind", "invalid");
  }
  if (row.state === "used") throw new CapabilityError("Capability already used", "used");
  if (row.state === "revoked") throw new CapabilityError("Capability revoked", "invalid");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new CapabilityError("Capability expired", "expired");
  }
  return row.payload as CapabilityPayload;
}

/**
 * Atomically consume a one-time capability: state active -> used. Returns
 * the payload on success. Throws CapabilityError if missing, already used,
 * revoked, or expired.
 */
export async function redeemCapability(
  token: string | null | undefined,
  expectedKind: CapabilityKind
): Promise<RedeemedCapability> {
  if (!token) throw new CapabilityError("Missing capability", "missing");
  const {
    consumeCapabilityRow,
    getCapabilityRow,
  } = await import("@/lib/supabase/capability-store");
  const row = await consumeCapabilityRow(hashToken(token), expectedKind);
  if (row) return { kind: row.kind, payload: row.payload as CapabilityPayload };
  // The atomic consume returned nothing. Determine the REAL reason so the
  // route can return the correct status (409 used / 410 expired / 401
  // invalid) instead of collapsing every failure to "invalid". The consume
  // above is still the race-safe authority for the success path; this read
  // only disambiguates an already-failed attempt.
  const existing = await getCapabilityRow(hashToken(token));
  if (!existing) throw new CapabilityError("Invalid capability", "invalid");
  if (existing.kind !== expectedKind) {
    throw new CapabilityError("Wrong capability kind", "invalid");
  }
  if (existing.state === "used") {
    throw new CapabilityError("Capability already used", "used");
  }
  if (existing.state === "revoked") {
    throw new CapabilityError("Capability revoked", "invalid");
  }
  if (new Date(existing.expires_at).getTime() < Date.now()) {
    throw new CapabilityError("Capability expired", "expired");
  }
  // Row is active + valid but the conditional update didn't fire — a
  // concurrent redeem raced us. Treat as already used.
  throw new CapabilityError("Capability already used", "used");
}
