import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PaymentRecord } from "./paymentMeta";

interface InvoiceOption {
  _id: string;
  invoiceNumber: string;
  balanceAmount: number;
  totalAmount?: number;
  dueDate?: string;
}

interface Row {
  invoiceId: string;
  invoiceNumber: string;
  dueDate?: string;
  /** Most this payment can put on the invoice: its balance plus what this payment already pays it. */
  max: number;
  current: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Which of the customer's invoices a payment pays, and how much to each. Part
 * of an advance can go to one invoice and the rest to others; whatever is not
 * allocated stays on the customer's account. Clearing an amount takes the
 * payment off that invoice again.
 */
export function ApplyPaymentDialog({ payment, onClose, onApplied }: {
  payment: PaymentRecord | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const customerId = typeof payment?.customerId === "object" ? payment.customerId?._id : payment?.customerId;
  const paymentAmount = payment?.amount || 0;

  useEffect(() => {
    if (!payment || !customerId) return;
    let cancelled = false;
    setError(null);
    setInvoices([]);
    setAmounts(Object.fromEntries((payment.allocations || []).map((a) => [a.invoiceId, String(a.amount)])));
    setLoading(true);
    apiClient.getInvoices({ customerId, view: "unpaid", limit: 100, sortBy: "dueDate", sortOrder: "asc" })
      .then((res: { invoices?: InvoiceOption[] }) => {
        if (!cancelled) setInvoices(res.invoices || []);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Invoices could not be loaded: ${err.message}`);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [payment, customerId]);

  // Invoices this payment already pays (they may be settled now, so not in the
  // unpaid list) first, then the customer's other unpaid invoices.
  const rows: Row[] = useMemo(() => {
    const current = new Map((payment?.allocations || []).map((a) => [a.invoiceId, a]));
    // A pending payment's allocations are not counted on the invoice yet.
    const counted = payment?.status === "completed";
    const byId = new Map(invoices.map((i) => [i._id, i]));
    const list: Row[] = [];
    for (const a of payment?.allocations || []) {
      const inv = byId.get(a.invoiceId);
      list.push({
        invoiceId: a.invoiceId,
        invoiceNumber: a.invoiceNumber || inv?.invoiceNumber || "Invoice",
        dueDate: inv?.dueDate,
        current: a.amount,
        max: round2((inv?.balanceAmount || 0) + (counted ? a.amount : 0))
      });
    }
    for (const inv of invoices) {
      if (current.has(inv._id)) continue;
      list.push({ invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, dueDate: inv.dueDate, current: 0, max: round2(inv.balanceAmount) });
    }
    return list;
  }, [invoices, payment]);

  const valueOf = (id: string) => {
    const v = Number(amounts[id] || 0);
    return Number.isFinite(v) ? round2(v) : NaN;
  };
  const allocated = round2(rows.reduce((sum, r) => sum + (valueOf(r.invoiceId) || 0), 0));
  const left = round2(paymentAmount - allocated);
  const rowProblem = (r: Row) => {
    const v = valueOf(r.invoiceId);
    if (Number.isNaN(v) || v < 0) return "Enter 0 or more";
    if (v > r.max + 0.005) return `At most ${formatINR(r.max)}`;
    return null;
  };
  const problems = rows.some((r) => rowProblem(r));
  const overAllocated = left < -0.005;
  const changed = rows.some((r) => Math.abs((valueOf(r.invoiceId) || 0) - r.current) >= 0.005);

  /** Spreads what is left over the invoices in order (soonest due first), up to each one's balance. */
  const fillInOrder = () => {
    let remaining = paymentAmount;
    const next: Record<string, string> = {};
    for (const r of rows) {
      const take = round2(Math.min(r.max, Math.max(0, remaining)));
      next[r.invoiceId] = take > 0 ? String(take) : "";
      remaining = round2(remaining - take);
    }
    setAmounts(next);
  };

  const save = async () => {
    if (!payment || problems || overAllocated) return;
    setSaving(true);
    setError(null);
    try {
      const allocations = rows
        .map((r) => ({ invoiceId: r.invoiceId, amount: valueOf(r.invoiceId) || 0 }))
        .filter((a) => a.amount > 0);
      await apiClient.setPaymentAllocations(payment._id, allocations, payment.__v);
      toast({
        title: "Allocations saved",
        description: left > 0.005 ? `${formatINR(left)} stays on ${payment.customerName}'s account.` : `All ${formatINR(paymentAmount)} applied to invoices.`
      });
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The allocations could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!payment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Allocate payment</DialogTitle>
          <DialogDescription>
            {payment && `${formatINR(paymentAmount)} from ${payment.customerName}. Apply it to their invoices; anything not applied stays on account.`}
          </DialogDescription>
        </DialogHeader>

        {payment?.status === "pending" && (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
            This payment is pending. Its allocations count on the invoices once it is marked received.
          </p>
        )}

        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {loading && !rows.length ? (
            <div className="space-y-2">
              {[1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">This customer has no unpaid invoices.</p>
          ) : (
            rows.map((r) => {
              const problem = rowProblem(r);
              return (
                <div key={r.invoiceId} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px] font-semibold text-primary">{r.invoiceNumber}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.max > 0 ? `Up to ${formatINR(r.max)}` : "Settled"}
                      {r.dueDate ? ` · due ${fmtDate(r.dueDate)}` : ""}
                    </div>
                    {problem && <div className="text-xs text-destructive-strong">{problem}</div>}
                  </div>
                  <Input
                    aria-label={`Amount for ${r.invoiceNumber}`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    className={cn("w-28 text-right", problem && "border-destructive")}
                    value={amounts[r.invoiceId] ?? ""}
                    onChange={(e) => setAmounts((prev) => ({ ...prev, [r.invoiceId]: e.target.value }))}
                    placeholder="0.00"
                    aria-invalid={!!problem}
                  />
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span>
            Allocated <span className="num font-semibold">{formatINR(allocated)}</span>
          </span>
          <span className={cn(overAllocated ? "text-destructive-strong" : "text-muted-foreground")}>
            {overAllocated ? `${formatINR(-left)} more than the payment` : `${formatINR(left)} on account`}
          </span>
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:items-center">
          <Button type="button" variant="link" size="sm" className="mr-auto h-auto px-0 text-muted-foreground" onClick={fillInOrder} disabled={!rows.length || saving}>
            <ListChecks />
            Fill soonest due first
          </Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!changed || problems || overAllocated}>
            {saving ? "Saving…" : "Save allocations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
