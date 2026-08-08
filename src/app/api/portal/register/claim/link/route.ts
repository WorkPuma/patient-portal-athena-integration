/**
 * POST /api/portal/register/claim/link
 *
 * Links a freshly-created Clerk user to the Athena/Hint patient record from
 * the no-account registration flow. Reads the regToken from the request body
 * (the client pulls it from sessionStorage), verifies it, and patches the
 * Clerk user's publicMetadata + the Supabase identity link table.
 *
 * Auth model:
 *   - Caller MUST be signed in to Clerk (this endpoint is called immediately
 *     after Clerk sign-up succeeds).
 *   - regToken is verified server-side; we never trust client-supplied
 *     athenaPatientId.
 *   - We refuse to overwrite an existing patient link to a *different* id
 *     and emit a Sentry message so we notice account-collision attempts.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";

import { withPortalErrors, parseJsonBody } from "@/lib/portal/api";
import { upsertIdentityLink } from "@/lib/identity/store";
import { getNormalizedContactForUser } from "@/lib/identity/resolver";
import { captureServerMessage } from "@/lib/capture-exception";
import {
  RegistrationTokenError,
  verifyRegistrationToken,
} from "@/lib/auth/registration-token";

interface ClaimLinkBody {
  regToken?: string;
}

interface PortalMetadata extends Record<string, unknown> {
  athenaPatientId?: string;
  sfContactId?: string;
  hintPatientId?: string;
  empiGoldenId?: string;
  disambiguationPending?: boolean;
}

export async function POST(req: NextRequest) {
  return withPortalErrors("register-claim-link", async () => {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await parseJsonBody<ClaimLinkBody>(req)) || {};
    const regToken = (body.regToken || "").trim();
    if (!regToken) {
      return NextResponse.json(
        { error: "Missing registration token" },
        { status: 400 }
      );
    }

    let claims;
    try {
      claims = await verifyRegistrationToken(regToken);
    } catch (err) {
      if (err instanceof RegistrationTokenError) {
        return NextResponse.json(
          { error: err.message, reason: err.reason },
          { status: 401 }
        );
      }
      throw err;
    }

    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const existing = (user.publicMetadata || {}) as PortalMetadata;

    if (
      existing.athenaPatientId &&
      existing.athenaPatientId !== claims.athenaPatientId
    ) {
      captureServerMessage(
        "registration_claim_overwrite_blocked: athenaPatientId differs",
        {
          extra: {
            clerkUserId: userId,
            existingAthenaId: existing.athenaPatientId,
            claimAthenaId: claims.athenaPatientId,
          },
        }
      );
      return NextResponse.json(
        {
          error:
            "Your account is already linked to a different patient record.",
        },
        { status: 409 }
      );
    }

    const merged: PortalMetadata = {
      ...existing,
      athenaPatientId: claims.athenaPatientId,
      hintPatientId: claims.hintPatientId || existing.hintPatientId || "",
      disambiguationPending: false,
    };
    await client.users.updateUser(userId, { publicMetadata: merged });

    const contact = getNormalizedContactForUser(user);
    await upsertIdentityLink({
      clerkUserId: userId,
      emailNormalized: contact.email,
      phoneNormalized: contact.phone,
      resolved: {
        resolver: "registration_token",
        athenaPatientId: claims.athenaPatientId,
        hintPatientId: claims.hintPatientId || undefined,
      },
    });

    return NextResponse.json({
      linked: true,
      athenaPatientId: claims.athenaPatientId,
      hintPatientId: claims.hintPatientId || "",
    });
  });
}
