/**
 * Server-side PostHog singleton (posthog-node).
 *
 * Use from API route handlers, Server Actions, and Edge functions to record
 * events that originated server-side (e.g. webhook callbacks, scheduled
 * jobs, post-book confirmations). The browser SDK in `instrumentation-
 * client.ts` covers all client-side capture; this file is only for events
 * the browser can't see.
 *
 * HIPAA: same rules as the client SDK. `distinctId` MUST be an opaque
 * value — either a Clerk user id (`user_*`) or a salted SHA-256 of an
 * upstream identifier via `hashToOpaqueDistinctId`. Raw Athena patient
 * ids, member ids, MRNs, emails etc. are rejected at runtime by
 * `assertOpaqueDistinctId` and the event is dropped. Event property
 * keys are filtered through `sanitizeProperties` to strip any known
 * PHI/PII field name (see `BLOCKED_PROPERTY_KEYS`).
 */

import "server-only";
import { PostHog } from "posthog-node";
import * as Sentry from "@sentry/nextjs";
import {
  analyticsSuperProperties,
  shouldCapturePostHog,
} from "./environment";
import { assertOpaqueDistinctId, sanitizeProperties } from "./sanitize";

function reportAnalyticsError(err: unknown, op: string): void {
  // Mirror the pattern used elsewhere in the BFF: never re-throw, but do
  // surface the error to Sentry as a warning-level breadcrumb so PostHog
  // outages are visible in the same dashboard that catches Athena / SF
  // failures. Tagged distinctly so it doesn't pollute critical alerts.
  try {
    Sentry.captureException(err, {
      level: "warning",
      tags: { component: "posthog-server", op },
    });
  } catch {
    // ignore — Sentry shouldn't be able to break the request either
  }
}

let client: PostHog | null = null;

export function getPostHogServer(): PostHog | null {
  const key =
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ||
    process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (client) return client;
  // Server-side SDK hits PostHog ingest directly (no ad-blockers on the server).
  client = new PostHog(key, {
    host: process.env.POSTHOG_SERVER_HOST || "https://us.i.posthog.com",
    // Server flushes more aggressively than the browser because Vercel
    // serverless functions exit quickly after the response returns.
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true,
  });
  return client;
}

/**
 * Capture a server-side event and flush immediately so the function can
 * exit cleanly. NEVER throws — analytics must not break the request path.
 */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  try {
    if (!shouldCapturePostHog()) return;
    const ph = getPostHogServer();
    if (!ph) return;
    // PostHog is first-party BAA analytics — never consent-gated. Advertising
    // pixels stay grant-only via MarketingConsentGate. Defense-in-depth:
    // reject non-opaque IDs and strip blocked PHI/PII property keys before
    // the SDK-level mask layer ever sees the event.
    if (!assertOpaqueDistinctId(distinctId)) return;
    ph.capture({
      distinctId,
      event,
      properties: sanitizeProperties({
        ...analyticsSuperProperties(),
        ...properties,
      }),
    });
    await ph.flush();
  } catch (err) {
    // Never let analytics break a request — but DO surface to Sentry so
    // a PostHog outage / SDK regression is visible operationally.
    reportAnalyticsError(err, `capture:${event}`);
  }
}

/**
 * Set person properties on a server-identified profile. NEVER throws.
 *
 * HIPAA: `distinctId` MUST be opaque (Clerk id or `hashToOpaqueDistinctId`),
 * and properties are run through `sanitizeProperties` which strips known
 * PHI/PII keys (email, name, phone, DOB, member id, …). This is how we
 * "identify" a person server-side WITHOUT ever sending raw email/name — only
 * categorical linkage props (salesforce_lead_id, lead_source, utm_*).
 */
export async function identifyServerPerson(
  distinctId: string,
  properties: Record<string, unknown>
): Promise<void> {
  try {
    if (!shouldCapturePostHog()) return;
    const ph = getPostHogServer();
    if (!ph) return;
    if (!assertOpaqueDistinctId(distinctId)) return;
    ph.identify({
      distinctId,
      properties: sanitizeProperties(properties),
    });
    await ph.flush();
  } catch (err) {
    reportAnalyticsError(err, "identify");
  }
}

/**
 * Shut down the singleton (call from instrumentation.ts onShutdown if you
 * add one). Safe to call multiple times.
 */
export async function shutdownPostHogServer(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    reportAnalyticsError(err, "shutdown");
  } finally {
    client = null;
  }
}
