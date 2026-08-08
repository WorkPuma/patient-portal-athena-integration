import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import {
  AthenaApiError,
  triggerEligibilityCheck,
} from "@/lib/athena/client";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/athena/patient/eligibility
 * Trigger an insurance eligibility check.
 */
export async function POST(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  const body = await request.json();
  // Security (DEV-4470): ignore any client-supplied patientId. The Athena
  // patient is derived solely from the authenticated portal user. A body
  // patientId could otherwise trigger eligibility checks against another
  // patient's record.
  const { insuranceId, dateOfService } = body as {
    insuranceId: number;
    dateOfService?: string;
  };

  const resolvedPatientId = user.athenaPatientId;
  if (!resolvedPatientId) {
    return NextResponse.json(
      { error: "Patient ID is required" },
      { status: 400 }
    );
  }

  if (!insuranceId) {
    return NextResponse.json(
      { error: "insuranceId is required" },
      { status: 400 }
    );
  }

  try {
    const result = await triggerEligibilityCheck(
      resolvedPatientId,
      insuranceId,
      dateOfService
    );

    void recordAuditEvent({
      actorType: "patient",
      actorId: user.userId,
      action: "phi.read.athena_eligibility",
      subjectType: "patient",
      subjectId: resolvedPatientId,
      request,
      detail: { insuranceId },
    });

    return NextResponse.json({ eligibility: result });
  } catch (error) {
    if (error instanceof AthenaApiError) {
      const code = error.statusCode;
      const status = code >= 400 && code < 500 ? code : 422;
      return NextResponse.json(
        {
          error: "Eligibility check failed",
          code: "ATHENA_ELIGIBILITY",
          athenaStatus: code,
          detail: error.responseBody?.slice(0, 500),
        },
        { status }
      );
    }
    console.error("[Portal] Eligibility check error:", error);
    return NextResponse.json(
      { error: "Failed to check eligibility" },
      { status: 500 }
    );
  }
}
