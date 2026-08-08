import type { Metadata } from "next";
import { StandaloneScheduling } from "@/components/portal/schedule-link/StandaloneScheduling";

export const metadata: Metadata = {
  title: "Schedule a Visit",
  robots: { index: false, follow: false },
};

/**
 * Standalone, unauthenticated scheduling experience reached from an
 * encrypted one-time SMS link: /schedule?t=<token>. The signed token is the
 * credential — there is no Clerk login here (see middleware.ts).
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  return <StandaloneScheduling token={t ?? null} />;
}
