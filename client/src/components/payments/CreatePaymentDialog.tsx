import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/printWorkflow";
import { METHOD_LABELS, type PaymentMethod } from "./paymentMeta";
import { localDate } from "@/lib/format";

interface CreatePaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaymentCreated?: () => void;
}

interface CustomerOption {
  _id: string;
  id?: string;
  name: string;
  company?: string;
}

interface InvoiceOption {
  _id: string;
  invoiceNumber: string;
  totalAmount: number;
  balanceAmount: number;
  dueDate?: string;
}

const NO_INVOICE = "none";

const emptyForm = () => ({
  customerId: "",
  invoiceId: NO_INVOICE,
  amount: "",
  paymentMethod: "cash" as PaymentMethod,
  status: "completed" as "completed" | "pending",
  paymentDate: localDate(),
  referenceNumber: "",
  notes: ""
});

/** Record money received from a customer, optionally against one of their unpaid invoices. */
export function CreatePaymentDialog({ open, onOpenChange, onPaymentCreated }: CreatePaymentDialogProps) {
  const [form, setForm] = useState(emptyForm);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm());
    setError(null);
    apiClient
      .getCustomer({ limit: 100 })
      .then((res: { customers?: CustomerOption[] }) => setCustomers(res?.customers || []))
      .catch(() => setCustomers([]));
  }, [open]);

  useEffect(() => {
    if (!form.customerId) {
      setInvoices([]);
      return;
    }
    setLoadingInvoices(true);
    apiClient
      .getInvoices({ customerId: form.customerId, paymentStatus: "pending,partial,overdue", limit: 50 })
      .then((res: { invoices?: InvoiceOption[] }) => setInvoices((res?.invoices || []).filter((i) => i.balanceAmount > 0)))
      .catch(() => setInvoices([]))
      .finally(() => setLoadingInvoices(false));
  }, [form.customerId]);

  const selectedInvoice = invoices.find((i) => i._id === form.invoiceId);
  const set = <K extends keyof ReturnType<typeof emptyForm>>(key: K, value: ReturnType<typeof emptyForm>[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amount = Number(form.amount);
    if (!form.customerId) return setError("Choose the customer who paid.");
    if (!(amount > 0)) return setError("Enter the amount received.");
    if (selectedInvoice && form.status === "completed" && amount > selectedInvoice.balanceAmount + 0.01) {
      return setError(`That is more than the ${formatINR(selectedInvoice.balanceAmount)} still due on ${selectedInvoice.invoiceNumber}.`);
    }

    setSaving(true);
    try {
      await apiClient.createPayment({
        customerId: form.customerId,
        invoiceId: form.invoiceId === NO_INVOICE ? undefined : form.invoiceId,
        amount,
        paymentMethod: form.paymentMethod,
        status: form.status,
        paymentDate: form.paymentDate,
        referenceNumber: form.referenceNumber || undefined,
        notes: form.notes || undefined
      });
      toast({
        title: "Payment recorded",
        description: selectedInvoice ? `${formatINR(amount)} recorded against ${selectedInvoice.invoiceNumber}.` : `${formatINR(amount)} recorded.`
      });
      onPaymentCreated?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The payment could not be recorded.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>Money received from a customer. Recording it against an invoice reduces that invoice's balance.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-customer">Customer</Label>
            <Select value={form.customerId} onValueChange={(v) => setForm((prev) => ({ ...prev, customerId: v, invoiceId: NO_INVOICE, amount: "" }))}>
              <SelectTrigger id="pay-customer">
                <SelectValue placeholder="Choose a customer" />
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c._id || c.id} value={c._id || c.id || ""}>
                    {c.name}
                    {c.company ? ` — ${c.company}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-invoice">Against invoice</Label>
            <Select
              value={form.invoiceId}
              onValueChange={(v) => {
                const inv = invoices.find((i) => i._id === v);
                setForm((prev) => ({ ...prev, invoiceId: v, amount: inv ? String(inv.balanceAmount) : prev.amount }));
              }}
              disabled={!form.customerId || loadingInvoices}
            >
              <SelectTrigger id="pay-invoice">
                <SelectValue placeholder={loadingInvoices ? "Loading invoices…" : "No invoice"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_INVOICE}>No invoice (advance or on account)</SelectItem>
                {invoices.map((i) => (
                  <SelectItem key={i._id} value={i._id}>
                    {i.invoiceNumber} — {formatINR(i.balanceAmount)} due
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.customerId && !loadingInvoices && invoices.length === 0 && (
              <p className="text-xs text-muted-foreground">This customer has no unpaid invoices.</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Amount (₹)</Label>
              <Input id="pay-amount" type="number" inputMode="decimal" min="0.01" step="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">Date received</Label>
              <Input id="pay-date" type="date" value={form.paymentDate} onChange={(e) => set("paymentDate", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-method">Method</Label>
              <Select value={form.paymentMethod} onValueChange={(v: PaymentMethod) => set("paymentMethod", v)}>
                <SelectTrigger id="pay-method">
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
              <Label htmlFor="pay-status">Status</Label>
              <Select value={form.status} onValueChange={(v: "completed" | "pending") => set("status", v)}>
                <SelectTrigger id="pay-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="completed">Completed (money received)</SelectItem>
                  <SelectItem value="pending">Pending (e.g. cheque not cleared)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">Reference</Label>
            <Input id="pay-ref" value={form.referenceNumber} onChange={(e) => set("referenceNumber", e.target.value)} placeholder="UPI ref, cheque no., receipt no." />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-notes">Notes</Label>
            <Textarea id="pay-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Optional" />
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {saving ? "Recording…" : "Record payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
