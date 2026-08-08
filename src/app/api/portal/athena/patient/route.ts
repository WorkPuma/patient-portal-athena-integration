import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import {
  AthenaApiError,
  enhancedBestMatch,
  createPatient,
  type CreatePatientParams,
} from "@/lib/athena/client";

/**
 * POST /api/portal/athena/patient
 * Register a new patient in Athena (prospective patient flow).
 * First checks for existing patient via enhanced best match.
 */
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, {
    limit: 10,
    window: "1h",
    prefix: "portal-register",
  });
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many registration attempts" },
      { status: 429 }
    );
  }

  const body = await request.json();
  const data = body as CreatePatientParams & { skipDuplicateCheck?: boolean };

  if (!data.firstname || !data.lastname || !data.dob || !data.departmentid) {
    return NextResponse.json(
      { error: "firstname, lastname, dob, and departmentid are required" },
      { status: 400 }
    );
  }

  try {
    // Check for existing patient unless explicitly skipped
    if (!data.skipDuplicateCheck) {
      const matches = await enhancedBestMatch({
        firstname: data.firstname,
        lastname: data.lastname,
        dob: data.dob,
        email: data.email,
        mobilephone: data.mobilephone,
        departmentid: data.departmentid,
      });

      if (matches.length > 0 && (matches[0].score ?? 0) >= 23) {
        return NextResponse.json({
          existingPatient: true,
          patientid: matches[0].patientid,
          message:
            "An existing patient record was found. Please sign in instead.",
        });
      }
    }

    const result = await createPatient(data);
    return NextResponse.json({
      existingPatient: false,
      patientid: result.patientid,
    });
  } catch (error) {
    if (error instanceof AthenaApiError) {
      const code = error.statusCode;
      const clientStatus = code >= 400 && code < 500 ? code : 502;
      return NextResponse.json(
        {
          error: "Athena refused patient registration",
          code: "ATHENA_PATIENT_REGISTER",
          athenaStatus: code,
          detail: error.responseBody?.slice(0, 500),
        },
        { status: clientStatus }
      );
    }
    console.error("[Portal] Patient registration error:", error);
    return NextResponse.json(
      { error: "Failed to register patient" },
      { status: 500 }
    );
  }
}
