import { captureServerMessage } from "@/lib/capture-exception";
/**
 * Defensive env sanitizer.
 *
 * Incident 2026-05-12: `vercel env pull` left a literal `\r\n` suffix
 * baked into `NEXT_PUBLIC_SUPABASE_URL` in `.env.preview.probe`. On the
 * Vercel runtime that suffix gets stripped server-side, but every local
 * tool that re-reads the pulled file (the Playwright verifier, the
 * probe scripts, anything sourcing the env into the shell) ended up
 * passing a malformed URL into `@supabase/supabase-js`. The library
 * happily built `https://<host>\r\n/rest/v1/...` request URLs and every
 * fetch silently returned nothing — the verifier saw zero followup
 * rows even though the deployed app was writing them correctly.
 *
 * The same artifact could appear on the Vercel runtime too if a future
 * `vercel env add` ever stored a value with literal `\r\n` (we have at
 * least one historical instance in this repo). Centralize the cleaning
 * here and call it at every server-side read of:
 *
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * and at any other env we suspect of being touched by the Vercel CLI
 * write path. Belt-and-suspenders: log to Sentry when cleaning
 * actually changed the value so we get a paper trail rather than a
 * silent recovery.
 */


/**
 * Strip literal `\r\n` / `\n` / `\r` escape sequences AND real CR/LF
 * whitespace from an env value. Returns `undefined` if the input is
 * undefined or empty after cleaning.
 *
 * @param name optional env variable name used for the Sentry breadcrumb
 *             so we can tell which key was dirty in production
 */
export function cleanEnv(
  value: string | undefined,
  name?: string,
): string | undefined {
  if (!value) return value;
  const cleaned = value
    .replace(/\\r\\n/g, "")
    .replace(/\\n/g, "")
    .replace(/\\r/g, "")
    .replace(/[\r\n]+/g, "")
    .trim();

  if (cleaned !== value && cleaned.length > 0) {
    // The literal `\r\n` artifact from `vercel env pull` is a real bug
    // we've seen in production env shape; surface it loudly so a
    // future regression can't hide.
    try {
      captureServerMessage(
        `[env] cleanEnv stripped CR/LF / escape sequence from env value${name ? ` (${name})` : ""}`,
        {
          level: "warning",
          tags: { env_clean: "true", env_var: name ?? "unknown" },
          extra: {
            rawLength: value.length,
            cleanedLength: cleaned.length,
          },
        },
      );
    } catch {
      /* Sentry not initialized in some scripts; non-fatal. */
    }
  }

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Read a Supabase URL / key pair from `process.env`, cleaned. Returns
 * `null` when either is missing. Callers should still null-check.
 */
export function readSupabaseEnv(args: {
  /** "service-role" requires SUPABASE_SERVICE_ROLE_KEY. "anon" falls
   *  back to NEXT_PUBLIC_SUPABASE_ANON_KEY. */
  role: "service-role" | "anon" | "service-role-or-anon";
}): { url: string; key: string } | null {
  const url = cleanEnv(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    "NEXT_PUBLIC_SUPABASE_URL",
  );
  const serviceKey = cleanEnv(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const anonKey = cleanEnv(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  );

  let key: string | undefined;
  if (args.role === "service-role") key = serviceKey;
  else if (args.role === "anon") key = anonKey;
  else key = serviceKey ?? anonKey;

  if (!url || !key) return null;
  return { url, key };
}
