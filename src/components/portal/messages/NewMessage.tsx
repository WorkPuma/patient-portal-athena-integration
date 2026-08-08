"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Send,
  Loader2,
  CheckCircle2,
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const TOPICS = [
  { value: "general", label: "General Question" },
  { value: "appointment", label: "Appointment Related" },
  { value: "prescription", label: "Prescription Refill" },
  { value: "billing", label: "Billing Question" },
  { value: "referral", label: "Referral Request" },
  { value: "other", label: "Other" },
];

export function NewMessage() {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("general");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("Medium");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError("");

    const fullSubject = `[${TOPICS.find((t) => t.value === topic)?.label || topic}] ${subject}`;

    try {
      const res = await fetch("/api/portal/salesforce/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: fullSubject,
          description,
          priority,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to send message");
        return;
      }

      setSent(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-500" />
        <h2 className="mb-2 text-xl font-medium text-foreground">
          Message Sent
        </h2>
        <p className="mb-6 text-muted-foreground">
          Your care team will respond as soon as possible. You&apos;ll see the
          response in your messages.
        </p>
        <Button onClick={() => router.push("/messages")}>
          View Messages
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 h-auto px-2 text-muted-foreground" asChild>
        <Link href="/messages">
          <ArrowLeft className="h-4 w-4" />
          Back to Messages
        </Link>
      </Button>

      <h1 className="font-serif text-2xl font-medium text-foreground">
        New Message
      </h1>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSend} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="topic">Topic</Label>
              <Select value={topic} onValueChange={setTopic}>
                <SelectTrigger id="topic" className="w-full">
                  <SelectValue placeholder="Select a topic" />
                </SelectTrigger>
                <SelectContent>
                  {TOPICS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">Subject *</Label>
              <Input
                id="subject"
                type="text"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief summary of your question"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="message">Message *</Label>
              <Textarea
                id="message"
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder="Provide details about your question or request..."
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium leading-none">Urgency</span>
              <div className="flex gap-3">
                {(["Low", "Medium", "High"] as const).map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                      "flex-1",
                      priority === p &&
                        (p === "High"
                          ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
                          : p === "Medium"
                            ? "border-primary bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                            : "border-foreground/30 bg-muted text-foreground hover:bg-muted/80")
                    )}
                    onClick={() => setPriority(p)}
                  >
                    {p}
                  </Button>
                ))}
              </div>
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Could not send</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={sending}>
                {sending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Send Message
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        For medical emergencies, please call 911 or go to your nearest emergency
        room. Messages are typically responded to within 1-2 business days.
      </p>
    </div>
  );
}
