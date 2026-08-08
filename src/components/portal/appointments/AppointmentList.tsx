"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Calendar,
  Clock,
  Plus,
  ChevronRight,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  apptStatusLabel,
  apptStatusVariant,
} from "@/lib/athena/appointment-status";
import { AppointmentScheduler } from "./AppointmentScheduler";

interface Appointment {
  appointmentid: string;
  date: string;
  starttime: string;
  duration: number;
  appointmentstatus: string;
  appointmenttype: string;
  departmentid: string;
  providerid: string;
  providerfirstname?: string;
  providerlastname?: string;
}

function statusBadge(status: string, label: string) {
  const variant = apptStatusVariant(status);
  switch (variant) {
    case "scheduled":
      return (
        <Badge
          variant="outline"
          className="border-primary/30 bg-primary/10 text-primary"
        >
          {label}
        </Badge>
      );
    case "cancelled":
    case "no-show":
      return <Badge variant="destructive">{label}</Badge>;
    case "checked-in":
    case "completed":
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        >
          {label}
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" className="font-medium">
          {label}
        </Badge>
      );
  }
}

export function AppointmentList() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"upcoming" | "past">("upcoming");
  const [showScheduler, setShowScheduler] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/portal/athena/appointments");
        if (res.ok) {
          const data = await res.json();
          setAppointments(data.appointments || []);
        } else {
          const data = await res.json().catch(() => null);
          setError(data?.error || "Failed to load appointments.");
        }
      } catch {
        setError("Failed to load appointments. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  function parseDate(dateStr: string): Date {
    const [month, day, year] = dateStr.split("/").map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDate(dateStr: string): string {
    const date = parseDate(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const filtered = appointments.filter((appt) => {
    const apptDate = parseDate(appt.date);
    if (filter === "upcoming") return apptDate >= now;
    return apptDate < now;
  });

  const sorted = [...filtered].sort((a, b) => {
    const dateA = parseDate(a.date).getTime();
    const dateB = parseDate(b.date).getTime();
    return filter === "upcoming" ? dateA - dateB : dateB - dateA;
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-40 rounded-md" />
        </div>
        <Skeleton className="h-9 w-56 rounded-lg" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-medium text-foreground">
          Appointments
        </h1>
        <Button className="gap-2" onClick={() => setShowScheduler(true)}>
          <Plus className="h-4 w-4" />
          New Appointment
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as "upcoming" | "past")}
      >
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
        </TabsList>
      </Tabs>

      {sorted.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">
              {filter === "upcoming"
                ? "No upcoming appointments"
                : "No past appointments"}
            </p>
            {filter === "upcoming" && (
              <Button
                variant="link"
                className="mt-2 h-auto p-0"
                onClick={() => setShowScheduler(true)}
              >
                Schedule one now
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((appt) => {
            const label = apptStatusLabel(appt.appointmentstatus);

            return (
              <Card
                key={appt.appointmentid}
                className="gap-0 py-0 transition-all hover:border-border hover:shadow-sm"
              >
                <CardContent className="p-0">
                  <Link
                    href={`/appointments/${appt.appointmentid}`}
                    className="flex items-center gap-4 p-4"
                  >
                    <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-primary/10">
                      <Calendar className="h-5 w-5 text-primary" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">
                        {appt.appointmenttype || "Appointment"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(appt.date)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {appt.starttime}
                        </span>
                        {appt.providerfirstname && (
                          <span>
                            Dr. {appt.providerfirstname}{" "}
                            {appt.providerlastname}
                          </span>
                        )}
                      </div>
                    </div>

                    {statusBadge(appt.appointmentstatus, label)}

                    <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <AppointmentScheduler
        open={showScheduler}
        onOpenChange={setShowScheduler}
      />
    </div>
  );
}
