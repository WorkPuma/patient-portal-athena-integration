import type { User } from "@clerk/nextjs/server";

export interface ResolvedPatientIdentity {
  resolver: string;
  empiGoldenId?: string;
  sfContactId?: string;
  athenaPatientId?: string;
  hintPatientId?: string;
  matchScore?: number;
  dob?: string;
}

interface UpstashVectorMatch {
  id?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

function normalizeEmail(input: string | undefined): string {
  return (input || "").trim().toLowerCase();
}

function normalizePhone(input: string | undefined): string {
  return (input || "").replace(/\D/g, "");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractEmail(user: User): string {
  const primary = user.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId
  );
  return normalizeEmail(primary?.emailAddress);
}

function extractPhone(user: User): string {
  const primary = user.phoneNumbers.find(
    (p) => p.id === user.primaryPhoneNumberId
  );
  return normalizePhone(primary?.phoneNumber);
}

function getString(metadata: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = asString(metadata[key]);
    if (value) return value;
  }
  return "";
}

function parseMatch(match: UpstashVectorMatch): ResolvedPatientIdentity | null {
  const metadata = (match.metadata || {}) as Record<string, unknown>;
  const athenaPatientId = getString(
    metadata,
    "athena_id_patient_portal",
    "athena_id",
    "athenaPatientId"
  );
  const sfContactId = getString(metadata, "salesforce_id", "sf_contact_id");
  const hintPatientId = getString(metadata, "hint_id", "hintPatientId");
  const empiGoldenId = asString(match.id) || getString(metadata, "golden_id");

  if (!athenaPatientId && !sfContactId && !hintPatientId && !empiGoldenId) {
    return null;
  }

  return {
    resolver: "upstash_vector",
    empiGoldenId,
    sfContactId,
    athenaPatientId,
    hintPatientId,
    matchScore: Number(match.score || 0),
    dob: getString(metadata, "dob"),
  };
}

async function queryUpstashVector(
  email: string,
  phone: string
): Promise<UpstashVectorMatch[]> {
  const baseUrl = process.env.EMPI_VECTOR_URL?.trim();
  const token = process.env.EMPI_VECTOR_TOKEN?.trim();
  if (!baseUrl || !token) return [];

  const searchParts = [phone, email].filter(Boolean);
  if (searchParts.length === 0) return [];

  const url = `${baseUrl.replace(/\/+$/, "")}/query-data`;
  const payload: Record<string, unknown> = {
    data: searchParts.join(" "),
    topK: 5,
    includeMetadata: true,
    filter: "is_test_patient = false",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `EMPI vector query failed (${res.status}): ${body.slice(0, 300)}`
    );
  }

  const json = (await res.json()) as { result?: UpstashVectorMatch[] };
  return json.result || [];
}

async function resolveViaUpstashVector(
  email: string,
  phone: string
): Promise<ResolvedPatientIdentity | null> {
  const minScore = Number(process.env.EMPI_VECTOR_MIN_SCORE || "0.008");
  const matches = await queryUpstashVector(email, phone);
  const best = matches[0];
  if (!best || Number(best.score || 0) < minScore) return null;
  return parseMatch(best);
}

/**
 * Returns all EMPI candidates above the minimum score threshold.
 * Used for disambiguation when shared contacts (phone/email) resolve
 * to multiple golden records (~1% of patients).
 */
export async function resolveAllCandidatesForUser(
  user: User
): Promise<ResolvedPatientIdentity[]> {
  const email = extractEmail(user);
  const phone = extractPhone(user);
  const minScore = Number(process.env.EMPI_VECTOR_MIN_SCORE || "0.008");

  const matches = await queryUpstashVector(email, phone);
  return matches
    .filter((m) => Number(m.score || 0) >= minScore)
    .map(parseMatch)
    .filter((r): r is ResolvedPatientIdentity => r !== null);
}

/**
 * Filters candidates by DOB (YYYY-MM-DD) and returns the matching identity.
 */
export async function resolveByDobForUser(
  user: User,
  dob: string
): Promise<ResolvedPatientIdentity | null> {
  const candidates = await resolveAllCandidatesForUser(user);
  const matched = candidates.filter((c) => c.dob === dob);
  if (matched.length === 1) return matched[0];
  return null;
}

export async function resolvePatientIdentityForUser(
  user: User
): Promise<ResolvedPatientIdentity | null> {
  const email = extractEmail(user);
  const phone = extractPhone(user);

  try {
    return await resolveViaUpstashVector(email, phone);
  } catch (error) {
    console.error("[Portal] EMPI resolution error:", error);
    return null;
  }
}

export function getNormalizedContactForUser(user: User): {
  email: string;
  phone: string;
} {
  return { email: extractEmail(user), phone: extractPhone(user) };
}
