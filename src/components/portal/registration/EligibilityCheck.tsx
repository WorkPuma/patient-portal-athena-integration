"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Shield,
  Search,
  Loader2,
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
import { getClientPortalFeatureFlags } from "@/lib/portal/feature-flags";
import { cn } from "@/lib/utils";
import {
  loadRegistration,
  loadRegistrationDraft,
  registerFetch,
  saveRegistrationDraft,
  saveRegistrationInsurance,
} from "./registration-client";
import {
  trackEligibilityChecked,
  trackInsuranceAttachFailed,
} from "@/lib/posthog/events";

type EligibilityStep = "form" | "checking" | "result";

/**
 * Mirrors the response from /api/portal/register/insurance/search, which
 * now reads from the staged Supabase `portal_insurance_packages` table.
 * The server is the source of truth for `isGovernmentFunded` (derived from
 * MDM `government_funded_type`) — the wizard no longer guesses from the
 * plan name.
 */
interface InsurancePackage {
  insurancepackageid: number;
  insuranceplanname: string;
  payorBrand?: string | null;
  isGovernmentFunded?: boolean;
  governmentFundedType?: string | null;
}

interface EligibilityFormDraft {
  insuranceidnumber: string;
  policynumber: string;
  insurancepolicyholderfirstname: string;
  insurancepolicyholderlastname: string;
  insurancepolicyholderdob: string;
  relationshiptoinsuredid: string;
}

// What we persist between renders / Back navigations. Keeps the typed insurer
// name AND the selected package so the green "selected" hint and the govt-
// funded badge come back exactly as the user left them.
interface EligibilityDraft {
  form: EligibilityFormDraft;
  searchQuery: string;
  selectedPackage: InsurancePackage | null;
}

const DEFAULT_ELIGIBILITY_FORM: EligibilityFormDraft = {
  insuranceidnumber: "",
  policynumber: "",
  insurancepolicyholderfirstname: "",
  insurancepolicyholderlastname: "",
  insurancepolicyholderdob: "",
  relationshiptoinsuredid: "1",
};

