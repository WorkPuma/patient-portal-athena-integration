"use client";

/**
 * Brand-driven eligibility step for the Stedi rollout (DEV-3961).
 *
 * Replaces the 400+ Athena package autocomplete with a curated 11-card brand
 * picker. Posts a single combined call to /api/portal/register/eligibility,
 * which runs Stedi 270, reverse-resolves the 271 to an Athena
 * `insurancepackageid`, attaches insurance, and returns a NormalizedEligibility
 * the result view renders directly (no X12 jargon shown to the patient).
 *
 * Gated by NEXT_PUBLIC_ENABLE_STEDI_ELIGIBILITY at the page level — the
 * legacy `EligibilityCheck.tsx` component is rendered when the flag is off,
 * so rollback is a one-line env change.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CalendarCheck2,
  CheckCircle2,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldQuestion,
  XCircle,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  loadRegistration,
  loadRegistrationDraft,
  registerFetch,
  saveRegistrationDraft,
  saveRegistrationInsurance,
} from "./registration-client";
import { InsuranceLogo } from "./InsuranceLogo";
import { getClientPortalFeatureFlags } from "@/lib/portal/feature-flags";

// ── Types ────────────────────────────────────────────────────────────
interface BrandCard {
  brandId: string;
  displayName: string;
  subtitle: string | null;
  productHint: "commercial" | "medicare" | "medicaid" | "tricare" | "va" | "other";
  isGovernmentFunded: boolean;
  guidedHandoff: boolean;
  enrollmentPending: boolean;
}

interface NormalizedEligibility {
  coverageStatus: "active" | "inactive" | "unknown";
  payerName: string | null;
  planName: string | null;
  groupNumber: string | null;
  groupName: string | null;
  planBeginDate: string | null;
  planEndDate: string | null;
  coveredThrough: string | null;
  activeServiceTypes: string[];
  otherPayers: Array<{
    name: string | null;
    ediId: string | null;
    insuranceTypeCode: string | null;
  }>;
  rejectionCodes: string[];
}

interface PlanDisplayPayload {
  carrierName: string;
  planLabel: string;
  coverageCategory:
  | "commercial"
  | "medicare"
  | "medicare_advantage"
  | "medicare_supplement"
  | "medicaid"
  | "tricare"
  | "champva_va"
  | "federal_employee"
  | "unknown";
  skipMembership: boolean;
  needsConfirmation: boolean;
  patientFriendlyReason: string;
}

interface EligibilityResponse {
  eligibility: NormalizedEligibility;
  rejectionMessage: string | null;
  brandId: string;
  stediPayerIdUsed: string | null;
  insurancepackageid: number | null;
  insuranceplanname: string | null;
  isGovernmentFunded: boolean;
  confidence: "id-match" | "deterministic" | "heuristic" | "fallback" | "unresolved";
  /** True when the resolver picked a package via popularity / dominant-package fallback. UI must require confirmation. */
  lowConfidence?: boolean;
  /** Server-built view-model. Safe to render directly; no raw IDs. */
  planDisplay?: PlanDisplayPayload;
  insurance: { insuranceid: string; alreadyExisted: boolean } | null;
  insuranceIdSynthesized: boolean;
  attachError: string | null;
  guidedHandoff?: boolean;
  message?: string;
  /** True when the server soft-failed (Stedi outage / Athena attach 5xx). */
  soft?: boolean;
  /**
   * Server-set: true when no usable insurance package is attached to the
   * Athena patient record. Athena rejects appointment creation without
   * one, so the wizard ends here with a friendly handoff. The Lead has
   * already been created so back-office can finish booking.
   */
  endFlow?: boolean;
  /** Patient-facing handoff copy shown when `endFlow` is true. */
  handoffMessage?: string;
}

interface FormDraft {
  brandId: string;
  memberId: string;
  groupNumber: string;
  relationshiptoinsuredid: string;
  policyholderFirstName: string;
  policyholderLastName: string;
  policyholderDob: string;
}

const DEFAULT_FORM: FormDraft = {
  brandId: "",
  memberId: "",
  groupNumber: "",
  relationshiptoinsuredid: "1",
  policyholderFirstName: "",
  policyholderLastName: "",
  policyholderDob: "",
};

type Step = "pick" | "form" | "checking" | "confirm" | "result";

