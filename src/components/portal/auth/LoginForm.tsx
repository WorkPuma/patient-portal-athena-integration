"use client";

import { SignIn, useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { getClientPortalFeatureFlags } from "@/lib/portal/feature-flags";
import {
  PORTAL_LOGO_URL,
  PORTAL_LOGO_ALT,
  PORTAL_LOGO_WIDTH,
  PORTAL_LOGO_HEIGHT,
} from "@/lib/portal-branding";

export function LoginForm() {
  const { isSignedIn, isLoaded } = useUser();
  const router = useRouter();
  const authUiEnabled = getClientPortalFeatureFlags().authUi;

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      router.replace("/dashboard");
    }
  }, [isLoaded, isSignedIn, router]);

  if (!isLoaded || isSignedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-secondary px-4 py-12">
      <div className="mb-8">
        <Image
          src={PORTAL_LOGO_URL}
          alt={PORTAL_LOGO_ALT}
          width={PORTAL_LOGO_WIDTH}
          height={PORTAL_LOGO_HEIGHT}
          priority
          unoptimized
          className="h-10 w-auto"
        />
      </div>

      <SignIn fallbackRedirectUrl="/dashboard" />

      {authUiEnabled && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          New patient?{" "}
          <Link
            href="/register"
            className="font-medium text-primary hover:underline"
          >
            Register here
          </Link>
        </p>
      )}

      <p className="mt-6 text-center text-xs text-muted-foreground max-w-sm">
        Your health information is protected under HIPAA. We use
        industry-standard encryption to keep your data safe.
      </p>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} Herself Health. All rights reserved.
      </p>
    </div>
  );
}
