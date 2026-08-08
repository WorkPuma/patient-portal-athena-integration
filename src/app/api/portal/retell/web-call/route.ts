import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedIdentity, isPortalUser } from "@/lib/auth/clerk-session";
import { createWebCall } from "@/lib/retell/client";

export async function POST(request: NextRequest) {
  // Security (DEV-4471): identity is derived from the verified Clerk session,
  // never from the body. A body-supplied athenaPatientId/sfContactId would
  // let an authenticated user tag a web call with another patient's IDs.
  const result = await requireVerifiedIdentity();
  if (!isPortalUser(result)) return result;
  const user = result;

  try {
    const body = await request.json().catch(() => ({}));
    // `phone` is the call target (verified-identity routes still accept a
    // caller-chosen number; per-endpoint limits are enforced in PR5).
    const { phone } = body as { phone?: string };

    const agentId = process.env.RETELL_SMS_AGENT_ID;
    if (!agentId) {
      return NextResponse.json(
        { error: "Retell agent not configured" },
        { status: 503 }
      );
    }

    const call = await createWebCall({
      agentId,
      metadata: {
        athena_patient_id: user.athenaPatientId || "",
        sf_contact_id: user.sfContactId || "",
        phone: phone || "",
      },
    });

    return NextResponse.json({
      callId: call.call_id,
      accessToken: call.access_token,
    });
  } catch (err) {
    console.error("[Retell Web Call] Error:", err);
    return NextResponse.json(
      { error: "Failed to create web call" },
      { status: 500 }
    );
  }
}
