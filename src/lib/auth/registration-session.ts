/**
 * Server-side helpers for the unauthenticated portal registration flow.
 *
 * Mirrors the shape of `requireVerifiedIdentity` (in clerk-session.ts) so route
 * handlers feel consistent regardless of whether the caller is a Clerk-authed
 * user or an in-progress registrant carrying a regToken.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  RegistrationTokenError,
  VerifiedRegistrationToken,
  readRegistrationTokenFromHeader,
  verifyRegistrationToken,
} from "@/lib/auth/registration-token";

/**
 * Pull the regToken from the Authorization header on a request and verify it.
 * Returns the verified claims, or a NextResponse with the appropriate error.
 */
export async function requireRegistrationToken(
  request: NextRequest
): Promise<VerifiedRegistrationToken | NextResponse> {
  const raw = readRegistrationTokenFromHeader(
    request.headers.get("authorization")
  );

  try {
    return await verifyRegistrationToken(raw);
  } catch (err) {
    if (err instanceof RegistrationTokenError) {
      const status = 401;
      return NextResponse.json(
        {
          error: "Registration session invalid",
          reason: err.reason,
          message:
            err.reason === "expired"
              ? "Your registration session has expired. Please start again."
              : "We couldn't verify your registration session. Please start again.",
        },
        { status }
      );
    }
    return NextResponse.json(
      { error: "Registration session invalid" },
      { status: 401 }
    );
  }
}

/** Type guard: true when requireRegistrationToken returned claims. */
export function isVerifiedRegistration(
  result: VerifiedRegistrationToken | NextResponse
): result is VerifiedRegistrationToken {
  return "athenaPatientId" in result && "dobHash" in result;
}
