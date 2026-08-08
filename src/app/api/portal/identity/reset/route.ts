import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { deleteLinkByClerkUserId } from "@/lib/identity/store";
import { timingSafeCompare } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit/audit-log";

/**
 * POST /api/portal/identity/reset
 *
 * Clears a wrongly-linked identity for the authenticated user.
 * Removes Supabase link + wipes Clerk public metadata patient IDs so
 * the auto-link flow re-runs on the next page load.
 *
 * Protected by PORTAL_ADMIN_SECRET header — only support/admin tooling
 * should call this.
 */
export async function POST(request: Request) {
  const adminSecret = process.env.PORTAL_ADMIN_SECRET;
  const authHeader = request.headers.get("x-admin-secret");

  let targetUserId: string | undefined;

  // Timing-safe admin secret check (DEV-4473). When the secret is
  // configured, require an exact, constant-time match; never fall back
  // to the self-reset path for an admin-shaped request.
  if (adminSecret && authHeader && timingSafeCompare(adminSecret, authHeader)) {
    const body = await request.json().catch(() => ({}));
    targetUserId = body.clerkUserId;
    if (!targetUserId) {
      return NextResponse.json(
        { error: "clerkUserId is required for admin reset" },
        { status: 400 }
      );
    }
  } else if (adminSecret) {
    // Secret is configured but the header was absent or mismatched — deny.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    targetUserId = userId;
  }

  await deleteLinkByClerkUserId(targetUserId);

  const client = await clerkClient();
  await client.users.updateUser(targetUserId, {
    publicMetadata: {
      athenaPatientId: null,
      sfContactId: null,
      hintPatientId: null,
      empiGoldenId: null,
      disambiguationPending: null,
    },
  });

  void recordAuditEvent({
    actorType: adminSecret && authHeader === adminSecret ? "admin" : "patient",
    actorId: adminSecret && authHeader === adminSecret ? "admin" : targetUserId,
    action: "identity.reset",
    subjectType: "identity",
    subjectId: targetUserId,
    request,
  });

  return NextResponse.json({
    reset: true,
    clerkUserId: targetUserId,
    message: "Identity link cleared. The user will re-verify on next login.",
  });
}
