/**
 * Dual-write server exception + message capture (Sentry + PostHog).
 */
import * as Sentry from "@sentry/nextjs";
import { getPostHogServer } from "@/lib/posthog/server";
import { sanitizeProperties } from "@/lib/posthog/sanitize";

export interface CaptureServerExceptionOptions {
  distinctId?: string;
  tags?: Record<string, string>;
  level?: Sentry.SeverityLevel;
  fingerprint?: string[];
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

function phFingerprintProps(fingerprint?: string[]): Record<string, string> {
  if (!fingerprint?.length) return {};
  return { $exception_fingerprint: fingerprint.join("|") };
}

function mirrorToPostHogServer(
  error: unknown,
  opts: {
    distinctId?: string;
    level?: Sentry.SeverityLevel;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    fingerprint?: string[];
  },
): void {
  // Expected SF duplicate/validation paths use warning/info messages.
  // Mirroring those as PostHog exceptions inflates error tracking with
  // handled business outcomes (e.g. "duplicate detected; reusing matched
  // record"). Keep Sentry breadcrumbs; only dual-write real errors.
  const level = opts.level ?? "error";
  if (level !== "error" && level !== "fatal") return;

  try {
    const ph = getPostHogServer();
    if (!ph) return;
    ph.captureException(error, opts.distinctId, sanitizeProperties({
      ...(opts.tags ?? {}),
      ...(opts.extra ?? {}),
      ...phFingerprintProps(opts.fingerprint),
      level,
    }));
    void Promise.resolve(ph.flush?.()).catch(() => { });
  } catch (phError) {
    console.warn("[capture-exception] Failed to mirror to PostHog:", phError);
  }
}

export function captureServerException(
  error: unknown,
  options: CaptureServerExceptionOptions = {},
): string | undefined {
  const { distinctId, tags, level, fingerprint, contexts, extra } = options;
  let eventId: string | undefined;

  try {
    Sentry.withScope((scope) => {
      if (tags) {
        for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
      }
      if (level) scope.setLevel(level);
      if (fingerprint) scope.setFingerprint(fingerprint);
      if (contexts) {
        for (const [key, value] of Object.entries(contexts)) scope.setContext(key, value);
      }
      if (extra) scope.setContext("extra", extra);
      if (distinctId) scope.setUser({ id: distinctId });
      eventId = Sentry.captureException(error);
    });
  } catch (sentryError) {
    console.warn("[capture-exception] Sentry capture failed:", sentryError);
  }

  mirrorToPostHogServer(error, { distinctId, tags, level, extra, fingerprint });
  return eventId;
}

export function captureServerMessage(
  message: string,
  options: CaptureServerExceptionOptions = {},
): string | undefined {
  const { distinctId, tags, level = "error", fingerprint, contexts, extra } = options;
  let eventId: string | undefined;

  try {
    Sentry.withScope((scope) => {
      if (tags) {
        for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
      }
      scope.setLevel(level);
      if (fingerprint) scope.setFingerprint(fingerprint);
      if (contexts) {
        for (const [key, value] of Object.entries(contexts)) scope.setContext(key, value);
      }
      if (extra) scope.setContext("extra", extra);
      if (distinctId) scope.setUser({ id: distinctId });
      eventId = Sentry.captureMessage(message, level);
    });
  } catch (sentryError) {
    console.warn("[capture-exception] Sentry message capture failed:", sentryError);
  }

  mirrorToPostHogServer(new Error(message), {
    distinctId,
    tags,
    level,
    extra,
    fingerprint,
  });
  return eventId;
}