export function EligibilityCheck() {
  const router = useRouter();

  const [step, setStep] = useState<EligibilityStep>("form");
  const [error, setError] = useState("");
  const [eligible, setEligible] = useState(false);
  const [insuranceId, setInsuranceId] = useState<string>("");
  const [isGovtInsurance, setIsGovtInsurance] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InsurancePackage[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<InsurancePackage | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const searchSeq = useRef(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [form, setForm] = useState<EligibilityFormDraft>(
    DEFAULT_ELIGIBILITY_FORM
  );
  const [hydrated, setHydrated] = useState(false);

  // No regToken? Send the user back to start.
  useEffect(() => {
    if (!loadRegistration()) {
      router.replace("/register");
    }
  }, [router]);

  // Rehydrate the form, search query, and selected plan from the per-tab
  // draft so the user's prior entries (and chosen plan) survive a Back
  // navigation from /register/membership or /register/schedule. Hydration
  // runs in an effect (rather than a useState initializer) so the SSR pass
  // renders empty defaults and the client post-hydrates from sessionStorage,
  // avoiding a markup mismatch. The repo standardizes on
  // `react-hooks/set-state-in-effect` disables for this exact pattern (see
  // create-account/[[...sign-up]]/page.tsx).
  useEffect(() => {
    const draft = loadRegistrationDraft<Partial<EligibilityDraft>>(
      "eligibility"
    );
    if (draft) {
      if (draft.form) {

        setForm((prev) => ({ ...prev, ...draft.form }));
      }
      if (typeof draft.searchQuery === "string") {

        setSearchQuery(draft.searchQuery);
      }
      if (draft.selectedPackage) {

        setSelectedPackage(draft.selectedPackage);

        setIsGovtInsurance(!!draft.selectedPackage.isGovernmentFunded);
      }
    }

    setHydrated(true);
  }, []);

  // Persist the form / search query / selected plan after every change. We
  // gate on `hydrated` so the very first render (which still holds defaults)
  // doesn't overwrite a real saved draft.
  useEffect(() => {
    if (!hydrated) return;
    const draft: EligibilityDraft = { form, searchQuery, selectedPackage };
    saveRegistrationDraft("eligibility", draft);
  }, [form, searchQuery, selectedPackage, hydrated]);

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  const doSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    const seq = ++searchSeq.current;

    setSearching(true);
    try {
      const result = await registerFetch<{ packages: InsurancePackage[] }>(
        `/api/portal/register/insurance/search?q=${encodeURIComponent(query)}`,
        { signal: controller.signal }
      );
      // Drop stale responses if a newer search has started.
      if (seq !== searchSeq.current) return;
      if (result.ok && result.data) {
        setSearchResults(result.data.packages || []);
      }
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    setSelectedPackage(null);
    setShowResults(true);

    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(value), 300);
  }

  function handleSelectPackage(pkg: InsurancePackage) {
    setSelectedPackage(pkg);
    setSearchQuery(pkg.insuranceplanname);
    setShowResults(false);
    // Authoritative signal from the staged MDM table; defaults to false when
    // the server didn't return a value (older cached payloads).
    setIsGovtInsurance(!!pkg.isGovernmentFunded);
  }

  // Cleanup any pending debounce/abort on unmount.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchAbort.current?.abort();
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!selectedPackage) {
      setError("Please search and select an insurance plan.");
      return;
    }

    setStep("checking");

    const addRes = await registerFetch<{
      insurance: { insuranceid?: string };
      insuranceIdSynthesized?: boolean;
    }>("/api/portal/register/insurance", {
      method: "POST",
      body: JSON.stringify({
        insurancepackageid: selectedPackage.insurancepackageid,
        insuranceidnumber: form.insuranceidnumber,
        policynumber: form.policynumber || undefined,
        insurancepolicyholderfirstname:
          form.insurancepolicyholderfirstname || undefined,
        insurancepolicyholderlastname:
          form.insurancepolicyholderlastname || undefined,
        insurancepolicyholderdob:
          form.insurancepolicyholderdob || undefined,
        relationshiptoinsuredid: parseInt(form.relationshiptoinsuredid, 10),
        sequencenumber: 1,
      }),
    });
    if (!addRes.ok || !addRes.data) {
      trackInsuranceAttachFailed({
        brandId: String(selectedPackage.insurancepackageid),
        errorCode: addRes.error?.code || "ATTACH_FAILED",
        insurancePackageId: selectedPackage.insurancepackageid,
      });
      setError(addRes.error?.error || "Failed to add insurance");
      setStep("form");
      return;
    }
    // Athena's preview tenant occasionally returns the inserted insurance row
    // without an `insuranceid` and the BFF can't always recover one via the
    // /insurances list either. The server marks those responses with
    // `insuranceIdSynthesized: true` and stuffs in a placeholder id; treat the
    // patient as added either way and let the eligibility step (which is
    // mocked in non-prod) handle it.
    const addedInsuranceId = addRes.data.insurance?.insuranceid || "";
    const synthesized = !!addRes.data.insuranceIdSynthesized;
    if (!addedInsuranceId) {
      // Should be impossible (server always synthesizes when missing) but
      // belt-and-suspenders: don't block the user, just continue.
      console.warn(
        "[register/eligibility] insurance added but server returned no id; continuing optimistically"
      );
    }
    setInsuranceId(addedInsuranceId || `preview-${Date.now()}`);

    // Persist the selection so the membership / schedule steps can read the
    // government-funded flag without re-querying.
    saveRegistrationInsurance({
      insurancepackageid: selectedPackage.insurancepackageid,
      insuranceplanname: selectedPackage.insuranceplanname,
      insuranceId: addedInsuranceId,
      isGovernmentFunded: !!selectedPackage.isGovernmentFunded,
      governmentFundedType: selectedPackage.governmentFundedType ?? null,
    });

    // Only call the real eligibility endpoint when we have a numeric Athena
    // id. Synthesized placeholder ids (preview/sandbox) can't be passed to
    // /benefitdetails — the eligibility route mocks responses in non-prod
    // anyway, but it still requires a positive integer to satisfy the
    // payload validator. Skip the call and assume eligible in that case.
    const numericInsuranceId = synthesized
      ? NaN
      : parseInt(addedInsuranceId, 10);
    if (!Number.isFinite(numericInsuranceId) || numericInsuranceId <= 0) {
      trackEligibilityChecked({
        brandId: String(selectedPackage.insurancepackageid),
        resolvedPlanName: selectedPackage.insuranceplanname,
        insurancePackageId: selectedPackage.insurancepackageid,
        isGovernmentFunded: !!selectedPackage.isGovernmentFunded,
        coverageStatus: "unknown",
        eligibilityStatus: "Indeterminate",
        attachSucceeded: true,
      });
      setEligible(true);
      setStep("result");
      return;
    }

    const eligRes = await registerFetch<{
      eligibility: { eligibilitystatus?: string };
    }>("/api/portal/register/eligibility", {
      method: "POST",
      body: JSON.stringify({ insuranceId: numericInsuranceId }),
    });
    if (!eligRes.ok || !eligRes.data) {
      // Eligibility is informational — failing it shouldn't block the user
      // from proceeding to membership/scheduling. Log and continue.
      console.warn(
        "[register/eligibility] eligibility check failed; continuing",
        eligRes.error
      );
      trackEligibilityChecked({
        brandId: String(selectedPackage.insurancepackageid),
        resolvedPlanName: selectedPackage.insuranceplanname,
        insurancePackageId: selectedPackage.insurancepackageid,
        isGovernmentFunded: !!selectedPackage.isGovernmentFunded,
        coverageStatus: "indeterminate",
        eligibilityStatus: "Indeterminate",
        attachSucceeded: true,
      });
      setEligible(true);
      setStep("result");
      return;
    }
    const status = eligRes.data.eligibility?.eligibilitystatus || "";
    const isEligible =
      status.toLowerCase().includes("eligible") ||
      status.toLowerCase().includes("active");
    trackEligibilityChecked({
      brandId: String(selectedPackage.insurancepackageid),
      resolvedPlanName: selectedPackage.insuranceplanname,
      insurancePackageId: selectedPackage.insurancepackageid,
      isGovernmentFunded: !!selectedPackage.isGovernmentFunded,
      coverageStatus: isEligible ? "active" : "inactive",
      eligibilityStatus: isEligible ? "Active" : "Inactive",
      attachSucceeded: true,
    });
    setEligible(isEligible);
    setStep("result");
  }

  // Government-funded plans (Medicare / Medicaid / Replacement) can't enroll
  // in the membership program, so we skip that step entirely and go straight
  // to scheduling. Driven by MDM `government_funded_type`, served by
  // /api/portal/register/insurance/search. The membership feature flag also
  // forces skip when the membership step is hidden from the wizard funnel.
  const membershipEnabled = getClientPortalFeatureFlags().membership;
  const skipMembership = isGovtInsurance || !membershipEnabled;
  const nextHref = skipMembership
    ? `/register/schedule`
    : `/register/membership?insuranceId=${insuranceId}`;
  const nextLabel = skipMembership ? "Schedule Visit" : "Enroll in Membership";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <Shield className="h-10 w-10 text-primary mx-auto mb-3" />
          <h1 className="text-xl font-medium text-foreground">
            Insurance Eligibility
          </h1>
          <p className="mt-2 text-muted-foreground">
            Search for your insurance plan and verify coverage.
          </p>
        </div>

        <div className="flex items-center gap-2 mb-8">
          {(membershipEnabled
            ? ["Your info", "Insurance", "Membership", "Choose a visit time"]
            : ["Your info", "Insurance", "Choose a visit time"]
          ).map(
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
            {step === "form" && (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2" ref={dropdownRef}>
                  <Label htmlFor="insurance-search">
                    Insurance plan name *
                  </Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="insurance-search"
                      type="text"
                      required
                      value={searchQuery}
                      onChange={(e) => handleSearchInput(e.target.value)}
                      onFocus={() => {
                        if (searchResults.length > 0 && !selectedPackage) {
                          setShowResults(true);
                        }
                      }}
                      placeholder="Start typing (e.g., Blue Cross, Aetna)..."
                      className="pl-9"
                      autoComplete="off"
                    />
                    {searching && (
                      <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                  </div>

                  {showResults && searchResults.length > 0 && (
                    <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
                      {searchResults.slice(0, 25).map((pkg) => (
                        <button
                          key={pkg.insurancepackageid}
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => handleSelectPackage(pkg)}
                        >
                          <span className="flex-1 truncate">
                            {pkg.insuranceplanname}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            #{pkg.insurancepackageid}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {showResults &&
                    searchQuery.length >= 2 &&
                    !searching &&
                    searchResults.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No plans found. Try a different search term.
                      </p>
                    )}

                  {selectedPackage && (
                    <p className="flex items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {selectedPackage.insuranceplanname} (ID:{" "}
                      {selectedPackage.insurancepackageid})
                      {isGovtInsurance && (
                        <span className="ml-1 text-blue-600">
                          — Government plan detected
                        </span>
                      )}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="insuranceidnumber">Member ID *</Label>
                    <Input
                      id="insuranceidnumber"
                      type="text"
                      required
                      value={form.insuranceidnumber}
                      onChange={(e) =>
                        updateField("insuranceidnumber", e.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="policynumber">Group number</Label>
                    <Input
                      id="policynumber"
                      type="text"
                      value={form.policynumber}
                      onChange={(e) =>
                        updateField("policynumber", e.target.value)
                      }
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="relationshiptoinsuredid">
                    Relationship to insured
                  </Label>
                  <Select
                    value={form.relationshiptoinsuredid}
                    onValueChange={(v) =>
                      updateField("relationshiptoinsuredid", v)
                    }
                  >
                    <SelectTrigger
                      id="relationshiptoinsuredid"
                      className="w-full"
                    >
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
                    Check Eligibility
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            )}

            {step === "checking" && (
              <div className="flex flex-col items-center gap-4 py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">
                  Verifying your insurance coverage...
                </p>
              </div>
            )}

            {step === "result" && (
              <div className="py-8">
                {eligible ? (
                  <div className="space-y-6">
                    <div className="text-center">
                      <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
                      <h2 className="text-lg font-medium text-foreground mb-2">
                        Your insurance is eligible!
                      </h2>
                      <p className="text-muted-foreground">
                        {skipMembership
                          ? "Next, schedule your first visit."
                          : "Next, continue to Membership enrollment."}
                      </p>
                    </div>
                    <div className="flex items-center justify-between pt-2">
                      <Button
                        variant="link"
                        className="text-muted-foreground h-auto p-0"
                        onClick={() => {
                          setStep("form");
                          setError("");
                        }}
                      >
                        <span className="inline-flex items-center gap-1">
                          <ArrowLeft className="h-4 w-4" />
                          Back
                        </span>
                      </Button>
                      <Button size="lg" className="rounded-xl" asChild>
                        <Link href={nextHref}>
                          {nextLabel}
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center">
                    <XCircle className="h-12 w-12 text-destructive/80 mx-auto mb-4" />
                    <h2 className="text-lg font-medium text-foreground mb-2">
                      Coverage not verified
                    </h2>
                    <p className="text-muted-foreground mb-6">
                      We weren&apos;t able to verify your insurance. Please
                      double-check your information or contact us for help.
                    </p>
                    <div className="flex flex-wrap gap-3 justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="rounded-xl"
                        onClick={() => {
                          setStep("form");
                          setError("");
                        }}
                      >
                        Try Again
                      </Button>
                      <Button size="lg" className="rounded-xl" asChild>
                        <Link href="/register/schedule">Continue Anyway</Link>
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
