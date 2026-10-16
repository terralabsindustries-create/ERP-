import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";

export interface PayableInvoice {
  _id: string;
  invoiceNumber: string;
  totalAmount: number;
  paidAmount?: number;
  amountPaid?: number;
  balanceAmount?: number;
  dueDate?: string;
  paymentStatus: string;
}

/**
 * Set how much of an invoice has been paid in total. For money received on a
 * date and method, Payments → Record payment is the better place; this is for
 * correcting the running total.
 */
export function InvoicePaymentDialog({
  invoice,
  onOpenChange,
  onSaved
}: {
  invoice: PayableInvoice | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState("pending");
  const [paid, setPaid] = useState("");
  const [saving, setSaving] = useState(false);

  const total = invoice?.totalAmount || 0;
  const alreadyPaid = invoice?.paidAmount ?? invoice?.amountPaid ?? 0;

  useEffect(() => {
    if (!invoice) return;
    setStatus(invoice.paymentStatus || "pending");
    setPaid(alreadyPaid > 0 ? String(alreadyPaid) : "");
  }, [invoice, alreadyPaid]);

  const amount = paid === "" ? null : Number(paid);
  const invalid = amount !== null && (Number.isNaN(amount) || amount < 0);
  const exceeds = amount !== null && !invalid && amount > total;

  const save = async () => {
    if (!invoice || invalid || exceeds) return;
    setSaving(true);
    try {
      await apiClient.updateInvoicePaymentStatus(invoice._id, { paymentStatus: status, ...(amount !== null ? { amountPaid: amount } : {}) });
      toast({ title: `${invoice.invoiceNumber} updated` });
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update payment</DialogTitle>
          <DialogDescription>{invoice && `Invoice ${invoice.invoiceNumber}`}</DialogDescription>
        </DialogHeader>

        {invoice && (
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border text-sm">
            {[
              ["Total", formatINR(total), ""],
              ["Paid so far", formatINR(alreadyPaid), "text-success-strong"],
              ["Balance", formatINR(Math.max(0, total - alreadyPaid)), "text-warning-strong"]
            ].map(([k, v, c]) => (
              <div key={k} className="bg-card px-3 py-2">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className={`num font-semibold ${c}`}>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-status">Payment status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="pay-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Unpaid</SelectItem>
                <SelectItem value="partial">Part paid</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                {invoice?.dueDate && new Date(invoice.dueDate) <= new Date() && <SelectItem value="overdue">Overdue</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount">Total paid so far (₹)</Label>
            <Input
              id="pay-amount"
              type="number"
              min="0"
              max={total}
              step="0.01"
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              placeholder="0.00"
              aria-invalid={invalid || exceeds}
            />
            {exceeds ? (
              <p className="flex items-center gap-1.5 text-xs text-destructive-strong">
                <AlertTriangle className="h-3.5 w-3.5" />
                More than the invoice total of {formatINR(total)}.
              </p>
            ) : (
              amount !== null &&
              !invalid && <p className="text-xs text-muted-foreground">Balance after this: {formatINR(Math.max(0, total - amount))}</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || invalid || exceeds}>
            {saving ? <Loader2 className="animate-spin" /> : <CheckCircle />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
