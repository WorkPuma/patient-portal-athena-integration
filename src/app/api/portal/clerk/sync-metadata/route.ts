import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";

/**
 * POST /api/portal/clerk/sync-metadata
 *
 * Marks the calling Clerk user's wizard state. The ONLY field this
 * route is allowed to write is `registrationComplete` — a routing
 * boolean that drives whether `PortalShell` sends the user to
 * `/register` or to the dashboard. It does not grant access to any
 * data on its own; `requireVerifiedIdentity` still keys off
 * `publicMetadata.athenaPatientId`, and that field is set ONLY by
 * server-side trusted code paths (EMPI / contact-map resolution in
 * `src/lib/identity/auto-link.ts`, or the signed regToken handoff in
 * `src/app/api/portal/register/handoff/route.ts`).
 *
 * Security note (incident 2026-05):
 * This route previously accepted `athenaPatientId`, `sfContactId`,
 * and `hintPatientId` from the request body and wrote them to the
 * calling user's `publicMetadata` with no ownership check. That was
 * a self-serve patient-takeover primitive — any signed-in Clerk user
 * could POST `{ athenaPatientId: "<any id>" }` and the next call to
 * a `requireVerifiedIdentity`-protected route would treat them as
 * that patient. The route now hard-rejects those fields with 400 so
 * any client code that still tries to set them surfaces loudly
 * instead of silently no-op'ing.
 */
export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON" },
      { status: 400 },
    );
  }

  // Hard-reject any attempt to set identity primitives from the client.
  // These are server-trusted fields and must never be assignable by a
  // user-controlled request body.
  const FORBIDDEN_FIELDS = [
    "athenaPatientId",
    "sfContactId",
    "hintPatientId",
    "salesforceAccountId",
    "salesforceContactId",
  ];
  const attempted = FORBIDDEN_FIELDS.filter((f) => f in body);
  if (attempted.length > 0) {
    captureServerMessage(
      "[clerk/sync-metadata] blocked client write to server-trusted field(s)",
      {
        level: "warning",
        tags: { portal_route: "clerk-sync-metadata" },
        extra: { userId, attemptedFields: attempted },
      },
    );
    return NextResponse.json(
      {
        error: "Forbidden field(s) in body",
        forbidden: attempted,
        hint: "Identity primitives are set server-side via the registration handoff or auto-link. Do not send them from the client.",
      },
      { status: 400 },
    );
  }

  const { registrationComplete } = body as { registrationComplete?: unknown };

  if (typeof registrationComplete !== "boolean") {
    return NextResponse.json(
      { error: "registrationComplete (boolean) is required" },
      { status: 400 },
    );
  }

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const existingMeta = (user.publicMetadata || {}) as Record<
      string,
      unknown
    >;

    await client.users.updateUser(userId, {
      publicMetadata: {
        ...existingMeta,
        registrationComplete,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    captureServerException(error, {
      tags: { portal_route: "clerk-sync-metadata" },
      extra: { userId },
    });

    console.error("[Portal] Clerk metadata sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync metadata" },
      { status: 500 },
    );
  }
}
