"use client";

import { useState } from "react";
import {
  Stethoscope,
  AlertTriangle,
  Brain,
  ScanLine,
  CalendarHeart,
  ArrowLeft,
  Info,
  Sparkles,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type {
  VisitModality,
  VisitReason,
  PortalCategory,
  ScheduleReasonOption,
} from "@/lib/scheduling/appointment-types";
import {
  URGENT_REASONS,
  ROUTINE_REASONS,
} from "@/lib/scheduling/appointment-types";
import type { MockPatientContext } from "@/lib/scheduling/mock-data";
import {
  getCadenceMessage,
  getAwvNudgeMessage,
} from "@/lib/scheduling/mock-data";

interface VisitReasonStepProps {
  modality: VisitModality;
  mockCtx: MockPatientContext;
  /** True once the patient has more than one completed visit. New / one-visit
   *  patients are forced into an Initial Visit and never see the chief
   *  complaint picker. */
  isEstablished: boolean;
  onSelect: (
    reason: VisitReason,
    category: PortalCategory,
    /** First Athena `clinicalencounterreasonid` for the chosen complaint
     *  (when applicable). */
    reasonId?: number,
    /** Patient-facing label, persisted as the booking note. */
    reasonLabel?: string
  ) => void;
  onBack: () => void;
}

type SubView = "main" | "urgent_sub" | "routine_sub" | "bh_sub" | "member_sub";

const BH_OPTIONS: { category: PortalCategory; label: string; description: string }[] = [
  {
    category: "bh_intake",
    label: "Initial Evaluation",
    description: "First visit with a behavioral health provider",
  },
  {
    category: "bh_followup",
    label: "Psychotherapy Follow-Up",
    description: "Ongoing therapy or medication management",
  },
];

const MEMBER_SERVICE_OPTIONS: { category: PortalCategory; label: string; description: string }[] = [
  { category: "mammo", label: "Mammogram", description: "Breast cancer screening" },
  { category: "dexa", label: "DEXA Bone Density", description: "Osteoporosis screening" },
  { category: "dexa_body_comp", label: "DEXA + Body Composition", description: "Bone density + body fat analysis" },
  { category: "mammo_dexa", label: "Mammogram + DEXA Combo", description: "Both screenings in one visit" },
];

function ReasonList({
  options,
  reason,
  category,
  onPick,
}: {
  options: ScheduleReasonOption[];
  reason: VisitReason;
  category: PortalCategory;
  onPick: (
    reason: VisitReason,
    category: PortalCategory,
    reasonId: number,
    reasonLabel: string
  ) => void;
}) {
  return (
    <div className="space-y-2">
      {options.map((opt) => (
        <Card
          key={opt.label}
          className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
          onClick={() => onPick(reason, category, opt.reasonIds[0], opt.label)}
        >
          <CardContent className="p-4">
            <p className="text-sm font-medium">{opt.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function VisitReasonStep({
  modality,
  mockCtx,
  isEstablished,
  onSelect,
  onBack,
}: VisitReasonStepProps) {
  const [subView, setSubView] = useState<SubView>("main");

  const awvMessage = getAwvNudgeMessage(mockCtx);
  const cadenceMessage = getCadenceMessage(mockCtx);

  // ---------------------------------------------------------------------------
  // New patient: short-circuit. They can ONLY book an Initial Visit.
  // ---------------------------------------------------------------------------
  if (!isEstablished) {
    return (
      <div className="space-y-4">
        <Button
          variant="link"
          className="h-auto gap-1 p-0 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <div>
          <h3 className="text-base font-medium">Welcome &mdash; let&rsquo;s get you in.</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {modality === "telehealth" ? "Telehealth visit" : "In-person visit"}{" "}
            <Badge variant="outline" className="ml-1 text-xs font-normal">
              {modality === "telehealth" ? "Video" : "Clinic"}
            </Badge>
          </p>
        </div>

        <Alert className="border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30">
          <Info className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-sm text-blue-800 dark:text-blue-300">
            Your first appointment with us is a longer Initial Visit so your
            provider can get to know you. You&rsquo;ll be able to schedule
            different visit types after this one.
          </AlertDescription>
        </Alert>

        <Card
          className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
          onClick={() => onSelect("routine", "routine")}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
              <Sparkles className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="font-medium">Initial Visit</p>
              <p className="text-sm text-muted-foreground">
                60-minute new-patient visit with your care team
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Established patient sub-views.
  // ---------------------------------------------------------------------------
  if (subView === "urgent_sub") {
    return (
      <div className="space-y-4">
        <Button
          variant="link"
          className="h-auto gap-1 p-0 text-muted-foreground"
          onClick={() => setSubView("main")}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <div>
          <h3 className="text-base font-medium">What&rsquo;s bothering you?</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick the closest match and we&rsquo;ll find you a same-day visit.
          </p>
        </div>

        <ReasonList
          options={URGENT_REASONS}
          reason="urgent"
          category="urgent"
          onPick={onSelect}
        />
      </div>
    );
  }

  if (subView === "routine_sub") {
    return (
      <div className="space-y-4">
        <Button
          variant="link"
          className="h-auto gap-1 p-0 text-muted-foreground"
          onClick={() => setSubView("main")}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <div>
          <h3 className="text-base font-medium">What&rsquo;s the visit for?</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick the option that best matches your reason.
          </p>
        </div>

        <ReasonList
          options={ROUTINE_REASONS}
          reason="routine"
          category="routine"
          onPick={onSelect}
        />
      </div>
    );
  }

  if (subView === "bh_sub") {
    return (
      <div className="space-y-4">
        <Button
          variant="link"
          className="h-auto gap-1 p-0 text-muted-foreground"
          onClick={() => setSubView("main")}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <div>
          <h3 className="text-base font-medium">Behavioral Health</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            What type of behavioral health visit do you need?
          </p>
        </div>

        <div className="space-y-3">
          {BH_OPTIONS.map((opt) => (
            <Card
              key={opt.category}
              className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
              onClick={() => onSelect("behavioral_health", opt.category)}
            >
              <CardContent className="p-4">
                <p className="font-medium">{opt.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {opt.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (subView === "member_sub") {
    return (
      <div className="space-y-4">
        <Button
          variant="link"
          className="h-auto gap-1 p-0 text-muted-foreground"
          onClick={() => setSubView("main")}
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <div>
          <h3 className="text-base font-medium">Member Screenings</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            These in-clinic screenings are included with your membership.
          </p>
        </div>

        <div className="space-y-3">
          {MEMBER_SERVICE_OPTIONS.map((opt) => (
            <Card
              key={opt.category}
              className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
              onClick={() => onSelect("member_services", opt.category)}
            >
              <CardContent className="p-4">
                <p className="font-medium">{opt.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {opt.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Main view (established patients)
  return (
    <div className="space-y-4">
      <Button
        variant="link"
        className="h-auto gap-1 p-0 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Button>

      <div>
        <h3 className="text-base font-medium">What brings you in today?</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {modality === "telehealth" ? "Telehealth visit" : "In-person visit"}{" "}
          <Badge variant="outline" className="ml-1 text-xs font-normal">
            {modality === "telehealth" ? "Video" : "Clinic"}
          </Badge>
        </p>
      </div>

      {awvMessage && (
        <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
          <CalendarHeart className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-sm">
            {awvMessage}
            <Button
              variant="link"
              className="ml-1 h-auto p-0 text-sm font-medium text-amber-700"
              onClick={() => onSelect("awv", "awv")}
            >
              Schedule AWV
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Alert className="border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30">
        <Info className="h-4 w-4 text-blue-600" />
        <AlertDescription className="text-sm text-blue-800 dark:text-blue-300">
          {cadenceMessage}
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        <Card
          className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
          onClick={() => setSubView("routine_sub")}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
              <Stethoscope className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="font-medium">Routine Visit</p>
              <p className="text-sm text-muted-foreground">
                Regular check-up, follow-up, or medication review
              </p>
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
          onClick={() => setSubView("urgent_sub")}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 dark:bg-red-900/30">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="font-medium">I have symptoms I need help with</p>
              <p className="text-sm text-muted-foreground">
                New or worsening symptoms that need attention
              </p>
            </div>
          </CardContent>
        </Card>

        {mockCtx.showBehavioralHealth && (
          <Card
            className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
            onClick={() => setSubView("bh_sub")}
          >
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/30">
                <Brain className="h-5 w-5 text-violet-600" />
              </div>
              <div>
                <p className="font-medium">Behavioral Health</p>
                <p className="text-sm text-muted-foreground">
                  Therapy, counseling, or psychiatric evaluation
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {mockCtx.showMemberServices && modality === "in_person" && (
          <>
            <Separator />
            <Card
              className="cursor-pointer transition-all hover:border-primary hover:shadow-sm"
              onClick={() => setSubView("member_sub")}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-900/30">
                  <ScanLine className="h-5 w-5 text-sky-600" />
                </div>
                <div>
                  <p className="font-medium">Mammogram, DEXA, or Body Scan</p>
                  <p className="text-sm text-muted-foreground">
                    Member screening services included with your plan
                  </p>
                </div>
                <Badge variant="secondary" className="ml-auto shrink-0 text-xs">
                  Members
                </Badge>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
