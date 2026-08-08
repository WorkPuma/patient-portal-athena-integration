"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  MessageSquare,
  Plus,
  ChevronRight,
  Clock,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SalesforceCase {
  Id: string;
  CaseNumber: string;
  Subject: string;
  Status: string;
  Priority: string;
  CreatedDate: string;
  Description: string;
  LastModifiedDate: string;
}

function statusBadgeProps(status: string): {
  variant: React.ComponentProps<typeof Badge>["variant"];
  className?: string;
} {
  switch (status) {
    case "New":
      return {
        variant: "outline",
        className: "border-primary/40 text-primary",
      };
    case "Working":
    case "In Progress":
      return { variant: "secondary" };
    case "Escalated":
      return { variant: "destructive" };
    default:
      return {
        variant: "outline",
        className: "text-muted-foreground",
      };
  }
}

export function MessageList() {
  const [cases, setCases] = useState<SalesforceCase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/portal/salesforce/cases");
        if (res.ok) {
          const data = await res.json();
          setCases(data.cases || []);
        }
      } catch (err) {
        console.error("Failed to load cases:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function timeAgo(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateStr);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4 py-4">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-full max-w-md" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-medium text-foreground">
          Messages
        </h1>
        <Button size="sm" asChild>
          <Link href="/messages/new">
            <Plus className="h-4 w-4" />
            New Message
          </Link>
        </Button>
      </div>

      {cases.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <MessageSquare className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="mb-2 text-muted-foreground">No messages yet</p>
            <p className="mb-4 text-sm text-muted-foreground">
              Start a conversation with your care team.
            </p>
            <Button variant="link" className="h-auto p-0" asChild>
              <Link href="/messages/new">Send a message</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cases.map((c) => {
            const { variant, className: badgeClass } = statusBadgeProps(c.Status);

            return (
              <Card
                key={c.Id}
                className="transition-all hover:border-border hover:shadow-sm"
              >
                <CardContent className="flex items-center gap-4 py-4">
                  <div
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10"
                  >
                    <MessageSquare className="h-5 w-5 text-primary" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {c.Subject}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-3">
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {timeAgo(c.LastModifiedDate || c.CreatedDate)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        #{c.CaseNumber}
                      </span>
                    </div>
                  </div>

                  <Badge variant={variant} className={cn("shrink-0", badgeClass)}>
                    {c.Status}
                  </Badge>

                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
