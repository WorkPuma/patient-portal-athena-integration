/**
 * Shared helpers for the unauthenticated /api/portal/register/membership/*
 * routes. All three routes (payment-setup, payment-method, enroll) need to:
 *
 *   1. Load the regToken claims.
 *   2. If hintPatientId is missing, lazily create the Hint patient from the
 *      regToken (email/phone/firstName/lastName).
 *   3. Optionally re-issue a refreshed regToken so subsequent steps don't
 *      have to re-create.
 *
 * Centralising it here keeps each route handler focused on its own concern
 * and removes the chance of drift in how we surface Hint errors.
 */

import { NextResponse } from "next/server";

import { captureServerException } from "@/lib/capture-exception";
import {
  HintApiError,
  createPatient as createHintPatient,
} from "@/lib/hint/client";
import { getPatient as getAthenaPatient } from "@/lib/athena/client";
import {
  mintRegistrationToken,
  type RegistrationTokenClaims,
  type VerifiedRegistrationToken,
} from "@/lib/auth/registration-token";

/**
 * Athena returns DOB as MM/DD/YYYY. Hint requires YYYY-MM-DD.
 * Returns null if the input is empty or doesn't parse.
 */
function athenaDobToHint(dob: string | undefined | null): string | null {
  if (!dob) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dob.trim());
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Already ISO-shaped? Trust it.
  if (/^\d{4}-\d{2}-\d{2}/.test(dob)) return dob.slice(0, 10);
  return null;
}

export type LazyHintPatientResult =
  | { ok: true; hintPatientId: string; refreshedRegToken: string | null }
  | { ok: false; response: NextResponse };

function claimsFromSession(
  session: VerifiedRegistrationToken,
  hintPatientId: string
): RegistrationTokenClaims {
  return {
    athenaPatientId: session.athenaPatientId,
    hintPatientId,
    departmentId: session.departmentId,
    dobHash: session.dobHash,
    phone: session.phone,
    email: session.email,
    firstName: session.firstName,
    lastName: session.lastName,
  };
}

/**
 * Ensure the in-progress registrant has a Hint patient. Returns the existing
 * id from the regToken, or creates one and returns a fresh regToken so the
 * client can update its sessionStorage.
 */
export async function ensureHintPatient(
  session: VerifiedRegistrationToken,
  routeName: string
): Promise<LazyHintPatientResult> {
  if (session.hintPatientId) {
    return {
      ok: true,
      hintPatientId: session.hintPatientId,
      refreshedRegToken: null,
    };
  }

  if (!session.email) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Email is required to enroll in membership. Please go back and add an email.",
          code: "EMAIL_REQUIRED",
        },
        { status: 400 }
      ),
    };
  }

  // Hint requires `dob` (YYYY-MM-DD) on create — we deliberately don't put
  // the raw DOB on the regToken (only dobHash for re-verification), so we
  // pull it from Athena where the registration step already wrote it.
  let athenaPatient: Awaited<ReturnType<typeof getAthenaPatient>> | null = null;
  try {
    athenaPatient = await getAthenaPatient(session.athenaPatientId);
  } catch (err) {
    captureServerException(err, {
      tags: { portal_route: routeName, step: "athena.getPatient" },
    });
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Could not load your registration to create a billing account. Please retry.",
          code: "ATHENA_GET_PATIENT_FAILED",
        },
        { status: 502 }
      ),
    };
  }

  const ap = athenaPatient as Record<string, unknown> | null;
  const dob = athenaDobToHint(typeof ap?.dob === "string" ? ap.dob : null);
  if (!dob) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Date of birth is missing on your patient record — please go back and re-enter it.",
          code: "DOB_MISSING",
        },
        { status: 400 }
      ),
    };
  }

  const str = (k: string) => (typeof ap?.[k] === "string" ? (ap[k] as string) : undefined);

  try {
    const hintPatient = await createHintPatient({
      first_name: session.firstName || str("firstname") || "Unknown",
      last_name: session.lastName || str("lastname") || "Unknown",
      email: session.email,
      dob,
      address_line1: str("address1"),
      address_line2: str("address2"),
      address_city: str("city"),
      address_state: str("state"),
      address_zip: str("zip"),
      phone: session.phone || str("mobilephone"),
    });

    const refreshed = await mintRegistrationToken(
      claimsFromSession(session, hintPatient.id)
    );

    return {
      ok: true,
      hintPatientId: hintPatient.id,
      refreshedRegToken: refreshed,
    };
  } catch (err) {
    captureServerException(err, {
      tags: { portal_route: routeName, step: "createHintPatient" },
    });
    if (err instanceof HintApiError) {
      // Surface Hint's validation body so the wizard (and on-call) can see
      // which field actually failed instead of guessing from a generic 422.
      let hintError: unknown = err.responseBody;
      try {
        hintError = JSON.parse(err.responseBody);
      } catch {
        /* leave as raw text */
      }
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "Failed to create Hint patient",
            code: "HINT_PATIENT_CREATE",
            hintStatus: err.statusCode,
            hintError,
          },
          {
            status:
              err.statusCode >= 400 && err.statusCode < 500
                ? err.statusCode
                : 502,
          }
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Failed to create membership account" },
        { status: 500 }
      ),
    };
  }
}
