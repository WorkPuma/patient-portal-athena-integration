"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ArrowLeft,
  CreditCard,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const MEMBERSHIP_AGREEMENT_URL =
  "https://www.example-patient-portal.com/membership-agreement";

// Self-service registrations are billed against a 12-month membership
// contract. Hint stores this on the plan SKU itself; we surface it here so
// the UX makes the commitment explicit before the user pays.
const COMMITMENT_MONTHS = 12;
import {
  loadRegistration,
  registerFetch,
  saveRegistration,
} from "./registration-client";
import {
  RainforestPaymentForm,
  type RainforestPaymentFormHandle,
  type RainforestSetup,
} from "./RainforestPaymentForm";

interface Plan {
  id: string;
  name: string;
  amount_cents: number;
  interval: string;
  description?: string;
}

interface PaymentSetupResponse {
  /**
   * Non-prod (preview / dev) returns `mockMode: true` and omits the Rainforest
   * setup entirely. The client renders a sandbox notice instead of the iframe
   * and the CTA forwards straight to `/membership` (with `skipPaymentCheck`).
   * See payment-setup/route.ts for why — Rainforest's sandbox bundle blows up
   * inside its own sandboxed iframe and `submit()` becomes a silent no-op.
   */
  mockMode?: boolean;
  setup: RainforestSetup | null;
  hintPatientId: string;
  regToken: string | null;
  bundle: string;
}

interface AttachResponse {
  paymentMethod: {
    id: string;
    last_four?: string;
    name?: string;
    type?: string;
  };
  hintPatientId: string;
  regToken: string | null;
}

interface EnrollResponse {
  membership: unknown;
  membershipSummary?: {
    id?: string;
    status?: string;
    bill_date?: string;
    next_bill_date?: string;
    period_rate_in_cents?: number;
    period_in_months?: number;
  };
  hintPatientId?: string;
  regToken?: string | null;
}

const FALLBACK_PLANS: Plan[] = [
  {
    id: "pln-7abVK3P2q8n8",
    name: "Her Membership",
    amount_cents: 99999,
    interval: "year",
    description: "Annual membership — best value.",
  },
];

// "done" used to be a separate full-page interstitial after enrollment, but
// we now navigate straight to /register/schedule from the payment step so the
// CTA placement (bottom-right purple pill) stays consistent with the rest of
// the wizard.
type Step = "plan" | "payment" | "enrolling";

function persistRegToken(regToken: string | null | undefined) {
  if (!regToken) return;
  const reg = loadRegistration();
  if (!reg) return;
  saveRegistration({ ...reg, regToken });
}

function persistHintPatientId(hintPatientId: string | undefined) {
  if (!hintPatientId) return;
  const reg = loadRegistration();
  if (!reg) return;
  saveRegistration({ ...reg, hintPatientId });
}

