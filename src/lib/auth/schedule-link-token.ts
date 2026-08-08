/**
 * Schedule-Link Token — LEGACY HS256 JWT path.
 *
 * New mints issue opaque tokens stored in Supabase + Redis (see
 * schedule-link-store.createScheduleLink). This module remains only so
 * in-flight SMS links that still carry a JWT (`/schedule?t=eyJ...`) can
 * verify until they expire.
 *
 * Do not call `mintScheduleLinkToken` from production mint routes.
 *
 * Historical security model (still applies to legacy links):
 *   - HS256 with SCHEDULE_LINK_SECRET (>= 32 chars).
 *   - Short TTL (default 72h).
 *   - Audience pinned to "portal-schedule-link".
 *   - `jti` registered in Redis at mint and burned after booking.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { randomUUID } from "node:crypto";

const ALG = "HS256";
const ISSUER = "patient-portal-example";
const AUDIENCE = "portal-schedule-link";
/** 72 hours — covers "sent last night, opened tomorrow morning". */
const DEFAULT_TTL_SECONDS = 72 * 60 * 60;

export interface ScheduleLinkClaims {
  /** Athena patient id the link is scoped to (book/read on this chart only). */
  athenaPatientId: string;
  /** Salesforce Account (PersonAccount) id — used for tier/eligibility reads + booking write-back. */
  salesforceAccountId?: string;
  /** Preferred Athena department id (clinic) to default the scheduler to. */
  departmentId?: number;
  /** E.164 mobile phone — carried for the booking audit row (never shown). */
  phone?: string;
  /** First name for a friendly greeting (NOT used for identity). */
  firstName?: string;
  /**
   * Single-use token id. Registered in Redis at mint and burned after a
   * successful booking/reschedule so the link cannot be replayed.
   */
  jti: string;
}

export interface VerifiedScheduleLinkToken extends ScheduleLinkClaims {
  /** Seconds since epoch when the token expires. */
  exp: number;
  /** Seconds since epoch when the token was issued. */
  iat: number;
}

function getSecret(): Uint8Array {
  const secret = process.env.SCHEDULE_LINK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SCHEDULE_LINK_SECRET is missing or shorter than 32 characters"
    );
  }
  return new TextEncoder().encode(secret);
}

export class ScheduleLinkTokenError extends Error {
  constructor(
    message: string,
    public reason: "missing" | "expired" | "invalid"
  ) {
    super(message);
    this.name = "ScheduleLinkTokenError";
  }
}

/**
 * @deprecated New links use opaque tokens via createScheduleLink.
 * Kept for unit tests and any transitional tooling.
 */
export async function mintScheduleLinkToken(
  claims: Omit<ScheduleLinkClaims, "jti"> & { jti?: string },
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const secret = getSecret();
  const jti = claims.jti ?? randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = await new SignJWT({ ...claims, jti })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
  return { token, jti, expiresAt };
}

export async function verifyScheduleLinkToken(
  token: string | null | undefined
): Promise<VerifiedScheduleLinkToken> {
  if (!token) {
    throw new ScheduleLinkTokenError("Missing schedule link token", "missing");
  }

  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });

    const required = ["athenaPatientId", "jti"] as const;
    for (const key of required) {
      if (payload[key] === undefined || payload[key] === null) {
        throw new ScheduleLinkTokenError(
          `Token missing required claim: ${key}`,
          "invalid"
        );
      }
    }

    return payload as unknown as VerifiedScheduleLinkToken;
  } catch (err) {
    if (err instanceof ScheduleLinkTokenError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new ScheduleLinkTokenError("Schedule link token expired", "expired");
    }
    throw new ScheduleLinkTokenError("Invalid schedule link token", "invalid");
  }
}

export const SCHEDULE_LINK_DEFAULT_TTL_SECONDS = DEFAULT_TTL_SECONDS;
