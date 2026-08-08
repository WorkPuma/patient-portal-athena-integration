"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, CheckCircle2, CreditCard } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trackInvoicePaid, trackInvoicePaymentFailed } from "@/lib/posthog/events";

interface Invoice {
  id: string;
  amount_cents: number;
  balance_cents: number;
  status: string;
  due_date: string;
  description?: string;
}

export function PayInvoice() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const invoiceId = searchParams.get("invoiceId");

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<string>(invoiceId || "");
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/portal/hint/invoices");
        if (res.ok) {
          const data = await res.json();
          const unpaid = (data.invoices || []).filter(
            (i: Invoice) => i.status === "unpaid" || i.status === "partially_paid"
          );
          setInvoices(unpaid);
          if (!selectedInvoice && unpaid.length > 0) {
            setSelectedInvoice(unpaid[0].id);
          }
        }
      } catch (err) {
        console.error("Load invoices error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [selectedInvoice]);

  async function handlePay() {
    if (!selectedInvoice) return;
    setPaying(true);
    setError("");

    try {
      const res = await fetch(`/api/portal/hint/invoices/${selectedInvoice}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const data = await res.json();
        const errorMessage = data.error || "Payment failed";
        setError(errorMessage);
        trackInvoicePaymentFailed({ errorMessage });
        return;
      }

      trackInvoicePaid();
      setPaid(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPaying(false);
    }
  }

  function formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  if (paid) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-500" />
        <h2 className="mb-2 text-xl font-medium text-foreground">
          Payment Successful
        </h2>
        <p className="mb-6 text-muted-foreground">Your invoice has been paid.</p>
        <Button onClick={() => router.push("/membership")}>
          Back to Membership
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-48" />
        <Card>
          <CardContent className="space-y-4 pt-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-11 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const selected = invoices.find((i) => i.id === selectedInvoice);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 h-auto px-2 text-muted-foreground" asChild>
        <Link href="/membership">
          <ArrowLeft className="h-4 w-4" />
          Back to Membership
        </Link>
      </Button>

      <h1 className="font-serif text-2xl font-medium text-foreground">
        Pay Invoice
      </h1>

      {invoices.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-10 text-center">
            <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-green-400" />
            <p className="text-muted-foreground">No outstanding invoices</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-6 pt-6">
            {invoices.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="invoice-select">Select invoice</Label>
                <Select
                  value={selectedInvoice}
                  onValueChange={setSelectedInvoice}
                >
                  <SelectTrigger id="invoice-select" className="w-full">
                    <SelectValue placeholder="Choose an invoice" />
                  </SelectTrigger>
                  <SelectContent>
                    {invoices.map((inv) => (
                      <SelectItem key={inv.id} value={inv.id}>
                        {inv.description || `Invoice #${inv.id}`} —{" "}
                        {formatCents(inv.balance_cents)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selected && (
              <div className="rounded-lg bg-muted p-4">
                <div className="mb-2 flex justify-between">
                  <span className="text-muted-foreground">Invoice</span>
                  <span className="font-medium text-foreground">
                    {selected.description || `#${selected.id}`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount due</span>
                  <span className="text-xl font-semibold text-foreground">
                    {formatCents(selected.balance_cents)}
                  </span>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  Payment method on file
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Payment will be processed through your HINT Health account.
              </p>
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Payment error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button
              className="w-full"
              size="lg"
              onClick={handlePay}
              disabled={paying || !selectedInvoice}
            >
              {paying ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                `Pay ${selected ? formatCents(selected.balance_cents) : ""}`
              )}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
