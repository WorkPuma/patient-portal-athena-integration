import { NextResponse } from "next/server";
import {
  requireVerifiedIdentity,
  isPortalUser,
} from "@/lib/auth/clerk-session";
import { getPatient, getDepartments } from "@/lib/athena/client";

/**
 * GET /api/portal/athena/patient/defaults
 * Returns the patient's PCP and primary department for scheduling defaults.
 */
export async function GET() {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.athenaPatientId) {
    return NextResponse.json(
      { error: "No Athena patient linked" },
      { status: 400 }
    );
  }

  try {
    const [patient, deptResult] = await Promise.all([
      getPatient(user.athenaPatientId),
      getDepartments(),
    ]);

    const primaryDeptId = String(
      (patient as Record<string, unknown>).primarydepartmentid || ""
    );
    const primaryProviderId = String(
      (patient as Record<string, unknown>).primaryproviderid || ""
    );

    const departments = deptResult.map((d) => ({
      departmentid: d.departmentid,
      name:
        (d as Record<string, unknown>).patientdepartmentname ||
        d.name ||
        `Department ${d.departmentid}`,
      address: (d as Record<string, unknown>).address || "",
      city: (d as Record<string, unknown>).city || "",
      state: (d as Record<string, unknown>).state || "",
      phone: (d as Record<string, unknown>).phone || "",
    }));

    const primaryDept = departments.find(
      (d) => d.departmentid === primaryDeptId
    );

    return NextResponse.json({
      primaryproviderid: primaryProviderId,
      primarydepartmentid: primaryDeptId,
      departmentName: primaryDept?.name || "",
      departments,
    });
  } catch (error) {
    console.error("[Portal] Patient defaults error:", error);
    return NextResponse.json(
      { error: "Failed to load patient defaults" },
      { status: 500 }
    );
  }
}
