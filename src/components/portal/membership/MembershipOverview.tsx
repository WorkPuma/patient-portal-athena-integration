"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  CreditCard,
  RefreshCw,
  XCircle,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Calendar,
  MapPin,
  User,
  Bone,
  Activity,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppointmentScheduler } from "@/components/portal/appointments/AppointmentScheduler";

interface HintPatientData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  membershipStatus: string;
  pastDueCents: number;
  practitioner: { id: string; name: string } | null;
  location: {
    id: string;
    name: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    phone?: string;
  } | null;
}

interface HintMembershipData {
  planName: string;
  planId: string;
  planType: string;
  status: string;
  enrollmentStatus: string;
  memberType: string;
  startDate: string;
  endDate?: string | null;
}

export function MembershipOverview() {
  const [patient, setPatient] = useState<HintPatientData | null>(null);
  const [membership, setMembership] = useState<HintMembershipData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showScheduler, setShowScheduler] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/portal/hint/patient");
        if (res.ok) {
          const data = await res.json();
          setPatient(data.patient);
          setMembership(data.membership);
        } else {
          const data = await res.json().catch(() => null);
          setError(data?.error || "Failed to load membership info.");
        }
      } catch {
        setError("Failed to load membership data. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  function formatDate(dateStr: string): string {
    if (!dateStr) return "N/A";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function daysSince(dateStr: string): number {
    const start = new Date(dateStr);
    const now = new Date();
    return Math.floor(
      (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-8 w-40 font-serif" />
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div className="space-y-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="h-10 w-24" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const isActive =
    membership?.status === "active" || membership?.enrollmentStatus === "active";
  const withinGuarantee = membership
    ? daysSince(membership.startDate) <= 30
    : false;
  const guaranteeDaysLeft = membership
    ? Math.max(0, 30 - daysSince(membership.startDate))
    : 0;
  const pastDue = patient?.pastDueCents ?? 0;

  return (
    <div className="space-y-8">
      <h1 className="font-serif text-2xl font-medium text-foreground">
        Membership
      </h1>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {membership && isActive ? (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg font-medium">
                  {membership.planName}
                </CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Active
                </Badge>
                {membership.memberType && (
                  <Badge variant="outline" className="text-xs capitalize">
                    {membership.memberType}
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div>
                <p className="text-xs tracking-wide text-muted-foreground uppercase">
                  Member Since
                </p>
                <p className="font-medium text-foreground">
                  {formatDate(membership.startDate)}
                </p>
              </div>
              <div>
                <p className="text-xs tracking-wide text-muted-foreground uppercase">
                  Balance
                </p>
                <p
                  className={cn(
                    "font-medium",
                    pastDue > 0 ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  ${(pastDue / 100).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-xs tracking-wide text-muted-foreground uppercase">
                  Guarantee
                </p>
                <p className="font-medium text-foreground">
                  {withinGuarantee
                    ? `${guaranteeDaysLeft} days left`
                    : "Expired"}
                </p>
              </div>
              <div>
                <p className="text-xs tracking-wide text-muted-foreground uppercase">
                  Plan Type
                </p>
                <p className="font-medium text-foreground capitalize">
                  {membership.planType || "Standard"}
                </p>
              </div>
            </div>

            {patient?.practitioner && (
              <>
                <Separator />
                <div className="flex flex-wrap gap-6">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Primary Care Provider
                      </p>
                      <p className="text-sm font-medium">
                        {patient.practitioner.name}
                      </p>
                    </div>
                  </div>
                  {patient.location && (
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Location
                        </p>
                        <p className="text-sm font-medium">
                          {patient.location.name}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {pastDue > 0 && (
              <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertCircle className="text-amber-600 dark:text-amber-400" />
                <AlertTitle className="sr-only">Outstanding balance</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-2 text-amber-800 dark:text-amber-200">
                  <span>
                    You have an outstanding balance of $
                    {(pastDue / 100).toFixed(2)}
                  </span>
                  <Button
                    variant="link"
                    className="h-auto p-0 text-amber-900 underline dark:text-amber-100"
                    asChild
                  >
                    <Link href="/membership/pay">Pay now</Link>
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter className="flex flex-wrap gap-3 border-t pt-6">
            <Button variant="outline" size="sm" asChild>
              <Link href="/membership/renew">
                <RefreshCw className="h-4 w-4" />
                Renew
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              asChild
            >
              <Link href="/membership/cancel">
                <XCircle className="h-4 w-4" />
                Cancel
              </Link>
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center py-10 text-center">
            <CreditCard className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="mb-4 text-muted-foreground">
              You don&apos;t have an active membership.
            </p>
            <Button asChild>
              <Link href="/register/membership">
                Enroll Now
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Membership Services — DEXA Scans */}
      {isActive && (
        <div className="space-y-4">
          <h2 className="font-serif text-lg font-medium text-foreground">
            Membership Services
          </h2>
          <p className="text-sm text-muted-foreground">
            Included with your membership at no additional cost.
          </p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card className="transition-all hover:border-primary hover:shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Activity className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-medium">
                      DEXA Body Composition Scan
                    </CardTitle>
                    <Badge
                      variant="outline"
                      className="mt-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    >
                      Included Free
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-muted-foreground">
                  Measure body fat percentage, lean muscle mass, and bone mineral
                  density with precision. Track changes over time.
                </p>
              </CardContent>
              <CardFooter className="border-t pt-4">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => setShowScheduler(true)}
                >
                  <Calendar className="h-4 w-4" />
                  Schedule Scan
                </Button>
              </CardFooter>
            </Card>

            <Card className="transition-all hover:border-primary hover:shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Bone className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-base font-medium">
                      DEXA Bone Density Scan
                    </CardTitle>
                    <Badge
                      variant="outline"
                      className="mt-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    >
                      Included Free
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-muted-foreground">
                  Assess your bone health and osteoporosis risk. Recommended
                  annually for women over 50, or as directed by your provider.
                </p>
              </CardContent>
              <CardFooter className="border-t pt-4">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => setShowScheduler(true)}
                >
                  <Calendar className="h-4 w-4" />
                  Schedule Scan
                </Button>
              </CardFooter>
            </Card>
          </div>
        </div>
      )}

      <AppointmentScheduler
        open={showScheduler}
        onOpenChange={setShowScheduler}
      />
    </div>
  );
}
