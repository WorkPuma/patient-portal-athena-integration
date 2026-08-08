/**
 * Route-side guard for the patient-facing schedule-link endpoints.
 *
 * Resolves an opaque token from Supabase (preferred) OR a legacy HS256 JWT
 * still in circulation from older SMS links. Also checks single-use state
 * in Redis. Mirrors `requireRegistrationToken` ergonomics: returns the
 * verified claims, or a ready-to-return `NextResponse`.
 */

import { NextResponse } from "next/server";
import {
  ScheduleLinkTokenError,
  verifyScheduleLinkToken,
  type VerifiedScheduleLinkToken,
} from "@/lib/auth/schedule-link-token";
import {
  getScheduleLinkRecord,
  type ScheduleLinkStatus,
} from "@/lib/scheduling/schedule-link-records";
import { getLinkState } from "@/lib/scheduling/schedule-link-store";
import { toPositiveInt } from "@/lib/scheduling/numeric";

export interface ScheduleLinkSession {
  /** Opaque token (or legacy JWT jti) used as the Redis single-use key. */
  jti: string;
  /** Raw credential from the request (opaque token or legacy JWT). */
  token: string;
  athenaPatientId: string;
  salesforceAccountId?: string;
  departmentId?: number;
  phone?: string;
  firstName?: string;
  /** Unix seconds expiry. */
  exp: number;
  iat: number;
  /** Durable status when resolved from Supabase (opaque tokens). */
  status?: ScheduleLinkStatus;
  /** Numeric Athena patient id parsed from the claim. */
  patientIdNum: number;
}

function tokenErrorResponse(reason: "missing" | "expired" | "invalid"): NextResponse {
  const message =
    reason === "expired"
      ? "This scheduling link has expired. Please contact our care team for a new one."
      : "We couldn't verify this scheduling link. Please contact our care team for a new one.";
  return NextResponse.json(
    { ok: false, code: `SCHEDULE_LINK_${reason.toUpperCase()}`, error: message },
    { status: reason === "expired" ? 410 : 401 }
  );
}

/** Compact JWTs are three base64url segments; opaque tokens are a single segment. */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

async function resolveOpaqueSession(
  token: string
): Promise<ScheduleLinkSession | NextResponse> {
  const record = await getScheduleLinkRecord(token);
  if (!record) {
    // DB miss: could be unknown token OR Supabase down. Treat as invalid —
    // we never mint without a durable row.
    return tokenErrorResponse("invalid");
  }

  const now = Math.floor(Date.now() / 1000);
  if (record.expiresAt <= now) {
    return tokenErrorResponse("expired");
  }
  if (record.status === "revoked") {
    return tokenErrorResponse("invalid");
  }

  const patientIdNum = toPositiveInt(
    String(record.athenaPatientId).replace(/\s+/g, "")
  );
  if (patientIdNum == null) {
    return NextResponse.json(
      { ok: false, code: "SCHEDULE_LINK_INVALID", error: "Invalid patient on link" },
      { status: 400 }
    );
  }

  return {
    token,
    jti: record.token,
    athenaPatientId: record.athenaPatientId,
    salesforceAccountId: record.salesforceAccountId,
    departmentId: record.departmentId,
    phone: record.phone,
    firstName: record.firstName,
    exp: record.expiresAt,
    iat: record.createdAt,
    status: record.status,
    patientIdNum,
  };
}

async function resolveLegacyJwtSession(
  token: string
): Promise<ScheduleLinkSession | NextResponse> {
  let claims: VerifiedScheduleLinkToken;
  try {
    claims = await verifyScheduleLinkToken(token);
  } catch (err) {
    if (err instanceof ScheduleLinkTokenError) return tokenErrorResponse(err.reason);
    return tokenErrorResponse("invalid");
  }

  const patientIdNum = toPositiveInt(
    String(claims.athenaPatientId).replace(/\s+/g, "")
  );
  if (patientIdNum == null) {
    return NextResponse.json(
      { ok: false, code: "SCHEDULE_LINK_INVALID", error: "Invalid patient on link" },
      { status: 400 }
    );
  }

  return {
    token,
    jti: claims.jti,
    athenaPatientId: claims.athenaPatientId,
    salesforceAccountId: claims.salesforceAccountId,
    departmentId: claims.departmentId,
    phone: claims.phone,
    firstName: claims.firstName,
    exp: claims.exp,
    iat: claims.iat,
    patientIdNum,
  };
}

/**
 * Verify a token from the request body. When `requireUnused` is true the
 * link's Redis state must still be "active" (rejects already-used links);
 * the booking/reschedule routes set this, while the read-only session route
 * does not (a used link can still show a friendly "already booked" screen).
 *
 * For opaque tokens we also reject when Supabase status is already `used`
 * (covers resolve/other-app visibility after Redis TTL expiry).
 */
export async function requireScheduleLinkToken(
  token: string | null | undefined,
  opts: { requireUnused?: boolean } = {}
): Promise<ScheduleLinkSession | NextResponse> {
  if (!token || !token.trim()) {
    return tokenErrorResponse("missing");
  }
  const trimmed = token.trim();

  const session = looksLikeJwt(trimmed)
    ? await resolveLegacyJwtSession(trimmed)
    : await resolveOpaqueSession(trimmed);
  if (!isScheduleLinkSession(session)) return session;

  if (opts.requireUnused) {
    // Opaque path: durable status is authoritative when Redis key expired.
    if (session.status === "used") {
      return NextResponse.json(
        {
          ok: false,
          code: "SCHEDULE_LINK_USED",
          error: "This scheduling link has already been used.",
        },
        { status: 409 }
      );
    }

    const state = await getLinkState(session.jti);
    if (state === "used") {
      return NextResponse.json(
        {
          ok: false,
          code: "SCHEDULE_LINK_USED",
          error: "This scheduling link has already been used.",
        },
        { status: 409 }
      );
    }
    if (state === "missing") {
      return tokenErrorResponse("expired");
    }
  }

  return session;
}

/** Type guard: true when the guard returned verified claims. */
export function isScheduleLinkSession(
  result: ScheduleLinkSession | NextResponse
): result is ScheduleLinkSession {
  return (
    typeof result === "object" &&
    result !== null &&
    "athenaPatientId" in result &&
    "jti" in result &&
    "patientIdNum" in result
  );
}
