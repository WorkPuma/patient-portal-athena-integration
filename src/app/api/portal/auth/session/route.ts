import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getPortalUser } from "@/lib/auth/clerk-session";

/**
 * GET /api/portal/auth/session
 * Returns the current portal user session including disambiguation and registration state.
 */
export async function GET() {
  const user = await getPortalUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let registrationComplete = false;
  try {
    const { userId } = await auth();
    if (userId) {
      const client = await clerkClient();
      const clerkUser = await client.users.getUser(userId);
      const meta = (clerkUser.publicMetadata || {}) as Record<string, unknown>;
      registrationComplete = meta.registrationComplete === true;
    }
  } catch {
    // Fall back to checking if they have an athenaPatientId
    registrationComplete = !!user.athenaPatientId;
  }

  return NextResponse.json({
    user: {
      displayName: user.displayName,
      email: user.email,
      hintPatientId: user.hintPatientId || undefined,
      athenaPatientId: user.athenaPatientId || undefined,
      disambiguationRequired: user.disambiguationRequired || false,
      registrationComplete,
    },
  });
}
