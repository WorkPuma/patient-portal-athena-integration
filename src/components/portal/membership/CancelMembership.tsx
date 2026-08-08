"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Shield,
  CalendarClock,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trackMembershipCancelInitiated, trackMembershipCancelled } from "@/lib/posthog/events";

interface MembershipInfo {
  startDate: string;
  planName: string;
  status: string;
}

export function CancelMembership() {
  const router = useRouter();
  const [step, setStep] = useState<"confirm" | "reason" | "done">("confirm");
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [withinGuarantee, setWithinGuarantee] = useState(false);
  const [membershipInfo, setMembershipInfo] = useState<MembershipInfo | null>(null);
  const [contractEndDate, setContractEndDate] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/portal/hint/patient");
        if (res.ok) {
          const data = await res.json();
          const m = data.membership;
          if (m) {
            setMembershipInfo({
              startDate: m.startDate,
              planName: m.planName,
              status: m.status,
            });
            const startDate = new Date(m.startDate);
            const days =
              (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24);
            setWithinGuarantee(days <= 30);

            const contractEnd = new Date(startDate);
            contractEnd.setMonth(contractEnd.getMonth() + 12);
            setContractEndDate(
              contractEnd.toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })
            );
          }
        }
      } catch {
        // Non-critical
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleCancel() {
    setCancelling(true);
    setError("");

    try {
      const res = await fetch("/api/portal/hint/membership/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          cancel_at_period_end: !withinGuarantee,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Cancellation failed");
        return;
      }

      trackMembershipCancelled({ withinGuarantee });
      setResultMessage(
        withinGuarantee
          ? "Your membership has been cancelled and a full refund will be issued."
          : "Your membership will remain active until the end of your current billing period. No further charges will be made."
      );
      setStep("done");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <div className="animate-pulse text-center text-muted-foreground">
          Loading membership details...
        </div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-500" />
        <h2 className="mb-2 text-xl font-medium text-foreground">
          Membership Cancelled
        </h2>
        <p className="mb-6 text-muted-foreground">{resultMessage}</p>
        <Button onClick={() => router.push("/membership")}>
          Back to Membership
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-auto px-2 text-muted-foreground"
        asChild
      >
        <Link href="/membership">
          <ArrowLeft className="h-4 w-4" />
          Back to Membership
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <CardTitle className="text-xl font-medium">
              Cancel Membership
            </CardTitle>
          </div>
          {membershipInfo && (
            <p className="mt-1 text-sm text-muted-foreground">
              {membershipInfo.planName} — member since{" "}
              {new Date(membershipInfo.startDate).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {withinGuarantee ? (
            <Alert className="border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/30 dark:text-green-100">
              <Shield className="text-green-600 dark:text-green-400" />
              <AlertTitle>30-Day Money-Back Guarantee</AlertTitle>
              <AlertDescription className="text-green-800 dark:text-green-200">
                You&apos;re within the 30-day guarantee period. Your membership
                will be cancelled immediately and you&apos;ll receive a full
                refund.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <CalendarClock className="text-amber-600 dark:text-amber-400" />
              <AlertTitle>12-Month Contract Obligation</AlertTitle>
              <AlertDescription className="space-y-2 text-amber-800 dark:text-amber-200">
                <p>
                  Your 30-day money-back guarantee has expired. Under your
                  12-month contract, you are obligated to pay for the remainder
                  of the contract period.
                </p>
                <p className="font-medium">
                  Your membership will cancel at the end of your current billing
                  period
                  {contractEndDate ? ` (contract ends ${contractEndDate})` : ""}.
                  No further charges will be made after that date.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {step === "confirm" ? (
            <>
              <p className="text-muted-foreground">
                We&apos;re sorry to see you go. Before you cancel, would you
                like to tell us why? This helps us improve our services.
              </p>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" className="min-w-0 flex-1" asChild>
                  <Link href="/membership">Keep Membership</Link>
                </Button>
                <Button
                  variant="destructive"
                  className="min-w-0 flex-1"
                  onClick={() => {
                    trackMembershipCancelInitiated({ withinGuarantee });
                    setStep("reason");
                  }}
                >
                  Continue with Cancellation
                </Button>
              </div>
            </>
          ) : null}

          {step === "reason" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="cancel-reason">
                  Reason for cancellation (optional)
                </Label>
                <Textarea
                  id="cancel-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="Help us understand why you're leaving..."
                  className="resize-none"
                />
              </div>

              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>Something went wrong</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="min-w-0 flex-1"
                  onClick={() => setStep("confirm")}
                >
                  Go Back
                </Button>
                <Button
                  variant="destructive"
                  className="min-w-0 flex-1"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : withinGuarantee ? (
                    "Cancel & Refund"
                  ) : (
                    "Cancel at Period End"
                  )}
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
