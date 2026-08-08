"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Calendar,
  CreditCard,
  MessageSquare,
  Clock,
  ArrowRight,
  Plus,
  AlertCircle,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DobVerification } from "@/components/portal/identity/DobVerification";
import { AppointmentScheduler } from "@/components/portal/appointments/AppointmentScheduler";
import {
  apptStatusLabel,
  apptStatusVariant,
} from "@/lib/athena/appointment-status";

interface UserInfo {
  displayName: string;
  email: string;
  hintPatientId?: string;
  disambiguationRequired?: boolean;
}

type DashboardState = "loading" | "disambiguation" | "ready";

interface Appointment {
  appointmentid: string;
  date: string;
  starttime: string;
  appointmentstatus: string;
  appointmenttype: string;
  providerfirstname?: string;
  providerlastname?: string;
}

interface HintMembership {
  planName: string;
  planId: string;
  status: string;
  startDate: string;
  endDate?: string | null;
}

interface HintPatientData {
  pastDueCents: number;
  practitioner?: { name: string } | null;
}

interface DashboardMembership {
  planName: string;
  status: string;
  pastDueCents: number;
  startDate: string;
}

function appointmentStatusBadge(appt: Appointment) {
  const label = apptStatusLabel(appt.appointmentstatus);
  const variant = apptStatusVariant(appt.appointmentstatus);
  if (variant === "scheduled") {
    return (
      <Badge
        variant="outline"
        className="border-primary/30 bg-primary/10 text-primary"
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-medium">
      {label}
    </Badge>
  );
}

export function Dashboard() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [membership, setMembership] = useState<DashboardMembership | null>(null);
  const [state, setState] = useState<DashboardState>("loading");
  const [showScheduler, setShowScheduler] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        const sessionRes = await fetch("/api/portal/auth/session");
        if (sessionRes.ok) {
          const data = await sessionRes.json();
          setUser(data.user);

          if (data.user?.disambiguationRequired) {
            setState("disambiguation");
            return;
          }
        }

        const [apptRes, hintRes] = await Promise.all([
          fetch("/api/portal/athena/appointments"),
          fetch("/api/portal/hint/patient"),
        ]);

        if (apptRes.ok) {
          const data = await apptRes.json();
          setAppointments(
            (data.appointments || [])
              .filter(
                (a: Appointment) =>
                  apptStatusVariant(a.appointmentstatus) !== "cancelled" &&
                  apptStatusVariant(a.appointmentstatus) !== "no-show"
              )
              .slice(0, 3)
          );
        }
        if (hintRes.ok) {
          const data = await hintRes.json();
          const m = data.membership as HintMembership | null;
          const p = data.patient as HintPatientData | null;
          if (m) {
            setMembership({
              planName: m.planName,
              status: m.status,
              pastDueCents: p?.pastDueCents ?? 0,
              startDate: m.startDate,
            });
          }
        }
        setState("ready");
      } catch (err) {
        console.error("Dashboard load error:", err);
        setState("ready");
      }
    }
    loadData();
  }, []);

  function formatDate(dateStr: string): string {
    if (!dateStr) return "";
    const parts = dateStr.includes("/")
      ? dateStr.split("/")
      : dateStr.split("-");
    if (parts.length !== 3) return dateStr;

    let month: number, day: number, year: number;
    if (dateStr.includes("/")) {
      [month, day, year] = parts.map(Number);
    } else {
      [year, month, day] = parts.map(Number);
    }

    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  if (state === "loading") {
    return (
      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (state === "disambiguation") {
    return (
      <DobVerification
        onVerified={() => {
          setState("loading");
          window.location.reload();
        }}
      />
    );
  }

  const nextAppointment = appointments[0];

  const quickLinks = [
    {
      action: () => setShowScheduler(true),
      icon: Plus,
      title: "Schedule Visit",
      subtitle: "Book an appointment",
    },
    {
      href: "/messages/new",
      icon: MessageSquare,
      title: "Message Us",
      subtitle: "Contact your care team",
    },
    {
      href: "/membership",
      icon: CreditCard,
      title: "Membership",
      subtitle: "View plan & billing",
    },
  ] as const;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-medium text-foreground">
          Welcome{user?.displayName ? `, ${user.displayName.split("@")[0]}` : ""}
        </h1>
        <p className="mt-1 text-muted-foreground">
          Here&apos;s an overview of your healthcare.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {quickLinks.map(({ icon: Icon, title, subtitle, ...link }) => {
          const inner = (
            <>
              <div className="rounded-lg bg-primary/10 p-2">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-foreground">{title}</p>
                <p className="text-sm text-muted-foreground">{subtitle}</p>
              </div>
            </>
          );

          return (
            <Card
              key={title}
              className="gap-0 py-0 transition-all hover:border-primary hover:shadow-sm"
            >
              <CardContent className="p-0">
                {"href" in link ? (
                  <Link
                    href={link.href}
                    className="flex items-center gap-3 p-4 transition-colors"
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={link.action}
                    className="flex w-full items-center gap-3 p-4 text-left transition-colors"
                  >
                    {inner}
                  </button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-6 pb-2">
            <CardTitle className="flex items-center gap-2 text-lg font-medium">
              <Calendar className="h-5 w-5 text-primary" />
              Upcoming Appointments
            </CardTitle>
            <Button variant="link" className="h-auto p-0 text-primary" asChild>
              <Link href="/appointments" className="gap-1">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {nextAppointment ? (
              <div className="space-y-3">
                {appointments.map((appt) => (
                  <Link
                    key={appt.appointmentid}
                    href={`/appointments/${appt.appointmentid}`}
                    className={cn(
                      "flex items-center gap-4 rounded-lg p-3 transition-colors",
                      "hover:bg-muted"
                    )}
                  >
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <Clock className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">
                        {appt.appointmenttype || "Appointment"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(appt.date)} at {appt.starttime}
                        {appt.providerfirstname &&
                          ` · Dr. ${appt.providerlastname}`}
                      </p>
                    </div>
                    {appointmentStatusBadge(appt)}
                  </Link>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center">
                <Calendar className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No upcoming appointments
                </p>
                <Button
                  variant="link"
                  className="mt-1 h-auto p-0"
                  onClick={() => setShowScheduler(true)}
                >
                  Schedule one now
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-6 pb-2">
            <CardTitle className="flex items-center gap-2 text-lg font-medium">
              <CreditCard className="h-5 w-5 text-primary" />
              Membership
            </CardTitle>
            <Button variant="link" className="h-auto p-0 text-primary" asChild>
              <Link href="/membership" className="gap-1">
                Details <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {membership ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-foreground">
                      {membership.planName}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Status:{" "}
                      <span className="font-medium text-emerald-600 dark:text-emerald-500">
                        {membership.status === "active" ? "Active" : membership.status}
                      </span>
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  >
                    {membership.status === "active" ? "Active" : membership.status}
                  </Badge>
                </div>

                {membership.pastDueCents > 0 && (
                  <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
                    <AlertCircle className="text-amber-600 dark:text-amber-400" />
                    <AlertTitle className="text-amber-900 dark:text-amber-100">
                      Balance due
                    </AlertTitle>
                    <AlertDescription className="flex flex-wrap items-center gap-2 text-amber-800 dark:text-amber-200/90">
                      <span>
                        Outstanding balance: $
                        {(membership.pastDueCents / 100).toFixed(2)}
                      </span>
                      <Button
                        variant="link"
                        className="h-auto p-0 text-amber-900 underline-offset-4 hover:text-amber-950 dark:text-amber-100"
                        asChild
                      >
                        <Link href="/membership/pay">Pay now</Link>
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}

                <p className="text-sm text-muted-foreground">
                  Member since: {formatDate(membership.startDate)}
                </p>
              </div>
            ) : (
              <div className="py-8 text-center">
                <CreditCard className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No active membership
                </p>
                <Button variant="link" className="mt-1 h-auto p-0" asChild>
                  <Link href="/register/membership">Enroll now</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AppointmentScheduler
        open={showScheduler}
        onOpenChange={setShowScheduler}
      />
    </div>
  );
}
