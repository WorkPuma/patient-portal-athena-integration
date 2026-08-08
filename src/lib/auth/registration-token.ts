/**
 * Registration Token (regToken) — short-lived signed JWT issued at the start
 * of the no-account portal registration flow.
 *
 * Carries the freshly created Athena patient id and (optionally) Hint patient
 * id between the unauthenticated registration steps:
 *   /register  →  /register/eligibility  →  /register/membership  →  /register/schedule
 *
 * Security model:
 *   - HS256 with REGISTRATION_TOKEN_SECRET (>= 32 chars; rotate anytime).
 *   - 1-hour expiry. Long enough to finish a wizard, short enough to limit
 *     replay if the token leaks.
 *   - dobHash (sha256 of YYYY-MM-DD DOB + secret) lets us re-verify identity
 *     before sensitive actions (membership enrollment, account claim) without
 *     leaking the DOB itself.
 *   - Audience pinned to "portal-register" so a regToken cannot be used as a
 *     general session token if the secret is shared.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { createHash } from "node:crypto";

const ALG = "HS256";
const ISSUER = "patient-portal";
const AUDIENCE = "portal-register";
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

/** Claims embedded in a portal registration JWT. */
export interface RegistrationTokenClaims {
  /** Athena patient id created during /api/portal/register/patient. */
  athenaPatientId: string;
  /** Hint patient id (optional — created lazily if commercial). */
  hintPatientId?: string;
  /** Department id used when creating the patient (carried for slot lookup). */
  departmentId: number;
  /** sha256(secret + "|" + YYYY-MM-DD DOB). Lets us re-verify without storing PHI. */
  dobHash: string;
  /** Lowercase mobile phone (E.164) — used for downstream account-claim flows. */
  phone?: string;
  /** Email if provided — used for account-claim email. */
  email?: string;
  /** First name for personalization (NOT for identity). */
  firstName?: string;
  /** Last name for personalization (NOT for identity). */
  lastName?: string;
  /**
   * Salesforce PersonAccount Id created at /api/portal/register/patient.
   * SourceSystemIdentifier on the Account = Athena patient id, so when
   * Athena Pro inbound sync goes live it can match by source system id
   * without manual reconciliation.
   */
  salesforceAccountId?: string;
  /**
   * Salesforce Lead Id created at /api/portal/register/eligibility (after
   * insurance is known). Linked to the Account via Matched_Account__c.
   * Patched at /api/portal/register/appointments/book with the booked
   * Appointment__c lookup.
   */
  salesforceLeadId?: string;
  /** LeadSource captured at registration submit (default "Online Registration"). */
  leadSource?: string;
  /**
   * Wizard "How did you hear about us?" raw selection (one of the
   * REFERRAL_OPTIONS values from RegistrationWizard.tsx). Carried
   * forward so the Lead created at /api/portal/register/eligibility
   * can populate `Lead.How_did_you_hear_about_us__c` after mapping
   * via `mapReferralSourceToSf()`.
   */
  referralSource?: string;
  /**
   * Marketing attribution snapshot captured at registration submit, carried
   * forward so the Lead created at the eligibility step gets the right
   * `utm_*__c` / `GCLID__c` values.
   */
  utm?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
    id?: string;
    gclid?: string;
    msclkid?: string;
    fbclid?: string;
  };
  /**
   * URL pathname the user first landed on (e.g. "/newpatients").
   * Persisted across the wizard so the SF Lead can record where the
   * patient entered the funnel even if they navigated through several
   * pages before reaching `/register`.
   */
  landingPage?: string;
  /**
   * `document.referrer` at the time attribution was captured — the
   * page that linked the user into our site (or `/register`). May be
   * external (search engine) or internal (`/newpatients`).
   */
  referrer?: string;
}

/** Verified registration JWT including standard JWT timestamps. */
export interface VerifiedRegistrationToken extends RegistrationTokenClaims {
  /** Seconds since epoch when the token expires. */
  exp: number;
  /** Seconds since epoch when the token was issued. */
  iat: number;
}

function getSecret(): Uint8Array {
  const secret = process.env.REGISTRATION_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "REGISTRATION_TOKEN_SECRET is missing or shorter than 32 characters"
    );
  }
  return new TextEncoder().encode(secret);
}

/** Compute a deterministic hash of the patient's DOB tied to our signing secret. */
export function hashDob(dobYyyyMmDd: string): string {
  const secret = process.env.REGISTRATION_TOKEN_SECRET || "";
  return createHash("sha256")
    .update(`${secret}|${dobYyyyMmDd}`)
    .digest("hex");
}

/** True when the supplied DOB matches the dobHash inside a verified token. */
export function dobMatches(dobYyyyMmDd: string, dobHash: string): boolean {
  return hashDob(dobYyyyMmDd) === dobHash;
}

/** Issue a short-lived registration JWT for the no-account wizard. */
export async function mintRegistrationToken(
  claims: RegistrationTokenClaims,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
  const secret = getSecret();
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

/** Thrown when a registration token is missing, expired, or invalid. */
export class RegistrationTokenError extends Error {
  constructor(message: string, public reason: "missing" | "expired" | "invalid") {
    super(message);
    this.name = "RegistrationTokenError";
  }
}

/** Verify and decode a registration JWT; throws RegistrationTokenError on failure. */
export async function verifyRegistrationToken(
  token: string | null | undefined
): Promise<VerifiedRegistrationToken> {
  if (!token) {
    throw new RegistrationTokenError("Missing registration token", "missing");
  }

  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });

    const required = ["athenaPatientId", "departmentId", "dobHash"] as const;
    for (const key of required) {
      if (payload[key] === undefined || payload[key] === null) {
        throw new RegistrationTokenError(
          `Token missing required claim: ${key}`,
          "invalid"
        );
      }
    }

    return payload as unknown as VerifiedRegistrationToken;
  } catch (err) {
    if (err instanceof RegistrationTokenError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new RegistrationTokenError(
        "Registration token expired",
        "expired"
      );
    }
    throw new RegistrationTokenError(
      "Invalid registration token",
      "invalid"
    );
  }
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

/** Extract the regToken from an Authorization: Bearer ... header (or null). */
export function readRegistrationTokenFromHeader(
  authHeader: string | null
): string | null {
  if (!authHeader) return null;
  const m = BEARER_RE.exec(authHeader.trim());
  return m ? m[1] : null;
}
