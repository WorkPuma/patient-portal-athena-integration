"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, CheckCircle2, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function RenewContract() {
  const router = useRouter();
  const [renewing, setRenewing] = useState(false);
  const [renewed, setRenewed] = useState(false);
  const [error, setError] = useState("");

  async function handleRenew() {
    setRenewing(true);
    setError("");

    try {
      const res = await fetch("/api/portal/hint/membership/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Renewal failed");
        return;
      }

      setRenewed(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setRenewing(false);
    }
  }

  if (renewed) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-500" />
        <h2 className="mb-2 text-xl font-medium text-foreground">
          Membership Renewed!
        </h2>
        <p className="mb-6 text-muted-foreground">
          Your membership has been successfully renewed.
        </p>
        <Button onClick={() => router.push("/membership")}>
          Back to Membership
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 h-auto px-2 text-muted-foreground" asChild>
        <Link href="/membership">
          <ArrowLeft className="h-4 w-4" />
          Back to Membership
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            <CardTitle className="text-xl font-medium">Renew Membership</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            Renewing will extend your current membership plan for another billing
            period. Your payment method on file will be charged.
          </p>

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not renew</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex gap-3 border-t pt-6">
          <Button variant="outline" className="flex-1" asChild>
            <Link href="/membership">Cancel</Link>
          </Button>
          <Button
            className="flex-1"
            onClick={handleRenew}
            disabled={renewing}
          >
            {renewing ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              "Confirm Renewal"
            )}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
