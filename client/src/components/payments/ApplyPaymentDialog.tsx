import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";
import type { PaymentRecord } from "./paymentMeta";

interface InvoiceOption {
  _id: string;
  invoiceNumber: string;
  balanceAmount: number;
}

export function ApplyPaymentDialog({ payment, onClose, onApplied }: {
  payment: PaymentRecord | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoiceId, setInvoiceId] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const customerId = typeof payment?.customerId === "object" ? payment.customerId?._id : payment?.customerId;
  const paymentAmount = payment?.amount;

  useEffect(() => {
    if (!paymentAmount || !customerId) return;
    let cancelled = false;
    setInvoiceId("");
    setInvoices([]);
    apiClient.getInvoices({ customerId, paymentStatus: "pending,partial,overdue", limit: 100 })
      .then((res: { invoices?: InvoiceOption[] }) => {
        if (!cancelled) setInvoices((res.invoices || []).filter((i) => i.balanceAmount >= paymentAmount));
      })
      .catch((error: Error) => {
        if (!cancelled) toast({ title: "Invoices could not be loaded", description: error.message, variant: "destructive" });
      });
    return () => { cancelled = true; };
  }, [payment?._id, customerId, paymentAmount, toast]);

  const apply = async () => {
    if (!payment || !invoiceId) return;
    setSaving(true);
    try {
      await apiClient.updatePayment(payment._id, { invoiceId });
      toast({ title: "Payment applied to invoice" });
      onApplied();
      onClose();
    } catch (error) {
      toast({ title: "Payment not applied", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!payment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Apply on-account payment</DialogTitle>
          <DialogDescription>{payment && `Apply ${formatINR(payment.amount)} to an invoice for ${payment.customerName}.`}</DialogDescription>
        </DialogHeader>
        <Select value={invoiceId} onValueChange={setInvoiceId}>
          <SelectTrigger aria-label="Choose invoice"><SelectValue placeholder="Choose an invoice" /></SelectTrigger>
          <SelectContent>
            {invoices.map((invoice) => (
              <SelectItem key={invoice._id} value={invoice._id}>
                {invoice.invoiceNumber} · {formatINR(invoice.balanceAmount)} due
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!invoices.length && <p className="text-sm text-muted-foreground">No invoice has enough remaining balance for this payment.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={!invoiceId || saving}>{saving ? "Applying…" : "Apply payment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
