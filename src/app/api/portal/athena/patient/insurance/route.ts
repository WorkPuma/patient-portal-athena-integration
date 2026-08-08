import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import {
  AthenaApiError,
  addInsurance,
  type AddInsuranceParams,
} from "@/lib/athena/client";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/athena/patient/insurance
 * Add insurance to a patient record.
 */
export async function POST(request: NextRequest) {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  const body = await request.json();
  // Security (DEV-4470): ignore any client-supplied patientId. The Athena
  // patient is derived solely from the authenticated portal user. A body
  // patientId could otherwise mutate another patient's insurance record.
  const data = body as Omit<AddInsuranceParams, "patientId">;

  const patientId = user.athenaPatientId;
  if (!patientId) {
    return NextResponse.json(
      { error: "Patient ID is required" },
      { status: 400 }
    );
  }

  if (!data.insurancepackageid) {
    return NextResponse.json(
      { error: "insurancepackageid is required" },
      { status: 400 }
    );
  }

  try {
    const insurance = await addInsurance({ ...data, patientId });
    void recordAuditEvent({
      actorType: "patient",
      actorId: user.userId,
      action: "phi.update.athena_insurance",
      subjectType: "patient",
      subjectId: patientId,
      request,
      detail: { insurancePackageId: data.insurancepackageid ?? null },
    });
    return NextResponse.json({ insurance });
  } catch (error) {
    if (error instanceof AthenaApiError) {
      const code = error.statusCode;
      const clientStatus = code >= 400 && code < 500 ? code : 502;
      return NextResponse.json(
        {
          error: "Athena refused insurance add",
          code: "ATHENA_INSURANCE_ADD",
          athenaStatus: code,
          detail: error.responseBody?.slice(0, 500),
        },
        { status: clientStatus }
      );
    }
    console.error("[Portal] Add insurance error:", error);
    return NextResponse.json(
      { error: "Failed to add insurance" },
      { status: 500 }
    );
  }
}