// ── Component ────────────────────────────────────────────────────────
export function EligibilityCheckBrand() {
  const router = useRouter();

  const [brands, setBrands] = useState<BrandCard[]>([]);
  const [brandsLoading, setBrandsLoading] = useState(true);
  const [brandsError, setBrandsError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("pick");
  const [form, setForm] = useState<FormDraft>(DEFAULT_FORM);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");

  const [result, setResult] = useState<EligibilityResponse | null>(null);

  // Bounce back to start if there's no active registration token.
  useEffect(() => {
    if (!loadRegistration()) {
      router.replace("/register");
    }
  }, [router]);

  // Rehydrate the form so a Back navigation from membership/schedule lands
  // the user where they left off (mirrors EligibilityCheck.tsx).
  useEffect(() => {
    const draft = loadRegistrationDraft<Partial<FormDraft>>("eligibility");
    if (draft) {
       
      setForm((prev) => ({ ...prev, ...draft }));
      if (draft.brandId) {

        setStep("form");
      }
    }

    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveRegistrationDraft("eligibility", form);
  }, [form, hydrated]);

  // Load the brand catalog from the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await registerFetch<{ brands: BrandCard[] }>(
        "/api/portal/register/insurance/brands"
      );
      if (cancelled) return;
      if (res.ok && res.data) {
        setBrands(res.data.brands);
      } else {
        setBrandsError(
          res.error?.error || "Couldn't load insurance brands. Please refresh."
        );
      }
      setBrandsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = useCallback((field: keyof FormDraft, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  function handlePickBrand(brand: BrandCard) {
    setForm((prev) => ({ ...prev, brandId: brand.brandId }));
    setError("");
    setStep("form");
  }

  function handleBackToPick() {
    setStep("pick");
    setError("");
  }

  const selectedBrand = brands.find((b) => b.brandId === form.brandId) || null;
  const isMedicare = selectedBrand?.brandId === "medicare";
  const isBcbs = selectedBrand?.brandId === "bcbs";
  const isHandoff = !!selectedBrand?.guidedHandoff;
  const memberIdLabel = isMedicare
    ? "Medicare Beneficiary Identifier (MBI)"
    : "Member ID";
  const memberIdHint = isMedicare
    ? "11 characters, mixed letters and numbers — found on your red, white, and blue Medicare card."
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!selectedBrand) {
      setError("Please pick your insurance carrier first.");
      return;
    }

    if (isHandoff) {
      // Guided-handoff brands skip Stedi/Athena, but we still call the
      // eligibility endpoint so the server records a
      // `portal_registration_followups` row. Without this round-trip the
      // audit log would be missing the eligibility step for these patients
      // (CodeAnt Architect HIGH on PR #23).
      setStep("checking");
      const handoffRes = await registerFetch<EligibilityResponse>(
        "/api/portal/register/eligibility",
        {
          method: "POST",
          body: JSON.stringify({
            brandId: form.brandId,
            memberId: form.memberId.trim() || undefined,
            groupNumber: form.groupNumber.trim() || undefined,
          }),
        }
      );
      if (!handoffRes.ok) {
        setError(
          handoffRes.error?.error ||
          "We couldn't save your insurance info. Please try again."
        );
        setStep("form");
        return;
      }
      // Persist a stub keyed off the selected brand so the scheduler can
      // still pick the correct Initial Visit type (commercial -> MBR vs
      // Medicare -> 90m). Without this, the registration session ends up
      // with no insurance row and the scheduler falls back to the
      // standard 90m visit even for commercial patients who hit the
      // guided handoff.
      saveRegistrationInsurance({
        insurancepackageid: 0,
        insuranceplanname:
          selectedBrand.displayName || "To be verified at clinic",
        insuranceId: form.memberId.trim() || "",
        isGovernmentFunded: selectedBrand.isGovernmentFunded,
      });
      router.push("/register/schedule");
      return;
    }

    const relationshipId = parseInt(form.relationshiptoinsuredid, 10) || 1;
    if (relationshipId !== 1) {
      // Non-Self requires policyholder demographics; without them the server
      // returns SUBSCRIBER_INCOMPLETE. Fail fast on the client for clarity.
      if (
        !form.policyholderFirstName ||
        !form.policyholderLastName ||
        !form.policyholderDob
      ) {
        setError(
          "When the policyholder isn't you, please enter their first name, last name, and date of birth."
        );
        return;
      }
    }

    setStep("checking");

    const res = await registerFetch<EligibilityResponse>(
      "/api/portal/register/eligibility",
      {
        method: "POST",
        body: JSON.stringify({
          brandId: form.brandId,
          memberId: form.memberId.trim(),
          groupNumber: form.groupNumber.trim() || undefined,
          relationshiptoinsuredid: relationshipId,
          ...(relationshipId !== 1
            ? {
              policyholder: {
                firstName: form.policyholderFirstName,
                lastName: form.policyholderLastName,
                dob: form.policyholderDob,
              },
            }
            : {}),
        }),
      }
    );

    if (!res.ok || !res.data) {
      setError(
        res.error?.error ||
        "We couldn't run your eligibility check. Please try again."
      );
      setStep("form");
      return;
    }

    setResult(res.data);

    // Don't persist the picked package yet when the resolver flagged this as
    // low-confidence (popularity / dominant-package fallback). We hold the
    // Athena attach in flight and ask the patient to confirm or correct the
    // pick, which preserves the auditing-friendly path of "patient said yes
    // to plan X" before scheduling. See Theme H.1 / docs.
    const needsConfirm =
      res.data.lowConfidence ||
      res.data.planDisplay?.needsConfirmation === true;

    if (res.data.insurancepackageid && !needsConfirm) {
      saveRegistrationInsurance({
        insurancepackageid: res.data.insurancepackageid,
        insuranceplanname:
          res.data.insuranceplanname ||
          res.data.eligibility.planName ||
          selectedBrand.displayName,
        insuranceId: res.data.insurance?.insuranceid || "",
        isGovernmentFunded: res.data.isGovernmentFunded,
      });
    } else if (!needsConfirm) {
      // Stedi or Athena couldn't auto-resolve a package — the patient
      // will see the "We'll verify your coverage with you" soft-fail
      // page and click Continue to reach scheduling. Persist a stub
      // derived from the selected brand so the Initial Visit
      // scheduler's variant classifier still picks the correct
      // appointment type (commercial -> MBR Initial Visit 461,
      // Medicare/govt -> Initial Visit 47). Without this stub the
      // session ends up insurance-less and every soft-fail patient
      // would book a 90m standard Initial Visit regardless of payer.
      saveRegistrationInsurance({
        insurancepackageid: 0,
        insuranceplanname:
          res.data.insuranceplanname ||
          res.data.eligibility?.planName ||
          selectedBrand.displayName,
        insuranceId:
          res.data.insurance?.insuranceid || form.memberId.trim() || "",
        isGovernmentFunded:
          res.data.isGovernmentFunded ?? selectedBrand.isGovernmentFunded,
      });
    }

    setStep(needsConfirm ? "confirm" : "result");
  }

  function handlePlanConfirmed() {
    if (!result || !selectedBrand) return;
    if (result.insurancepackageid) {
      saveRegistrationInsurance({
        insurancepackageid: result.insurancepackageid,
        insuranceplanname:
          result.planDisplay?.planLabel ||
          result.insuranceplanname ||
          result.eligibility.planName ||
          selectedBrand.displayName,
        insuranceId: result.insurance?.insuranceid || "",
        isGovernmentFunded: result.isGovernmentFunded,
      });
    }
    setStep("result");
  }

  function handlePlanRejected() {
    setStep("form");
    setResult(null);
    setError(
      "No problem — please double-check your member ID, group number, or carrier and we'll try again."
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <Shield className="h-10 w-10 text-primary mx-auto mb-3" />
          <h1 className="text-xl font-medium text-foreground">
            Insurance Eligibility
          </h1>
          <p className="mt-2 text-muted-foreground">
            Pick your insurance carrier — we&apos;ll verify your coverage in a
            few seconds.
          </p>
        </div>

        <div className="flex items-center gap-2 mb-8">
          {["Your info", "Insurance", "Membership", "Choose a visit time"].map(
            (label, i) => (
              <div key={label} className="flex-1">
                <div
                  className={cn(
                    "h-1.5 rounded-full",
                    i <= 1 ? "bg-primary" : "bg-muted"
                  )}
                />
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  {label}
                </p>
              </div>
            )
          )}
        </div>

        <Card>
          <CardContent className="space-y-5 pt-6">
            {step === "pick" && (
              <div className="space-y-5">
                <BrandPicker
                  brands={brands}
                  loading={brandsLoading}
                  error={brandsError}
                  selectedBrandId={form.brandId}
                  onPick={handlePickBrand}
                />
                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="link"
                    className="text-muted-foreground h-auto p-0"
                    asChild
                  >
                    <Link href="/register" className="gap-1">
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </Link>
                  </Button>
                </div>
              </div>
            )}

            {step === "form" && selectedBrand && (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="rounded-lg border border-border bg-muted/40 p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <InsuranceLogo brandId={selectedBrand.brandId} size={36} />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {selectedBrand.displayName}
                      </p>
                      {selectedBrand.subtitle && (
                        <p className="text-xs text-muted-foreground">
                          {selectedBrand.subtitle}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleBackToPick}
                  >
                    Change
                  </Button>
                </div>

                {isHandoff ? (
                  <Alert>
                    <ShieldQuestion className="h-4 w-4" />
                    <AlertTitle>We&apos;ll verify with you</AlertTitle>
                    <AlertDescription>
                      No problem — you can continue to scheduling and our team
                      will verify your insurance before your first visit.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="memberId">{memberIdLabel} *</Label>
                      <Input
                        id="memberId"
                        type="text"
                        required
                        autoComplete="off"
                        inputMode="text"
                        value={form.memberId}
                        onChange={(e) =>
                          updateField("memberId", e.target.value)
                        }
                      />
                      {memberIdHint && (
                        <p className="text-xs text-muted-foreground">
                          {memberIdHint}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="groupNumber">
                          Group number
                          {isBcbs && (
                            <span className="text-muted-foreground font-normal">
                              {" "}
                              (recommended)
                            </span>
                          )}
                        </Label>
                        <Input
                          id="groupNumber"
                          type="text"
                          autoComplete="off"
                          value={form.groupNumber}
                          onChange={(e) =>
                            updateField("groupNumber", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="relationship">
                          Relationship to insured
                        </Label>
                        <Select
                          value={form.relationshiptoinsuredid}
                          onValueChange={(v: string) =>
                            updateField("relationshiptoinsuredid", v)
                          }
                        >
                          <SelectTrigger id="relationship" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">Self</SelectItem>
                            <SelectItem value="2">Spouse</SelectItem>
                            <SelectItem value="3">Child</SelectItem>
                            <SelectItem value="4">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {form.relationshiptoinsuredid !== "1" && (
                      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                        <p className="text-sm text-muted-foreground">
                          Tell us about the policyholder.
                        </p>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="phFirst">First name *</Label>
                            <Input
                              id="phFirst"
                              type="text"
                              required
                              value={form.policyholderFirstName}
                              onChange={(e) =>
                                updateField(
                                  "policyholderFirstName",
                                  e.target.value
                                )
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="phLast">Last name *</Label>
                            <Input
                              id="phLast"
                              type="text"
                              required
                              value={form.policyholderLastName}
                              onChange={(e) =>
                                updateField(
                                  "policyholderLastName",
                                  e.target.value
                                )
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="phDob">Date of birth *</Label>
                          <Input
                            id="phDob"
                            type="date"
                            required
                            value={form.policyholderDob}
                            onChange={(e) =>
                              updateField("policyholderDob", e.target.value)
                            }
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

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
                    <Link href="/register" className="gap-1">
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </Link>
                  </Button>
                  <Button type="submit" size="lg" className="rounded-xl">
                    {isHandoff ? "Continue to Scheduling" : "Check Eligibility"}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            )}

            {step === "checking" && (
              <div className="flex flex-col items-center gap-4 py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">
                  Verifying your coverage with{" "}
                  {selectedBrand?.displayName ?? "your carrier"}...
                </p>
              </div>
            )}

            {step === "confirm" && result && selectedBrand && (
              <PlanConfirmation
                brand={selectedBrand}
                result={result}
                onConfirm={handlePlanConfirmed}
                onReject={handlePlanRejected}
              />
            )}

            {step === "result" && result && selectedBrand && (
              <ResultView
                brand={selectedBrand}
                result={result}
                onTryAgain={() => {
                  setStep("form");
                  setResult(null);
                }}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Brand picker ─────────────────────────────────────────────────────
function BrandPicker(props: {
  brands: BrandCard[];
  loading: boolean;
  error: string | null;
  selectedBrandId: string;
  onPick: (brand: BrandCard) => void;
}) {
  const { brands, loading, error, selectedBrandId, onPick } = props;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load carriers</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-base">Pick your insurance carrier</Label>
        <p className="text-sm text-muted-foreground mt-1">
          Don&apos;t see yours? Pick{" "}
          <strong>I don&apos;t see my plan</strong> at the bottom and we&apos;ll
          take it from there.
        </p>
      </div>
      <div
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        role="radiogroup"
        aria-label="Insurance carrier"
      >
        {brands.map((brand) => {
          const selected = brand.brandId === selectedBrandId;
          return (
            <button
              key={brand.brandId}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onPick(brand)}
              className={cn(
                "flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors",
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background"
              )}
            >
              <InsuranceLogo brandId={brand.brandId} size={40} className="shrink-0" />
              <span className="flex flex-col">
                <span className="font-medium text-foreground">
                  {brand.displayName}
                </span>
                {brand.subtitle && (
                  <span className="text-xs text-muted-foreground mt-0.5">
                    {brand.subtitle}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Result view ──────────────────────────────────────────────────────
function ResultView(props: {
  brand: BrandCard;
  result: EligibilityResponse;
  onTryAgain: () => void;
}) {
  const { brand, result, onTryAgain } = props;
  const { eligibility } = result;
  // Membership only routes when we have a confidently verified, active,
  // non-government commercial plan. Anything indeterminate — coverage that
  // didn't come back active, a soft-failed Stedi/Athena attach, low resolver
  // confidence, or a server view-model that asked us to skip — sends the
  // patient straight to scheduling. 90% of patients are commercial-active so
  // they still see Membership; everyone else is protected from being asked
  // to enroll in a plan that may not even apply to them. See
  // docs/portal/coverage-classification-sanity-check.md.
  const planDisplaySkipMembership = result.planDisplay?.skipMembership ?? false;
  const indeterminate =
    eligibility.coverageStatus !== "active" ||
    !!result.attachError ||
    !!result.soft ||
    result.confidence === "fallback" ||
    result.confidence === "unresolved" ||
    !result.insurancepackageid;
  const membershipEnabled = getClientPortalFeatureFlags().membership;
  const skipMembership =
    !membershipEnabled ||
    indeterminate ||
    planDisplaySkipMembership ||
    result.isGovernmentFunded ||
    brand.isGovernmentFunded;
  const nextHref = skipMembership
    ? "/register/schedule"
    : `/register/membership${result.insurance?.insuranceid
      ? `?insuranceId=${result.insurance.insuranceid}`
      : ""
    }`;
  const nextLabel = skipMembership ? "Schedule Visit" : "Enroll in Membership";

  // Early-exit handoff: Stedi/Athena couldn't land a usable insurance
  // package, so booking is impossible. Show the friendly handoff page —
  // back-office takes it from here. Lead has already been created.
  if (result.endFlow) {
    return (
      <div className="space-y-5">
        <div className="text-center">
          <ShieldQuestion className="h-12 w-12 text-amber-500 mx-auto mb-3" />
          <h2 className="text-lg font-medium text-foreground">
            We&apos;ll take it from here
          </h2>
        </div>
        <Alert>
          <AlertDescription className="text-sm leading-relaxed">
            {result.handoffMessage ??
              result.message ??
              "Thanks. Our team will reach out within one business day to verify your insurance and finish booking your visit."}
          </AlertDescription>
        </Alert>
        <p className="text-sm text-muted-foreground text-center">
          You can call us any time at{" "}
          <a
            href="tel:+18882901209"
            className="font-medium text-foreground whitespace-nowrap"
          >
            555-123-4567
          </a>
          .
        </p>
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="link"
            className="text-muted-foreground h-auto p-0"
            onClick={onTryAgain}
          >
            <span className="inline-flex items-center gap-1">
              <ArrowLeft className="h-4 w-4" />
              Try a different carrier
            </span>
          </Button>
          <Button size="lg" className="rounded-xl" asChild>
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (eligibility.coverageStatus === "active") {
    return (
      <div className="space-y-5">
        <div className="text-center">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
          <h2 className="text-lg font-medium text-foreground">
            Coverage verified
          </h2>
          <p className="text-sm text-muted-foreground">
            We have your insurance details on file.
          </p>
        </div>

        <dl className="rounded-lg border border-border divide-y divide-border text-sm">
          {eligibility.payerName && (
            <Row label="Payer" value={eligibility.payerName} />
          )}
          {(eligibility.planName || result.insuranceplanname) && (
            <Row
              label="Plan"
              value={eligibility.planName ?? result.insuranceplanname ?? ""}
            />
          )}
          {eligibility.groupName && (
            <Row label="Group" value={eligibility.groupName} />
          )}
          {eligibility.groupNumber && (
            <Row label="Group #" value={eligibility.groupNumber} />
          )}
          {eligibility.coveredThrough && (
            <Row
              label="Covered through"
              value={
                <span className="inline-flex items-center gap-1">
                  <CalendarCheck2 className="h-3.5 w-3.5 text-green-600" />
                  {eligibility.coveredThrough}
                </span>
              }
            />
          )}
        </dl>

        <p className="text-sm text-muted-foreground">
          {skipMembership
            ? "Next, schedule your first visit."
            : "Next, continue to Membership enrollment."}
        </p>

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="link"
            className="text-muted-foreground h-auto p-0"
            asChild
          >
            <Link href="/register" className="gap-1">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          <Button size="lg" className="rounded-xl" asChild>
            <Link href={nextHref}>
              {nextLabel}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (eligibility.coverageStatus === "inactive") {
    return (
      <div className="text-center py-8">
        <XCircle className="h-12 w-12 text-destructive/80 mx-auto mb-4" />
        <h2 className="text-lg font-medium text-foreground mb-2">
          Coverage looks inactive
        </h2>
        <p className="text-muted-foreground mb-6">
          Your carrier returned this plan as inactive. Please double-check your
          card or contact your insurer.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Button
            variant="outline"
            size="lg"
            className="rounded-xl"
            onClick={onTryAgain}
          >
            Try Again
          </Button>
          <Button size="lg" className="rounded-xl" asChild>
            <Link href="/register/schedule">Continue Anyway</Link>
          </Button>
        </div>
      </div>
    );
  }

  // unknown — AAA, enrollment-pending, soft-failed (Stedi outage / Athena
  // attach 5xx), or otherwise unverifiable. The patient never sees a
  // technical failure here — same friendly handoff for every cause, and
  // back-office picks up the followup row to verify before their visit.
  return (
    <div className="text-center py-8">
      <ShieldAlert className="h-12 w-12 text-amber-500 mx-auto mb-4" />
      <h2 className="text-lg font-medium text-foreground mb-2">
        We&apos;ll verify your coverage with you
      </h2>
      <p className="text-muted-foreground mb-6">
        {result.message ??
          result.rejectionMessage ??
          "Your information is saved. Our team will verify before your visit."}
      </p>
      <div className="flex flex-wrap gap-3 justify-center">
        <Button
          variant="outline"
          size="lg"
          className="rounded-xl"
          onClick={onTryAgain}
        >
          Edit Details
        </Button>
        <Button size="lg" className="rounded-xl" asChild>
          <Link href={nextHref}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ── Plan-name confirmation card (Theme H.1) ──────────────────────────
// Surfaced only when the resolver returned `lowConfidence: true` (popularity
// fallback or dominant-package heuristic). Patients confirm or reject the
// pick before we attach to Athena downstream — gives us a clean audit trail
// when the resolver guessed wrong and prevents wrong-plan claims.
function PlanConfirmation(props: {
  brand: BrandCard;
  result: EligibilityResponse;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const { brand, result, onConfirm, onReject } = props;
  const display = result.planDisplay;
  const planLabel =
    display?.planLabel ||
    result.eligibility.planName ||
    result.insuranceplanname ||
    brand.displayName;
  const reason =
    display?.patientFriendlyReason ??
    "Please confirm this is your plan, or pick the right one.";

  return (
    <div className="space-y-5" data-testid="plan-confirmation">
      <div className="text-center">
        <ShieldQuestion className="h-12 w-12 text-amber-500 mx-auto mb-3" />
        <h2 className="text-lg font-medium text-foreground">
          Does this match your card?
        </h2>
        <p className="text-sm text-muted-foreground mt-1">{reason}</p>
      </div>

      <Card className="border-amber-300 bg-amber-50/40">
        <CardContent className="space-y-2 pt-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Carrier
          </p>
          <p className="text-base font-medium text-foreground">
            {display?.carrierName ?? brand.displayName}
          </p>
          <p className="text-xs uppercase tracking-wide text-muted-foreground pt-2">
            Plan
          </p>
          <p
            className="text-base font-medium text-foreground"
            data-testid="plan-confirmation-plan-label"
          >
            {planLabel}
          </p>
          {result.eligibility.groupNumber && (
            <>
              <p className="text-xs uppercase tracking-wide text-muted-foreground pt-2">
                Group #
              </p>
              <p className="text-sm text-foreground">
                {result.eligibility.groupNumber}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3 justify-end">
        <Button
          variant="outline"
          size="lg"
          className="rounded-xl"
          onClick={onReject}
          data-testid="plan-confirmation-reject"
        >
          No, that&apos;s not my plan
        </Button>
        <Button
          size="lg"
          className="rounded-xl"
          onClick={onConfirm}
          data-testid="plan-confirmation-confirm"
        >
          Yes, that&apos;s my plan
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground text-right">{value}</dd>
    </div>
  );
}
