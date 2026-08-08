import { cache } from "react";
import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { ensurePortalIdentityLinked } from "@/lib/identity/auto-link";

/** Authenticated portal user with linked patient identifiers. */
export interface PortalUser {
  userId: string;
  athenaPatientId: string;
  sfContactId: string;
  hintPatientId: string;
  email: string;
  displayName: string;
  disambiguationRequired?: boolean;
  candidateCount?: number;
}

/**
 * Retrieve the authenticated portal user with patient IDs from Clerk metadata.
 * Returns null if the user is not signed in.
 *
 * When the EMPI resolves to multiple golden records for the same phone/email
 * (shared family contacts), `disambiguationRequired` is set to true and patient
 * IDs will be empty until the user verifies their DOB via /api/portal/identity/verify-dob.
 */
/**
 * Per-request memoized via React `cache()`. Within a single request, repeated
 * calls (e.g. middleware → handler → util) reuse the same Clerk lookup +
 * identity-link round-trip instead of refetching. The cache key is the
 * resolved Clerk userId (auth() inside the inner fn uses the request-scoped
 * cookies/headers, so two requests cannot collide).
 */
export const getPortalUser: () => Promise<PortalUser | null> = cache(
  async () => {
    const { userId } = await auth();
    if (!userId) return null;

    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const meta = (user.publicMetadata || {}) as Record<string, unknown>;
    const str = (v: unknown) => String(v ?? "").trim();

    let linked: Awaited<ReturnType<typeof ensurePortalIdentityLinked>> = null;
    try {
      linked = await ensurePortalIdentityLinked(user);
    } catch (err) {
      console.error(
        "[Portal] ensurePortalIdentityLinked failed; using Clerk metadata only",
        err
      );
    }

    if (linked?.disambiguationRequired) {
      return {
        userId,
        athenaPatientId: "",
        sfContactId: "",
        hintPatientId: "",
        email:
          user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
            ?.emailAddress || "",
        displayName: [user.firstName, user.lastName].filter(Boolean).join(" "),
        disambiguationRequired: true,
        candidateCount: linked.candidateCount,
      };
    }

    return {
      userId,
      athenaPatientId:
        str(meta.athenaPatientId) || str(linked?.athenaPatientId) || "",
      sfContactId: str(meta.sfContactId) || str(linked?.sfContactId) || "",
      hintPatientId:
        str(meta.hintPatientId) || str(linked?.hintPatientId) || "",
      email:
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
          ?.emailAddress || "",
      displayName: [user.firstName, user.lastName].filter(Boolean).join(" "),
    };
  }
);

/**
 * Guard for protected API routes. Returns a 403 JSON response if the
 * user's identity has not been verified (disambiguation pending).
 * Call at the top of any API handler that accesses patient data.
 *
 * Returns the PortalUser on success, or a NextResponse on failure.
 */
export async function requireVerifiedIdentity(): Promise<
  PortalUser | NextResponse
> {
  const user = await getPortalUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.disambiguationRequired) {
    return NextResponse.json(
      {
        error: "Identity verification required",
        disambiguationRequired: true,
        message:
          "Your identity has not been verified yet. " +
          "Please verify your date of birth on the dashboard.",
      },
      { status: 403 }
    );
  }
  if (!user.athenaPatientId) {
    return NextResponse.json(
      {
        error: "No linked patient record",
        message: "No patient record is linked to your account.",
      },
      { status: 403 }
    );
  }
  return user;
}

/** Type guard: true when requireVerifiedIdentity returned a user, not a response. */
export function isPortalUser(
  result: PortalUser | NextResponse
): result is PortalUser {
  return "userId" in result;
}
