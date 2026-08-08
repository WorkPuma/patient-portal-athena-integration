/**
 * Portal-side brand assets.
 *
 * The login and registration screens use a Storyblok-hosted logo so
 * marketing can swap branding without a code deploy. Keep the URL
 * here so every consumer renders the same artwork.
 *
 * The host (`a.storyblok.com`) is allowlisted in:
 *   - next.config.ts → `images.remotePatterns` (lets next/image proxy it)
 *   - vercel.json portal-host CSP → `img-src` (lets the browser fetch it)
 */
export const PORTAL_LOGO_URL =
  "https://a.storyblok.com/f/289835213735561/28492/0602ba9a4b/hhlogo_reg.png";

export const PORTAL_LOGO_ALT = "Herself Health";

/**
 * Default render dimensions for the portal logo. Used by the login,
 * registration, and off-ramp screens so they all stay in lockstep.
 */
export const PORTAL_LOGO_WIDTH = 220;
export const PORTAL_LOGO_HEIGHT = 40;
