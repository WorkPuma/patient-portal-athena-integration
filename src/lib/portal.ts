/**
 * Portal mode utilities
 *
 * Portal vs marketing is decided per-request from the host header so a
 * SINGLE Vercel deployment can serve both:
 *   - example-patient-portal.com / staging.example-patient-portal.com   → marketing
 *   - my.example-patient-portal.com / my.staging.example-patient-portal.com → portal
 *
 * `NEXT_PUBLIC_PORTAL_MODE=true` is still honored as an explicit override
 * for local dev / Playwright runs that don't have a real host.
 */

export const PORTAL_HOST_PREFIX_RE = /^my(\.[a-z0-9-]+)*\.example-patient-portal\.(com|net)$/i;

/**
 * True when the given host is a portal subdomain (e.g. my.example-patient-portal.com,
 * my.staging.example-patient-portal.com). The `host` argument is the value of the
 * incoming request's `Host` header (with optional `:port`); pass `null` to
 * fall back to the env override only.
 */
export function isPortalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0].toLowerCase();
  return PORTAL_HOST_PREFIX_RE.test(hostname);
}

/**
 * Build-time/dev override. Returns true when NEXT_PUBLIC_PORTAL_MODE=true
 * is set — used by local dev (`npm run dev`) and E2E suites that don't
 * exercise a my.* host. Production behavior is driven by the request
 * host via `isPortalHost()`.
 */
export function isPortalMode(): boolean {
  return process.env.NEXT_PUBLIC_PORTAL_MODE === "true";
}

/**
 * Combined check: explicit env override OR portal host.
 * Server components / route handlers can call this with the headers() host.
 */
export function isPortalRequest(host: string | null | undefined): boolean {
  return isPortalMode() || isPortalHost(host);
}

/**
 * Clean portal page URL prefixes (browser-visible on my.* before the
 * middleware rewrite to /portal/...). Keep in sync with
 * `PORTAL_PAGE_PREFIXES` in src/middleware.ts.
 */
export const PORTAL_CLEAN_URL_PREFIXES = [
  "/login",
  "/dashboard",
  "/register",
  "/appointments",
  "/membership",
  "/messages",
  "/schedule",
  "/employee-login",
  "/sso-callback",
] as const;

/**
 * Routes that don't require authentication in portal mode.
 * These are the user-facing (clean) paths — the middleware handles
 * rewriting them to internal /portal/... paths.
 */
export const PORTAL_PUBLIC_ROUTES = [
  "/login",
  "/register",
  "/register/eligibility",
  "/register/membership",
  "/register/schedule",
  "/register/confirmation",
  "/register/create-account",
];

/**
 * Default Athena department for portal scheduling / registration.
 * Preview sandbox (e.g. practice 31254) may not include department "1" — set
 * NEXT_PUBLIC_ATHENA_DEFAULT_DEPARTMENT_ID (e.g. 2) in .env.local.
 */
export function getPortalDefaultDepartmentId(): number {
  const raw = process.env.NEXT_PUBLIC_ATHENA_DEFAULT_DEPARTMENT_ID;
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 1;
}
