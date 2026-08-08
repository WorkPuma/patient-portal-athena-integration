/**
 * Portal feature flags.
 *
 * Single source of truth for the three coarse-grained surfaces we want to
 * be able to toggle without ripping code out:
 *
 *   - dot         Retell AI assistant ("Dot") + its widget + tool routes
 *   - membership  Hint membership step in the public registration wizard
 *                 (the authenticated /portal/membership pages are NOT gated
 *                 by this flag — existing members must keep their access)
 *   - authUi      Auth-related call-to-actions in the public registration
 *                 funnel: "Already registered? Sign in", "Create my
 *                 account", "I'll do it later", "New patient? Register
 *                 here", and the auto-emailed claim-link. Clerk itself
 *                 stays running so the authenticated portal still works
 *                 for users who already have accounts.
 *
 * Plus a separate operational flag:
 *
 *   - passiveClerk  When true, /api/portal/register/patient quietly creates
 *                   a Clerk user from the patient's phone (and email when
 *                   provided) so a future "sign in via SMS" CTA can find
 *                   them. No SMS is sent at registration time.
 *
 * Defaults reflect the current build (Apr 2026):
 *   dot=false, membership=false, authUi=false, passiveClerk=true.
 *
 * Override via env. Public flags use NEXT_PUBLIC_* so they are inlined into
 * the client bundle. The passive-Clerk flag is server-only.
 *
 *   NEXT_PUBLIC_PORTAL_DOT_ENABLED=1
 *   NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED=1
 *   NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED=1
 *   PORTAL_PASSIVE_CLERK_ENABLED=0          # disable
 *
 * Accepted truthy values (case-insensitive): "1", "true", "yes", "on".
 * Anything else (including empty / unset) falls back to the default.
 */

export interface PortalFeatureFlags {
  /** Show the Dot chat widget and accept Dot tool calls. */
  dot: boolean;
  /** Show the membership step in the public registration wizard. */
  membership: boolean;
  /** Show auth-related CTAs in the public registration funnel. */
  authUi: boolean;
  /**
   * Server-only: silently create a Clerk user during /register/patient so
   * the patient has a dormant account they can later claim via SMS OTP.
   */
  passiveClerk: boolean;
}

const DEFAULTS: PortalFeatureFlags = {
  dot: false,
  membership: false,
  authUi: false,
  passiveClerk: true,
};

function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Resolve all portal feature flags from the current process env.
 *
 * Safe to call from server components, route handlers, and server actions.
 * For client components, prefer {@link getPublicPortalFeatureFlags} which
 * hides the server-only flags.
 */
export function getPortalFeatureFlags(): PortalFeatureFlags {
  return {
    dot: parseFlag(
      process.env.NEXT_PUBLIC_PORTAL_DOT_ENABLED,
      DEFAULTS.dot
    ),
    membership: parseFlag(
      process.env.NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED,
      DEFAULTS.membership
    ),
    authUi: parseFlag(
      process.env.NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED,
      DEFAULTS.authUi
    ),
    passiveClerk: parseFlag(
      process.env.PORTAL_PASSIVE_CLERK_ENABLED,
      DEFAULTS.passiveClerk
    ),
  };
}

/** Subset of flags safe to expose to the client. */
export type PublicPortalFeatureFlags = Pick<
  PortalFeatureFlags,
  "dot" | "membership" | "authUi"
>;

export function getPublicPortalFeatureFlags(): PublicPortalFeatureFlags {
  const all = getPortalFeatureFlags();
  return { dot: all.dot, membership: all.membership, authUi: all.authUi };
}

/**
 * Client-side convenience that reads NEXT_PUBLIC_* directly. Use from
 * client components where calling {@link getPortalFeatureFlags} would
 * recompute server-only fields you'll throw away.
 *
 * Note: Next.js inlines NEXT_PUBLIC_* at build time, so toggling these in
 * Vercel requires a redeploy of the affected deployment.
 */
export function getClientPortalFeatureFlags(): PublicPortalFeatureFlags {
  return {
    dot: parseFlag(
      process.env.NEXT_PUBLIC_PORTAL_DOT_ENABLED,
      DEFAULTS.dot
    ),
    membership: parseFlag(
      process.env.NEXT_PUBLIC_PORTAL_MEMBERSHIP_ENABLED,
      DEFAULTS.membership
    ),
    authUi: parseFlag(
      process.env.NEXT_PUBLIC_PORTAL_AUTH_UI_ENABLED,
      DEFAULTS.authUi
    ),
  };
}

/** Test-only override hook. Not exported from the public surface. */
export const __FOR_TESTS_ONLY = { DEFAULTS, parseFlag };
