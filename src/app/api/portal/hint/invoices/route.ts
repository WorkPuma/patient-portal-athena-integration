import { NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { getInvoices } from "@/lib/hint/client";

/**
 * GET /api/portal/hint/invoices
 * List invoices for the authenticated patient.
 */
export async function GET() {
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  if (!user.hintPatientId) {
    return NextResponse.json({ invoices: [] });
  }

  try {
    const invoices = await getInvoices({
      patientId: user.hintPatientId,
    });

    return NextResponse.json({ invoices });
  } catch (error) {
    console.error("[Portal] HINT invoices error:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 }
    );
  }
}
