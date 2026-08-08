import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";

export const metadata = {
  title: "Completing sign-in",
  robots: { index: false, follow: false },
};

/**
 * Clerk enterprise SSO / OAuth redirect landing on the primary domain.
 * Completes the handshake then sends the user to redirectUrlComplete
 * (allowlisted /admin URL on marketing).
 */
export default function SsoCallbackPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Completing employee sign-in…</p>
      <AuthenticateWithRedirectCallback />
    </div>
  );
}
