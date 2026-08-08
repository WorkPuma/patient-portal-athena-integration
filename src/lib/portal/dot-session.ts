/**
 * Dot session store — server-side state for the Retell text-chat agent.
 *
 * Retell `chat_id` doesn't carry our domain context (regToken, athena
 * patient id, picked clinic, last shown slots, etc) across tool calls.
 * We keep it ourselves, keyed by `chat_id`, so each Dot tool invocation
 * can look up the conversation's running state without forcing the LLM
 * to re-pass everything in tool arguments (and without exposing a
 * regToken to the LLM at all).
 *
 * Backed by Upstash Redis (already provisioned for portal cache /
 * idempotency). When Redis is not configured (local dev without
 * UPSTASH_REDIS_REST_*), falls back to an in-process Map so the bot
 * still works during `npm run dev` — but only single-instance.
 */

import { getRedis } from "@/lib/upstash/cache";

const PREFIX = "portal:dot:session";
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour — matches regToken TTL

export interface DotPatientDraft {
  firstName?: string;
  lastName?: string;
  dob?: string; // YYYY-MM-DD
  sex?: string;
  email?: string;
  phone?: string; // E.164
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Selected clinic department id (Athena). */
  departmentId?: number;
  /** Selected clinic slug (e.g. "highland-park"). */
  clinicSlug?: string;
  /** Selected provider id (Athena), or "earliest" sentinel. */
  providerId?: number | "earliest";
  /** Insurance brand label the patient said (e.g. "Blue Cross"). */
  insurancePayorName?: string;
  /** Resolved Athena insurancepackageid the patient picked. */
  insurancePackageId?: number;
  /** Member id / subscriber id used on Athena insurance attach. */
  insuranceMemberId?: string;
  /** Optional group / policy number if provided by the patient. */
  insuranceGroupNumber?: string;
  /** Athena relationship-to-insured id (1=self). */
  relationshipToInsuredId?: number;
  /** Policyholder details when relationship is not self. */
  policyholderFirstName?: string;
  policyholderLastName?: string;
  policyholderDob?: string;
  /**
   * True only when insurance was attached in Athena (not pending/soft).
   * Scheduling tools use this to prevent booking without a usable insurance row.
   */
  insuranceAttached?: boolean;
  /** Count of attach_insurance failures so we only escalate after a retry. */
  insuranceAttachFailures?: number;
}

export interface DotSlotOption {
  appointment_id: number;
  date: string; // MM/DD/YYYY (Athena format)
  time: string; // HH:MM
  provider: string;
  department_id: number | string;
  appointment_type_id: number | string;
}

export interface DotSession {
  chatId: string;
  /** When the user opened the widget (ms epoch). */
  startedAt: number;
  /** regToken minted by /api/portal/register/patient (Bearer). */
  regToken?: string;
  /** Athena patient id (or "pending-..." sentinel). */
  athenaPatientId?: string;
  /** Hint patient id, if Hint was created. */
  hintPatientId?: string;
  /** Booked appointment id once Dot completes booking. */
  bookedAppointmentId?: string | number;
  /** Salesforce Lead Id created at /register/patient — passed to handoff to avoid duplicates. */
  salesforceLeadId?: string;
  /** Last 3-4 slots Dot offered the patient. Indexed [1..N] by Dot. */
  lastSlots?: DotSlotOption[];
  /** Demographics + scheduling preferences collected so far. */
  draft: DotPatientDraft;
  /** Last user-visible error, surfaced to the next assistant turn for context. */
  lastError?: string;
}

function key(chatId: string): string {
  return `${PREFIX}:${chatId}`;
}

// In-process fallback for local dev without Upstash. Module-scoped Map —
// resets on hot reload, which is fine for a developer testing the flow.
const memoryStore = new Map<string, { value: DotSession; expiresAt: number }>();

function memoryGet(chatId: string): DotSession | null {
  const hit = memoryStore.get(key(chatId));
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    memoryStore.delete(key(chatId));
    return null;
  }
  return hit.value;
}

function memorySet(chatId: string, value: DotSession, ttlSeconds: number): void {
  memoryStore.set(key(chatId), {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function newEmpty(chatId: string): DotSession {
  return {
    chatId,
    startedAt: Date.now(),
    draft: {},
  };
}

export async function getDotSession(chatId: string): Promise<DotSession> {
  if (!chatId) return newEmpty(chatId);
  const redis = getRedis();
  if (!redis) {
    return memoryGet(chatId) ?? newEmpty(chatId);
  }
  try {
    const raw = await redis.get<DotSession>(key(chatId));
    if (raw && typeof raw === "object" && "chatId" in raw) {
      return raw;
    }
  } catch (err) {
    console.warn("[DotSession] read error:", err);
  }
  return newEmpty(chatId);
}

/**
 * Replace the session for `chatId`. Use when you have the full new
 * value already merged. Most callers should prefer {@link mergeDotSession}.
 */
export async function setDotSession(
  chatId: string,
  value: DotSession,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
  if (!chatId) return;
  const redis = getRedis();
  if (!redis) {
    memorySet(chatId, value, ttlSeconds);
    return;
  }
  try {
    await redis.set(key(chatId), value, { ex: ttlSeconds });
  } catch (err) {
    console.warn("[DotSession] write error:", err);
  }
}

/**
 * Deep-merge a partial update into the existing session, preserving
 * the `draft` object. Returns the merged session. Use this from Dot
 * tool handlers to keep state edits small and obvious at the call site.
 */
export async function mergeDotSession(
  chatId: string,
  partial: Partial<Omit<DotSession, "chatId" | "draft">> & {
    draft?: Partial<DotPatientDraft>;
  },
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<DotSession> {
  const current = await getDotSession(chatId);
  const merged: DotSession = {
    ...current,
    ...partial,
    chatId,
    draft: { ...current.draft, ...(partial.draft ?? {}) },
  };
  await setDotSession(chatId, merged, ttlSeconds);
  return merged;
}

export async function clearDotSession(chatId: string): Promise<void> {
  if (!chatId) return;
  const redis = getRedis();
  if (!redis) {
    memoryStore.delete(key(chatId));
    return;
  }
  try {
    await redis.del(key(chatId));
  } catch (err) {
    console.warn("[DotSession] delete error:", err);
  }
}
