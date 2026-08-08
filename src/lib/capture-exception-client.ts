"use client";

import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { sanitizeProperties } from "@/lib/posthog/sanitize";

export interface CaptureClientExceptionOptions {
  distinctId?: string;
  tags?: Record<string, string>;
  level?: Sentry.SeverityLevel;
  fingerprint?: string[];
  extra?: Record<string, unknown>;
}

export function captureClientException(
  error: unknown,
  options: CaptureClientExceptionOptions = {},
): void {
  const { distinctId, tags, level, fingerprint, extra } = options;

  try {
    Sentry.withScope((scope) => {
      if (tags) {
        for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
      }
      if (level) scope.setLevel(level);
      if (fingerprint) scope.setFingerprint(fingerprint);
      if (extra) scope.setContext("extra", extra);
      if (distinctId) scope.setUser({ id: distinctId });
      Sentry.captureException(error);
    });
  } catch (sentryError) {
    console.warn("[capture-exception-client] Sentry capture failed:", sentryError);
  }

  try {
    posthog.captureException(error, sanitizeProperties({
      ...(distinctId ? { distinct_id: distinctId } : {}),
      ...(tags ?? {}),
      ...(extra ?? {}),
      ...(fingerprint?.length
        ? { $exception_fingerprint: fingerprint.join("|") }
        : {}),
      ...(level ? { level } : {}),
    }));
  } catch (phError) {
    console.warn("[capture-exception-client] PostHog capture failed:", phError);
  }
}
