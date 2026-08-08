"use client";

import { useEffect, useMemo, useState } from "react";
import { SignUp, useUser } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Heart, Loader2 } from "lucide-react";

import {
  clearRegistration,
  loadRegistration,
} from "@/components/portal/registration/registration-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type ClaimStatus = "idle" | "linking" | "linked" | "error" | "no-token";

export default function CreateAccountPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSignedIn, isLoaded } = useUser();
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const claimTokenFromUrl = searchParams.get("claim") || "";

  const initialValues = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const reg = loadRegistration();
    if (!reg) return undefined;
    const out: Record<string, string> = {};
    if (reg.email) out.emailAddress = reg.email;
    if (reg.phone) out.phoneNumber = reg.phone;
    if (reg.firstName) out.firstName = reg.firstName;
    if (reg.lastName) out.lastName = reg.lastName;
    return Object.keys(out).length > 0 ? out : undefined;
  }, []);

  // After Clerk sign-up succeeds, attempt to link the new Clerk user to the
  // patient record we created earlier in the no-account flow. The regToken is
  // sourced from the URL (`?claim=...` from the magic-link email) first, then
  // sessionStorage (same-tab continuation).
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const reg = loadRegistration();
    const tokenToUse = claimTokenFromUrl || reg?.regToken || "";

    if (!tokenToUse) {
       
      setClaimStatus("no-token");
      const t = setTimeout(() => router.replace("/dashboard"), 1500);
      return () => clearTimeout(t);
    }

    let cancelled = false;
     
    setClaimStatus("linking");
    (async () => {
      try {
        const res = await fetch("/api/portal/register/claim/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ regToken: tokenToUse }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setErrorMessage(data.error || "We couldn't link your record automatically.");
          setClaimStatus("error");
          return;
        }
        setClaimStatus("linked");
        clearRegistration();
        const t = setTimeout(() => router.replace("/dashboard"), 1200);
        return () => clearTimeout(t);
      } catch {
        if (cancelled) return;
        setErrorMessage("Network error linking your record.");
        setClaimStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, router, claimTokenFromUrl]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-secondary px-4 py-12">
      <div className="mb-8 flex items-center gap-2">
        <Heart className="h-8 w-8 text-primary" fill="currentColor" />
        <span className="font-serif text-2xl font-medium">Herself Health</span>
      </div>

      {!isSignedIn && (
        <SignUp
          signInUrl="/login"
          fallbackRedirectUrl="/register/create-account"
          initialValues={initialValues}
        />
      )}

      {isSignedIn && claimStatus === "linking" && (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p>Linking your visit to your new account&hellip;</p>
        </div>
      )}

      {isSignedIn && claimStatus === "linked" && (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p>Account ready. Taking you to your dashboard&hellip;</p>
        </div>
      )}

      {isSignedIn && claimStatus === "no-token" && (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p>Welcome! Taking you to your dashboard&hellip;</p>
        </div>
      )}

      {isSignedIn && claimStatus === "error" && (
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>We couldn&apos;t finish linking your visit</AlertTitle>
          <AlertDescription>
            {errorMessage} Your account has been created and you can continue
            to your dashboard. We&apos;ll try again the next time you sign in.
          </AlertDescription>
        </Alert>
      )}

      <p className="mt-6 text-center text-xs text-muted-foreground max-w-sm">
        Setting up an account lets you manage upcoming visits, message your
        care team, and view your membership.
      </p>

      <p className="mt-8 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} Herself Health. All rights reserved.
      </p>
    </div>
  );
}
