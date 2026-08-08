import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { ensurePortalIdentityLinked } from "@/lib/identity/auto-link";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/identity/link
 * Attempts identity auto-link for the authenticated Clerk user.
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const linked = await ensurePortalIdentityLinked(user);

  void recordAuditEvent({
    actorType: "patient",
    actorId: userId,
    action: "identity.link",
    subjectType: "identity",
    subjectId: userId,
    outcome: linked ? "success" : "denied",
    request,
    detail: linked?.disambiguationRequired ? { disambiguationRequired: true } : {},
  });

  if (!linked) {
    return NextResponse.json({
      linked: false,
      message: "No identity match found",
    });
  }

  return NextResponse.json({
    linked: true,
    ...linked,
  });
}
