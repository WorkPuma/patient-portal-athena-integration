/**
 * Schedule-link store: opaque tokens + Redis single-use enforcement.
 *
 * Mint creates an opaque token, persists claims in Supabase
 * (`portal_schedule_links`), and registers the token in Redis as "active".
 * The standalone scheduler may READ the session as many times as it likes,
 * but the moment a booking/reschedule succeeds we transition Redis to
 * "used" (and best-effort mark Supabase used) so the link cannot be replayed.
 *
 * The Redis transition uses a single atomic `SET key "used" XX GET` so
 * two concurrent bookings (double tap, refresh) can't both win:
 *   - prev "active" → we won the race, booking proceeds, link burned.
 *   - prev "used"   → someone already booked, reject.
 *   - prev null     → XX failed: the key never existed or already expired
 *                     (unknown/expired link), reject.
 *
 * Redis is the security control for consume races. If Redis is unconfigured
 * we fail CLOSED for consume so a misconfigured deploy can't silently make
 * every link infinitely reusable. Mint also hard-fails if Supabase or Redis
 * cannot store the new token.
 */

import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/upstash/cache";
import {
  deleteScheduleLinkRecord,
  insertScheduleLinkRecord,
  markScheduleLinkActive,
  markScheduleLinkUsed,
  type CreateScheduleLinkInput,
  type ScheduleLinkRecord,
} from "@/lib/scheduling/schedule-link-records";

const PREFIX = "portal:schedule-link";

/** Opaque token entropy — 32 bytes → ~43 char base64url, unguessable. */
const OPAQUE_TOKEN_BYTES = 32;

export type LinkState = "active" | "used" | "missing";

/** Pure decision helper (unit-tested): can a link in `state` be consumed? */
export function canConsume(state: LinkState): boolean {
  return state === "active";
}

/** Map the value returned by Redis into a LinkState. */
export function toLinkState(raw: string | null | undefined): LinkState {
  if (raw === "active") return "active";
  if (raw === "used") return "used";
  return "missing";
}

function key(token: string): string {
  return `${PREFIX}:${token}`;
}

export function generateOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
}

/**
 * Register a freshly minted token as single-use. NX so we never clobber an
 * existing record (defends against a recycled token). Returns false when
 * Redis is unavailable so the mint route can surface a hard error rather
 * than hand out a link with no replay protection.
 */
export async function registerLink(
  token: string,
  ttlSeconds: number
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await redis.set(key(token), "active", {
      ex: ttlSeconds,
      nx: true,
    });
    return res === "OK";
  } catch (err) {
    console.warn("[schedule-link] registerLink error:", err);
    return false;
  }
}

/**
 * Mint an opaque schedule link: Supabase row + Redis active registration.
 * Returns null when either store fails (caller should 503).
 */
export async function createScheduleLink(
  input: Omit<CreateScheduleLinkInput, "expiresAt"> & { ttlSeconds: number }
): Promise<{ token: string; record: ScheduleLinkRecord; expiresAt: number } | null> {
  const ttlSeconds = input.ttlSeconds;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = generateOpaqueToken();

  const record = await insertScheduleLinkRecord(token, {
    athenaPatientId: input.athenaPatientId,
    salesforceAccountId: input.salesforceAccountId,
    departmentId: input.departmentId,
    phone: input.phone,
    firstName: input.firstName,
    expiresAt,
    createdBy: input.createdBy,
    metadata: input.metadata,
  });
  if (!record) return null;

  const registered = await registerLink(token, ttlSeconds);
  if (!registered) {
    await deleteScheduleLinkRecord(token);
    return null;
  }

  return { token, record, expiresAt };
}

/** Read the current state of a link without modifying it. */
export async function getLinkState(token: string): Promise<LinkState> {
  const redis = getRedis();
  // When Redis is down we can't prove the link is valid; reads degrade to
  // "active" so the patient can still see the scheduler, but `consumeLink`
  // (below) is the real gate and fails closed.
  if (!redis) return "active";
  try {
    const raw = await redis.get<string>(key(token));
    return toLinkState(raw);
  } catch (err) {
    console.warn("[schedule-link] getLinkState error:", err);
    return "active";
  }
}

/**
 * Restore a burned link to "active" — used when a booking attempt failed
 * with a recoverable error (e.g. the slot was just taken) so the patient
 * can pick another time without needing a brand-new link. `ttlSeconds`
 * should be the token's remaining lifetime.
 */
export async function reactivateLink(
  token: string,
  ttlSeconds: number
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key(token), "active", { ex: Math.max(60, ttlSeconds) });
  } catch (err) {
    console.warn("[schedule-link] reactivateLink error:", err);
  }
  // Best-effort durable restore so resolve/other apps see active again.
  void markScheduleLinkActive(token);
}

export interface ConsumeResult {
  ok: boolean;
  /** State observed at consume time — drives the error message. */
  state: LinkState;
}

/**
 * Atomically burn a link. Only succeeds when the token was "active".
 * Fails closed when Redis is unavailable. On success, best-effort marks
 * the Supabase row used.
 */
export async function consumeLink(token: string): Promise<ConsumeResult> {
  const redis = getRedis();
  if (!redis) return { ok: false, state: "missing" };
  try {
    // SET key "used" XX GET → returns the previous value (or null if XX
    // failed because the key was absent/expired). One round-trip, atomic.
    const prev = (await redis.set(key(token), "used", {
      xx: true,
      get: true,
    })) as string | null;
    const prevState = toLinkState(prev);
    if (prevState === "active") {
      void markScheduleLinkUsed(token);
      return { ok: true, state: "active" };
    }
    return { ok: false, state: prevState };
  } catch (err) {
    console.warn("[schedule-link] consumeLink error:", err);
    return { ok: false, state: "missing" };
  }
}
