import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { METHOD_LABELS, newIdempotencyKey, type PaymentMethod } from "@/components/payments/paymentMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR, localDate } from "@/lib/format";

export interface PayableInvoice {
  _id: string;
  invoiceNumber: string;
  totalAmount: number;
  paidAmount?: number;
  amountPaid?: number;
  balanceAmount?: number;
  dueDate?: string;
  paymentStatus: string;
  customerId?: string | { _id: string; name?: string } | null;
  customerName?: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const customerIdOf = (invoice: PayableInvoice | null) =>
  !invoice?.customerId ? "" : typeof invoice.customerId === "string" ? invoice.customerId : invoice.customerId._id;

/**
 * Money received against one invoice, recorded as a payment with its date,
 * method and reference — so the invoice's balance, its payment history and
 * the Payments totals all agree.
 *
 * Logins with "Invoicing: Correct Balance" can also correct the amount
 * recorded on the invoice outside payments (money taken before Carbon). That
 * needs a reason and is written to the Activity Log.
 */
export function InvoicePaymentDialog({
  invoice,
  onOpenChange,
  onSaved,
  startWith = "record"
}: {
  invoice: PayableInvoice | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Open on the balance correction instead (e.g. a settled invoice, or a login that can only correct). */
  startWith?: "record" | "correct";
}) {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canCorrect = hasPermission("Invoicing: Correct Balance");
  const [mode, setMode] = useState<"record" | "correct">("record");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(localDate());
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Correction: what payments already cover, and the amount recorded outside them.
  const [split, setSplit] = useState<{ recordedAmount: number; manualPaidAmount: number } | null>(null);
  const [manual, setManual] = useState("");
  const [reason, setReason] = useState("");
  // The key of the last submission: reused only if the same payment is sent again.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const total = invoice?.totalAmount || 0;
  const alreadyPaid = invoice?.paidAmount ?? invoice?.amountPaid ?? 0;
  const balance = invoice?.balanceAmount ?? Math.max(0, round2(total - alreadyPaid));

  useEffect(() => {
    if (!invoice) return;
    setMode("record");
    setAmount(balance > 0 ? String(balance) : "");
    setPaymentDate(localDate());
    setMethod("cash");
    setReference("");
    setError(null);
    setSplit(null);
    setManual("");
    setReason("");
    attempt.current = null;
    if (startWith === "correct" && canCorrect) startCorrection();
    // Reset only when another invoice is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice, balance]);

  const value = amount === "" ? null : Number(amount);
  const amountProblem =
    value === null ? null : !(value > 0) ? "Enter the amount received." : value > balance + 0.005 ? `More than the ${formatINR(balance)} still due.` : null;

  const record = async () => {
    if (!invoice) return;
    if (value === null || amountProblem) return setError(amountProblem || "Enter the amount received.");
    const payload = {
      customerId: customerIdOf(invoice),
      invoiceId: invoice._id,
      amount: round2(value),
      paymentMethod: method,
      paymentDate,
      referenceNumber: reference.trim() || undefined
    };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newIdempotencyKey() };
    setSaving(true);
    setError(null);
    try {
      await apiClient.createPayment({ ...payload, idempotencyKey: attempt.current.key });
      toast({ title: "Payment recorded", description: `${formatINR(payload.amount)} against ${invoice.invoiceNumber}.` });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The payment could not be recorded.");
    } finally {
      setSaving(false);
    }
  };

  const startCorrection = async () => {
    if (!invoice) return;
    setMode("correct");
    setError(null);
    try {
      const res = (await apiClient.getInvoice(invoice._id)) as { paymentSummary?: { recordedAmount: number; manualPaidAmount: number } };
      const summary = res.paymentSummary || { recordedAmount: alreadyPaid, manualPaidAmount: 0 };
      setSplit(summary);
      setManual(String(summary.manualPaidAmount));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invoice could not be loaded.");
    }
  };

  const manualValue = manual === "" ? null : Number(manual);
  const correctedPaid = split && manualValue !== null && manualValue >= 0 ? round2(split.recordedAmount + manualValue) : null;
  const correctionProblem =
    !split || manualValue === null
      ? null
      : !(manualValue >= 0)
        ? "Enter 0 or more."
        : correctedPaid !== null && correctedPaid > total + 0.005
          ? `Payments already cover ${formatINR(split.recordedAmount)}, so at most ${formatINR(Math.max(0, round2(total - split.recordedAmount)))} can be recorded outside them.`
          : null;

  const saveCorrection = async () => {
    if (!invoice || !split || manualValue === null || correctionProblem) return;
    if (reason.trim().length < 3) return setError("Say why the balance is being corrected.");
    setSaving(true);
    setError(null);
    try {
      await apiClient.correctInvoiceBalance(invoice._id, { manualPaidAmount: round2(manualValue), reason: reason.trim() });
      toast({ title: `${invoice.invoiceNumber} balance corrected`, description: "The change is in the Activity Log." });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The balance could not be corrected.");
    } finally {
      setSaving(false);
    }
  };

  const errorBox = error && (
    <p role="alert" className="flex items-start gap-1.5 rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {error}
    </p>
  );

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "record" ? "Record payment" : "Correct balance"}</DialogTitle>
          <DialogDescription>
            {invoice && `Invoice ${invoice.invoiceNumber}${invoice.customerName ? ` · ${invoice.customerName}` : ""}`}
          </DialogDescription>
        </DialogHeader>

        {invoice && (
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border text-sm">
            {[
              ["Total", formatINR(total), ""],
              ["Paid so far", formatINR(alreadyPaid), "text-success-strong"],
              ["Balance", formatINR(balance), "text-warning-strong"]
            ].map(([k, v, c]) => (
              <div key={k} className="min-w-0 bg-card px-3 py-2">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className={`num truncate font-semibold ${c}`}>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {mode === "record" ? (
          <form
            id="record-invoice-payment"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              record();
            }}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="inv-pay-amount">Amount received (₹)</Label>
                <Input
                  id="inv-pay-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  aria-invalid={!!amountProblem}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-pay-date">Date received</Label>
                <Input id="inv-pay-date" type="date" value={paymentDate} max={localDate()} onChange={(e) => setPaymentDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-pay-method">Method</Label>
                <Select value={method} onValueChange={(v: PaymentMethod) => setMethod(v)}>
                  <SelectTrigger id="inv-pay-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(METHOD_LABELS) as PaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-pay-ref">Reference</Label>
                <Input id="inv-pay-ref" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder="UPI ref, cheque no." />
              </div>
            </div>
            {amountProblem ? (
              <p className="text-xs text-destructive-strong">{amountProblem}</p>
            ) : (
              value !== null && <p className="text-xs text-muted-foreground">Balance after this: {formatINR(Math.max(0, round2(balance - value)))}</p>
            )}
            {errorBox}
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              For money received before Carbon, or never entered as a payment. Payments recorded against this invoice stay as they are. The correction and its reason go in the Activity Log.
            </p>
            {split ? (
              <>
                <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Recorded as payments</span>
                  <span className="num font-semibold">{formatINR(split.recordedAmount)}</span>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inv-manual">Received outside payments (₹)</Label>
                  <Input
                    id="inv-manual"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    aria-invalid={!!correctionProblem}
                  />
                  {correctionProblem ? (
                    <p className="text-xs text-destructive-strong">{correctionProblem}</p>
                  ) : (
                    correctedPaid !== null && (
                      <p className="text-xs text-muted-foreground">
                        Paid becomes {formatINR(correctedPaid)} · balance {formatINR(Math.max(0, round2(total - correctedPaid)))}
                      </p>
                    )
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inv-correct-reason">Reason</Label>
                  <Textarea
                    id="inv-correct-reason"
                    rows={2}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Cash received in October, before Carbon"
                  />
                </div>
              </>
            ) : (
              !error && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
              )
            )}
            {errorBox}
          </div>
        )}

        <DialogFooter className="gap-2 sm:items-center">
          {mode === "record" && canCorrect && (
            <Button type="button" variant="link" size="sm" className="mr-auto h-auto px-0 text-muted-foreground" onClick={startCorrection} disabled={saving}>
              <History />
              Correct balance…
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => (mode === "correct" ? (setMode("record"), setError(null)) : onOpenChange(false))}
            disabled={saving}
          >
            {mode === "correct" ? "Back" : "Cancel"}
          </Button>
          {mode === "record" ? (
            <Button type="submit" form="record-invoice-payment" loading={saving} disabled={!!amountProblem || value === null || balance <= 0}>
              {!saving && <CheckCircle />}
              {saving ? "Recording…" : "Record payment"}
            </Button>
          ) : (
            <Button type="button" onClick={saveCorrection} loading={saving} disabled={!split || !!correctionProblem || manualValue === null || reason.trim().length < 3}>
              {saving ? "Saving…" : "Save correction"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
