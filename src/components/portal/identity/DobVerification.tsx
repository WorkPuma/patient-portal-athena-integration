"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface DobVerificationProps {
  onVerified: () => void;
  className?: string;
}

const DobVerification = ({ onVerified, className }: DobVerificationProps) => {
  const [dob, setDob] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!dob) {
      setError("Please enter your date of birth.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/portal/identity/verify-dob", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dob }),
      });

      if (res.ok) {
        onVerified();
        return;
      }

      const data = await res.json().catch(() => null);
      setError(
        data?.message ||
        "We couldn\u2019t match that date of birth. Please try again or contact support."
      );
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={cn("h-screen bg-background", className)}>
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-6 lg:justify-start">
          <form
            onSubmit={handleSubmit}
            className="flex w-full max-w-sm min-w-sm flex-col items-center gap-y-4 px-6 py-12"
          >
            <Heart
              className="h-10 w-10 text-primary"
              fill="currentColor"
              strokeWidth={0}
            />

            <div className="text-center">
              <h1 className="text-2xl font-semibold">Verify your identity</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                We found multiple records associated with your contact
                information. Please enter your date of birth so we can connect
                you to the correct account.
              </p>
            </div>

            <div className="flex w-full flex-col gap-2">
              <Label htmlFor="dob">Date of birth</Label>
              <Input
                id="dob"
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                max={new Date().toISOString().split("T")[0]}
                className="text-sm"
                required
              />
            </div>

            {error && (
              <p
                className="w-full rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </form>

          <p className="max-w-xs text-center text-xs text-muted-foreground">
            Your health information is protected under HIPAA. We use
            industry-standard encryption to keep your data safe.
          </p>
        </div>
      </div>
    </section>
  );
};

export { DobVerification };