export function MembershipEnrollment() {
  const router = useRouter();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>("plan");
  const [error, setError] = useState("");

  const [paymentSetup, setPaymentSetup] = useState<PaymentSetupResponse | null>(
    null
  );
  const [paymentSetupLoading, setPaymentSetupLoading] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  // Mirrors Rainforest's iframe state so the CTA can correctly disable when
  // the iframe hasn't loaded or the card form is incomplete, AND so we can
  // surface a clear inline message when the user clicks while invalid
  // (instead of `submit()` silently no-op'ing — see the docs:
  // https://docs.rainforestpay.com/docs/hide-the-submit-button).
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [cardValid, setCardValid] = useState(false);

  // The Rainforest iframe will be torn down + remounted whenever React thinks
  // the iframe needs new props. Re-mounting after a successful "Store details"
  // click is destructive (the payment_method_config_id is single-use), so we
  // hold the in-flight guard in a ref instead of state to keep the
  // handleApproved callback identity stable across re-renders.
  const attachingRef = useRef(false);
  // Same trick for the agreement checkbox — handleApproved is created once
  // and reads the live value from this ref to avoid re-mounting Rainforest.
  const agreementRef = useRef(false);
  useEffect(() => {
    agreementRef.current = agreementAccepted;
  }, [agreementAccepted]);
  // We forward this ref down to the iframe wrapper for forward-compat (we
  // may re-introduce a programmatic submit once Rainforest's events are
  // verified end-to-end on the live bundle), but currently the iframe owns
  // its own submit button.
  const paymentFormRef = useRef<RainforestPaymentFormHandle>(null);

  useEffect(() => {
    if (!loadRegistration()) {
      router.replace("/register");
      return;
    }

    let cancelled = false;
    (async () => {
      const result = await registerFetch<{ plans: Plan[] }>(
        "/api/portal/register/membership/plans"
      );
      if (cancelled) return;
      const fetched =
        result.ok && result.data?.plans?.length
          ? result.data.plans
          : FALLBACK_PLANS;
      setPlans(fetched);
      if (fetched.length === 1) setSelectedPlan(fetched[0].id);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  function formatPrice(cents: number, interval: string): string {
    if (!Number.isFinite(cents) || cents <= 0) return "";
    const dollars = cents / 100;
    const display =
      dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2);
    const suffix =
      interval === "month" ? "/mo" : interval === "year" ? "/yr" : "";
    return `$${display}${suffix}`;
  }

  async function startPayment() {
    if (!selectedPlan) return;
    setError("");
    setPaymentSetupLoading(true);

    const result = await registerFetch<PaymentSetupResponse>(
      "/api/portal/register/membership/payment-setup",
      { method: "POST", body: JSON.stringify({}) }
    );

    setPaymentSetupLoading(false);
    if (!result.ok || !result.data) {
      setError(result.error?.error || "Failed to start payment setup");
      return;
    }

    persistRegToken(result.data.regToken);
    persistHintPatientId(result.data.hintPatientId);
    setPaymentSetup(result.data);
    setStep("payment");
  }

  // Re-fetch a brand new Rainforest session+config and re-mount the form.
  // Rainforest's payment_method_config_id is single-use, so any retry after a
  // failed/declined attempt has to start from a fresh /payment-setup call.
  const refreshPaymentSetup = useCallback(async () => {
    setError("");
    setIframeLoaded(false);
    setCardValid(false);
    setPaymentSetupLoading(true);
    const result = await registerFetch<PaymentSetupResponse>(
      "/api/portal/register/membership/payment-setup",
      { method: "POST", body: JSON.stringify({}) }
    );
    setPaymentSetupLoading(false);
    if (!result.ok || !result.data) {
      setError(result.error?.error || "Couldn't reload the payment form");
      return;
    }
    persistRegToken(result.data.regToken);
    persistHintPatientId(result.data.hintPatientId);
    setPaymentSetup(result.data);
  }, []);

  const handleLoaded = useCallback(() => setIframeLoaded(true), []);
  const handleValidityChange = useCallback(
    (isValid: boolean) => setCardValid(isValid),
    []
  );
  const handleAttempted = useCallback(() => {
    // Rainforest fires `attempted` immediately after a successful submit() —
    // mirror their state into our spinner so the button doesn't appear idle
    // during the round-trip to their backend.
    setAttaching(true);
  }, []);

  // Shared "enroll + navigate" used by both the live (post-Rainforest)
  // approval path and the non-prod mock path. Pulled out so the mock CTA
  // doesn't have to duplicate the spinner/error/persist dance.
  const enrollAndContinue = useCallback(
    async (opts: { skipPaymentCheck: boolean }) => {
      setStep("enrolling");
      const chosenPlan = plans.find((p) => p.id === selectedPlan);
      const periodInMonths = chosenPlan?.interval === "year" ? 12 : 1;
      const enroll = await registerFetch<EnrollResponse>(
        "/api/portal/register/membership",
        {
          method: "POST",
          body: JSON.stringify({
            planId: selectedPlan,
            periodInMonths,
            ...(opts.skipPaymentCheck ? { skipPaymentCheck: true } : {}),
          }),
        }
      );

      if (!enroll.ok || !enroll.data) {
        setError(enroll.error?.error || "Enrollment failed");
        attachingRef.current = false;
        setAttaching(false);
        setStep("payment");
        return false;
      }

      persistRegToken(enroll.data.regToken);
      persistHintPatientId(enroll.data.hintPatientId);
      router.push("/register/schedule");
      return true;
    },
    [selectedPlan, plans, router]
  );

  // Stable across renders — Rainforest only mounts once per session/config.
  // We read live values via refs/state inside, but the callback identity
  // never changes so the iframe is never re-attached mid-flight.
  const handleApproved = useCallback(
    async (rainforestId: string) => {
      if (attachingRef.current) return;
      // Hint won't bill without agreement consent on file. The Rainforest
      // iframe doesn't expose a way for us to disable its Store Details
      // button, so we surface a clear error here instead of silently
      // dropping the click.
      if (!agreementRef.current) {
        setError(
          "Please accept the Her Membership Agreement before saving your payment method."
        );
        return;
      }
      attachingRef.current = true;
      setAttaching(true);
      setError("");

      const attach = await registerFetch<AttachResponse>(
        "/api/portal/register/membership/payment-method",
        {
          method: "POST",
          body: JSON.stringify({ rainforest_id: rainforestId, default: true }),
        }
      );

      if (!attach.ok || !attach.data) {
        setError(
          attach.error?.error ||
          "Failed to save your payment method. Please try again."
        );
        attachingRef.current = false;
        setAttaching(false);
        return;
      }

      persistRegToken(attach.data.regToken);
      persistHintPatientId(attach.data.hintPatientId);

      await enrollAndContinue({ skipPaymentCheck: false });
    },
    [enrollAndContinue]
  );

  // Non-prod CTA path: bypass Rainforest entirely. The Hint patient was
  // already created in /payment-setup, so we just enroll with
  // `skipPaymentCheck` and forward to scheduling.
  const handleMockSubmit = useCallback(async () => {
    if (attachingRef.current) return;
    if (!agreementRef.current) {
      setError(
        "Please accept the Her Membership Agreement before continuing."
      );
      return;
    }
    attachingRef.current = true;
    setAttaching(true);
    setError("");
    await enrollAndContinue({ skipPaymentCheck: true });
  }, [enrollAndContinue]);

  const handleDeclined = useCallback(() => {
    setError(
      "Your payment method was declined. Please double-check the details or try a different card."
    );
  }, []);

  const handlePaymentError = useCallback(() => {
    setError(
      "Something went wrong with the payment form. Please refresh and try again."
    );
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <CreditCard className="h-10 w-10 text-primary mx-auto mb-3" />
          <h1 className="text-xl font-medium text-foreground">
            Membership Enrollment
          </h1>
          <p className="mt-2 text-muted-foreground">
            Patients with commercial insurance are required to join our
            membership program for comprehensive care.
          </p>
        </div>

        <div className="flex items-center gap-2 mb-8">
          {["Demographics", "Insurance", "Membership", "Schedule"].map(
            (label, i) => (
              <div key={label} className="flex-1">
                <div
                  className={cn(
                    "h-1.5 rounded-full",
                    i <= 2 ? "bg-primary" : "bg-muted"
                  )}
                />
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  {label}
                </p>
              </div>
            )
          )}
        </div>

        {step === "plan" && (
          <PlanStep
            plans={plans}
            loading={loading}
            selectedPlan={selectedPlan}
            onSelect={setSelectedPlan}
            onContinue={startPayment}
            startingPayment={paymentSetupLoading}
            error={error}
            formatPrice={formatPrice}
          />
        )}

        {(step === "payment" || step === "enrolling") && paymentSetup && (
          <PaymentStep
            plan={plans.find((p) => p.id === selectedPlan) ?? null}
            mockMode={paymentSetup.mockMode === true}
            setup={paymentSetup.setup}
            bundle={paymentSetup.bundle}
            attaching={attaching || step === "enrolling"}
            error={error}
            setError={setError}
            agreementAccepted={agreementAccepted}
            onAgreementChange={setAgreementAccepted}
            paymentSetupLoading={paymentSetupLoading}
            paymentFormRef={paymentFormRef}
            iframeLoaded={iframeLoaded}
            cardValid={cardValid}
            onApproved={handleApproved}
            onMockSubmit={handleMockSubmit}
            onDeclined={handleDeclined}
            onError={handlePaymentError}
            onLoaded={handleLoaded}
            onValidityChange={handleValidityChange}
            onAttempted={handleAttempted}
            onRetry={refreshPaymentSetup}
            onBack={() => {
              setError("");
              setStep("plan");
            }}
            formatPrice={formatPrice}
          />
        )}
      </div>
    </div>
  );
}

function PlanStep({
  plans,
  loading,
  selectedPlan,
  onSelect,
  onContinue,
  startingPayment,
  error,
  formatPrice,
}: {
  plans: Plan[];
  loading: boolean;
  selectedPlan: string;
  onSelect: (id: string) => void;
  onContinue: () => void;
  startingPayment: boolean;
  error: string;
  formatPrice: (cents: number, interval: string) => string;
}) {
  if (loading) {
    return (
      <div className="space-y-4 py-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {plans.map((plan) => (
        <Button
          key={plan.id}
          type="button"
          variant="outline"
          className={cn(
            "h-auto w-full flex-col items-stretch gap-2 rounded-2xl border-2 p-6 text-left font-normal shadow-none transition-all",
            selectedPlan === plan.id
              ? "border-primary bg-primary/5"
              : "border-border bg-card hover:bg-muted/50"
          )}
          onClick={() => onSelect(plan.id)}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-lg font-medium text-foreground">
              {plan.name}
            </span>
            <span className="text-xl font-semibold text-primary">
              {formatPrice(plan.amount_cents, plan.interval)}
            </span>
          </div>
          {plan.description && (
            <p className="text-sm text-muted-foreground">{plan.description}</p>
          )}
        </Button>
      ))}

      <Alert className="border-border bg-muted/50">
        <AlertTitle>30-Day Money-Back Guarantee</AlertTitle>
        <AlertDescription>
          Try us risk-free. If you&apos;re not satisfied within 30 days,
          we&apos;ll refund your membership in full.
        </AlertDescription>
      </Alert>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button
          variant="link"
          className="text-muted-foreground h-auto p-0"
          asChild
        >
          <Link href="/register/eligibility" className="gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <Button
          size="lg"
          className="rounded-xl min-w-[9rem]"
          onClick={onContinue}
          disabled={!selectedPlan || startingPayment}
        >
          {startingPayment ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <>
              Continue to payment
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function PaymentStep({
  plan,
  mockMode,
  setup,
  bundle,
  attaching,
  error,
  setError,
  agreementAccepted,
  onAgreementChange,
  paymentSetupLoading,
  paymentFormRef,
  iframeLoaded,
  cardValid,
  onApproved,
  onMockSubmit,
  onDeclined,
  onError,
  onLoaded,
  onValidityChange,
  onAttempted,
  onRetry,
  onBack,
  formatPrice,
}: {
  plan: Plan | null;
  mockMode: boolean;
  setup: RainforestSetup | null;
  bundle: string;
  attaching: boolean;
  error: string;
  setError: (next: string) => void;
  agreementAccepted: boolean;
  onAgreementChange: (next: boolean) => void;
  paymentSetupLoading: boolean;
  paymentFormRef: React.RefObject<RainforestPaymentFormHandle | null>;
  iframeLoaded: boolean;
  cardValid: boolean;
  onApproved: (rainforestId: string) => void;
  onMockSubmit: () => void;
  onDeclined: () => void;
  onError: () => void;
  onLoaded: () => void;
  onValidityChange: (isValid: boolean) => void;
  onAttempted: () => void;
  onRetry: () => void;
  onBack: () => void;
  formatPrice: (cents: number, interval: string) => string;
}) {
  const monthly = plan?.interval === "month";

  return (
    <div className="space-y-4">
      {/* Order summary — keep the cost and the 12-month commitment in front
          of the user the entire time they're filling in card details. */}
      {plan && (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-primary">
                Order summary
              </p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">
                {plan.name}
              </h2>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold text-primary">
                {formatPrice(plan.amount_cents, plan.interval)}
              </p>
              <p className="text-xs text-muted-foreground">
                {monthly ? "billed monthly" : "billed annually"}
              </p>
            </div>
          </div>

          <dl className="mt-4 space-y-1.5 border-t border-primary/10 pt-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Commitment</dt>
              <dd className="font-medium text-foreground">
                {COMMITMENT_MONTHS}-month membership
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Billed today</dt>
              <dd className="font-medium text-foreground">
                {formatPrice(plan.amount_cents, plan.interval).replace(
                  /\/(mo|yr)$/,
                  ""
                )}
              </dd>
            </div>
          </dl>

          <div className="mt-3 flex items-start gap-2 rounded-lg bg-background/60 p-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
            <p>
              30-day money-back guarantee. Cancel within the first 30 days for a
              full refund.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="text-base font-medium text-foreground">
          Payment method
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Card or bank account. Charged{" "}
          {monthly ? "monthly for the first year" : "annually"}; cancel anytime
          after the {COMMITMENT_MONTHS}-month commitment.
        </p>
      </div>

      {mockMode ? (
        // Non-prod: skip Rainforest entirely. The Hint patient is already
        // created (in /payment-setup) and the CTA forwards straight to enroll
        // with `skipPaymentCheck`. Surface a clear sandbox notice so QA isn't
        // confused by the missing card form.
        <div
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          data-testid="payment-mock-notice"
        >
          <p className="font-medium">Sandbox environment — payment skipped</p>
          <p className="mt-1 text-amber-900/80">
            No card will be collected or charged. Click{" "}
            <strong>Save card &amp; continue</strong> to apply the membership
            plan to the Hint patient and proceed to scheduling.
          </p>
        </div>
      ) : setup ? (
        // Rainforest's inline "Store details" button is hidden via
        // `hide-button`; the purple-pill CTA below drives submission via the
        // forwarded ref. We track Rainforest's `loaded`, `valid`, `invalid`,
        // and `attempted` events so the CTA can correctly disable while the
        // iframe boots / the card form is incomplete (otherwise `submit()`
        // is a silent no-op per
        // https://docs.rainforestpay.com/docs/hide-the-submit-button).
        <RainforestPaymentForm
          ref={paymentFormRef}
          setup={setup}
          bundle={bundle}
          hideInlineButton
          onApproved={onApproved}
          onDeclined={onDeclined}
          onError={onError}
          onLoaded={onLoaded}
          onValidityChange={onValidityChange}
          onAttempted={onAttempted}
        />
      ) : null}

      <label
        htmlFor="membership-agreement"
        className={cn(
          "flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors",
          agreementAccepted
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-card hover:bg-muted/50"
        )}
      >
        <input
          id="membership-agreement"
          type="checkbox"
          checked={agreementAccepted}
          onChange={(e) => onAgreementChange(e.target.checked)}
          disabled={attaching}
          className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-input text-primary focus:ring-2 focus:ring-ring"
        />
        <span className="text-sm text-foreground">
          I agree to the{" "}
          <a
            href={MEMBERSHIP_AGREEMENT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:no-underline"
          >
            Her Membership Agreement
          </a>
          , including the {COMMITMENT_MONTHS}-month commitment and authorize
          Herself Health to charge the payment method above
          {monthly ? " each month" : " annually"} until cancelled.
        </span>
      </label>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Payment error</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <p className="mt-2">
              The payment form locks after one attempt — tap{" "}
              <strong>Try a different card</strong> below to reload it with a
              fresh session.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Surface why the CTA is disabled — Rainforest's iframe gives no
          inline hint about loading / incomplete-card states, so without
          this the button just looks broken. (Mock mode skips card gating
          entirely, so only the agreement hint is relevant there.) */}
      {!error && !mockMode && agreementAccepted && (!iframeLoaded || !cardValid) && (
        <p className="text-xs text-muted-foreground text-right">
          {!iframeLoaded
            ? "Loading secure payment form…"
            : "Complete your card details to continue."}
        </p>
      )}
      {!error && !agreementAccepted && (mockMode || (iframeLoaded && cardValid)) && (
        <p className="text-xs text-muted-foreground text-right">
          Accept the membership agreement to continue.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button
          variant="link"
          className="text-muted-foreground h-auto p-0"
          onClick={onBack}
          disabled={attaching}
          type="button"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          {error && (
            <Button
              variant="outline"
              type="button"
              onClick={onRetry}
              disabled={attaching || paymentSetupLoading}
            >
              {paymentSetupLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Try a different card"
              )}
            </Button>
          )}
          <Button
            type="button"
            size="lg"
            className="rounded-xl min-w-[12rem]"
            disabled={
              !agreementAccepted ||
              attaching ||
              paymentSetupLoading ||
              (!mockMode && (!iframeLoaded || !cardValid))
            }
            onClick={() => {
              setError("");
              if (mockMode) {
                onMockSubmit();
                return;
              }
              if (!iframeLoaded) {
                setError("Payment form is still loading — please wait a moment.");
                return;
              }
              if (!cardValid) {
                setError(
                  "Please fill in all required card details before continuing."
                );
                return;
              }
              if (!paymentFormRef.current) {
                setError(
                  "Payment form isn't ready yet. Please refresh and try again."
                );
                return;
              }
              paymentFormRef.current.submit();
            }}
          >
            {attaching ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Save card &amp; continue
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Internal export used only by `MembershipEnrollment.test.tsx` so the
// payment-step UX (CTA gating, ref-driven submit) can be asserted without
// having to drive the upstream plan-selection step + `/plans` fetch in the
// test harness. The leading underscore signals "do not import in app code".
export { PaymentStep as __PaymentStepForTesting };
