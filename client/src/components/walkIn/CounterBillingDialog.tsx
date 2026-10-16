import { useEffect, useMemo, useState } from "react";
import { Banknote, CreditCard, Plus, Smartphone, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  counterJobsApi,
  createCounterInvoice,
  customersApi,
  recordCounterPayment,
  type CounterJob,
  type CounterPaymentMethod,
  type CustomerLite
} from "@/lib/api/walkIn";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { JOB_TYPE_LABEL, METHOD_LABEL, errorText, fmtPhone, specsSummary } from "./counterJobMeta";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

interface Line {
  key: number;
  itemName: string;
  description: string;
  quantity: string;
  rate: string;
}

/** The first line: the job itself, priced from the estimate. */
function jobLine(job: CounterJob): Line {
  const qty = Math.max(1, (job.specifications.quantity || 1) * (job.specifications.copies || 1));
  const price = job.pricing.estimatedCost || 0;
  const unit = round2(price / qty);
  const even = round2(unit * qty) === round2(price);
  return {
    key: 1,
    itemName: `${JOB_TYPE_LABEL[job.jobType]}: ${job.description}`.slice(0, 120),
    description: `${specsSummary(job)} · Counter job ${job.jobNumber}`,
    quantity: String(even ? qty : 1),
    rate: price ? String(even ? unit : price) : ""
  };
}

type Customer = { state: "loading" } | { state: "found"; customer: CustomerLite } | { state: "new" } | { state: "error"; message: string };

/**
 * Bill a ready (or collected) job at the counter: an invoice (no GST) through
 * the invoices API, the advance and the money taken now through the payments API,
 * and the invoice linked back to the job.
 */
export function CounterBillingDialog({ job, onOpenChange, onBilled }: { job: CounterJob | null; onOpenChange: (open: boolean) => void; onBilled: (job: CounterJob) => void }) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canPay = hasPermission("Payments: Record Payment");
  const canAddCustomer = hasPermission("Customers: Create & Edit");

  const [customer, setCustomer] = useState<Customer>({ state: "loading" });
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("");
  const [collect, setCollect] = useState("");
  const [collectTouched, setCollectTouched] = useState(false);
  const [method, setMethod] = useState<CounterPaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [markCollected, setMarkCollected] = useState(true);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!job) return;
    setLines([jobLine(job)]);
    setDiscount("");
    setCollect("");
    setCollectTouched(false);
    setMethod("cash");
    setReference("");
    setMarkCollected(job.status === "ready");
    setError("");
    setStep("");
    setCustomer({ state: "loading" });
    if (job.customerId) {
      setCustomer({ state: "found", customer: { _id: job.customerId, name: job.customerName, phone: job.customerPhone } });
    } else {
      customersApi
        .findByPhone(job.customerPhone)
        .then((c) => setCustomer(c ? { state: "found", customer: c } : { state: "new" }))
        .catch((err) => setCustomer({ state: "error", message: errorText(err) || "Customers could not be checked." }));
    }
  }, [job]);

  // The same arithmetic the invoices API does, so the total shown is the total billed.
  const calc = useMemo(() => {
    const items = lines.map((l) => {
      const qty = Number(l.quantity) || 0;
      const unitPrice = round2(Number(l.rate) || 0);
      return { ...l, qty, unitPrice, total: round2(qty * unitPrice) };
    });
    const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
    const disc = round2(Number(discount) || 0);
    return { items, subtotal, disc, total: round2(subtotal - disc) };
  }, [lines, discount]);

  const advance = canPay && job ? Math.min(round2(job.pricing.advancePaid || 0), calc.total) : 0;
  const balance = round2(calc.total - advance);
  const collectNow = collectTouched ? round2(Number(collect) || 0) : balance;

  const setLine = (key: number, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setError("");
  };

  const problem = () => {
    if (customer.state === "loading") return "Still checking the customer.";
    if (customer.state === "error") return customer.message;
    if (customer.state === "new" && !canAddCustomer) return `${job?.customerName} isn't in Customers yet, and your login can't add customers. Ask an admin to add them first.`;
    if (!calc.items.length || calc.items.some((i) => !i.itemName.trim())) return "Every line needs an item name.";
    if (calc.items.some((i) => !(i.qty > 0))) return "Every line needs a quantity.";
    if (calc.items.some((i) => !(Number(i.rate) >= 0) || i.rate === "")) return "Every line needs a rate.";
    if (calc.subtotal <= 0) return "The bill is ₹0 — enter the rates.";
    if (calc.disc < 0 || calc.disc > calc.subtotal) return "The discount can't be more than the bill.";
    if (collectNow < 0 || collectNow > balance + 0.001) return `You can collect at most ${formatINR(balance)} now.`;
    return "";
  };

  const submit = async () => {
    if (!job) return;
    const p = problem();
    if (p) return setError(p);
    setError("");
    let invoice: Awaited<ReturnType<typeof createCounterInvoice>> | null = null;
    try {
      let customerId: string;
      if (customer.state === "found") customerId = customer.customer._id;
      else {
        setStep("Adding customer…");
        customerId = (await customersApi.create({ name: job.customerName, phone: job.customerPhone, email: job.customerEmail }))._id;
      }

      setStep("Creating invoice…");
      invoice = await createCounterInvoice({
        customerId,
        lines: calc.items.map((i) => ({ itemName: i.itemName.trim(), description: i.description.trim(), quantity: i.qty, unitPrice: i.unitPrice })),
        discountAmount: calc.disc,
        notes: `Counter job ${job.jobNumber}`
      });

      setStep("Linking to the job…");
      let updated = await counterJobsApi.linkInvoice(job._id, invoice._id);

      const failures: string[] = [];
      if (canPay) {
        setStep("Recording payment…");
        if (advance > 0) {
          await recordCounterPayment({
            customerId,
            invoiceId: invoice._id,
            amount: advance,
            paymentMethod: job.pricing.advanceMethod || "cash",
            paymentDate: job.createdAt,
            referenceNumber: job.jobNumber,
            notes: `Advance taken with counter job ${job.jobNumber}`
          }).catch((err) => failures.push(`advance: ${errorText(err)}`));
        }
        if (collectNow > 0) {
          await recordCounterPayment({
            customerId,
            invoiceId: invoice._id,
            amount: collectNow,
            paymentMethod: method,
            referenceNumber: reference.trim() || job.jobNumber,
            notes: `Collected at the counter for ${job.jobNumber}`
          }).catch((err) => failures.push(`payment: ${errorText(err)}`));
        }
      }

      if (markCollected && updated.status === "ready") {
        setStep("Marking collected…");
        updated = await counterJobsApi.setStatus(job._id, "collected").catch((err) => {
          failures.push(`collected: ${errorText(err)}`);
          return updated;
        });
      }
      updated = await counterJobsApi.get(job._id).catch(() => updated);

      if (failures.length) {
        toast({ title: `Billed on ${invoice.invoiceNumber}, with problems`, description: `Not done — ${failures.join("; ")}. Finish it from Payments.`, variant: "destructive" });
      } else {
        const paid = advance + collectNow;
        toast({
          title: `Billed on ${invoice.invoiceNumber}`,
          description: canPay ? (paid >= calc.total ? `${formatINR(calc.total)} paid in full.` : `${formatINR(paid)} received · ${formatINR(round2(calc.total - paid))} due.`) : "Record the payment from Payments."
        });
      }
      onBilled(updated);
      onOpenChange(false);
    } catch (err) {
      if (invoice) {
        toast({ title: `${invoice.invoiceNumber} was created, but not linked to the job`, description: errorText(err), variant: "destructive" });
        onOpenChange(false);
      } else {
        setError(errorText(err) || "The bill could not be created.");
      }
    } finally {
      setStep("");
    }
  };

  const busy = !!step;
  const methods: { value: CounterPaymentMethod; icon: typeof Banknote }[] = [
    { value: "cash", icon: Banknote },
    { value: "upi", icon: Smartphone },
    { value: "card", icon: CreditCard }
  ];

  return (
    <Dialog open={!!job} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bill {job?.jobNumber}</DialogTitle>
          <DialogDescription>{job ? `${job.customerName} · ${fmtPhone(job.customerPhone)}` : null}</DialogDescription>
        </DialogHeader>

        {job && (
          <div className="space-y-5">
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                {customer.state === "loading" && "Checking Customers…"}
                {customer.state === "found" && (
                  <>
                    Billed to <span className="font-medium">{customer.customer.name}</span> from Customers
                  </>
                )}
                {customer.state === "new" &&
                  (canAddCustomer ? (
                    <>
                      <span className="font-medium">{job.customerName}</span> will be added to Customers with this number
                    </>
                  ) : (
                    <span className="text-destructive-strong">{job.customerName} isn't in Customers, and your login can't add customers.</span>
                  ))}
                {customer.state === "error" && <span className="text-destructive-strong">{customer.message}</span>}
              </span>
            </div>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Items</h3>
              <div className="space-y-3">
                {lines.map((l, idx) => {
                  const item = calc.items[idx];
                  return (
                    <div key={l.key} className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border p-2.5 sm:grid-cols-[1fr_5rem_7rem_6rem_auto] sm:items-end">
                      <div className="col-span-2 space-y-1 sm:col-span-1">
                        <Label htmlFor={`bill-item-${l.key}`} className="text-xs text-muted-foreground">
                          Item
                        </Label>
                        <Input id={`bill-item-${l.key}`} value={l.itemName} onChange={(e) => setLine(l.key, { itemName: e.target.value })} />
                      </div>
                      <div className="col-span-2 grid grid-cols-3 gap-2 sm:contents">
                        <div className="space-y-1">
                          <Label htmlFor={`bill-qty-${l.key}`} className="text-xs text-muted-foreground">
                            Qty
                          </Label>
                          <Input id={`bill-qty-${l.key}`} type="number" inputMode="decimal" min={0} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`bill-rate-${l.key}`} className="text-xs text-muted-foreground">
                            Rate (₹)
                          </Label>
                          <Input id={`bill-rate-${l.key}`} type="number" inputMode="decimal" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} />
                        </div>
                        <div className="space-y-1 text-right">
                          <span className="block text-xs text-muted-foreground">Amount</span>
                          <span className="num block py-2 text-sm font-medium">{formatINR(item?.total || 0)}</span>
                        </div>
                      </div>
                      <div className="col-start-2 row-start-1 flex items-end sm:col-start-auto sm:row-start-auto">
                        {lines.length > 1 && (
                          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, itemName: "", description: `Counter job ${job.jobNumber}`, quantity: "1", rate: "" }])}
              >
                <Plus />
                Add line
              </Button>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bill-discount">Discount (₹)</Label>
                <Input id="bill-discount" type="number" inputMode="decimal" min={0} step="0.01" value={discount} onChange={(e) => {
                    setDiscount(e.target.value);
                    setError("");
                  }} placeholder="0" />
              </div>
            </section>

            <dl className="space-y-1 rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="num">{formatINR(calc.subtotal)}</dd>
              </div>
              {calc.disc > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd className="num">− {formatINR(calc.disc)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t pt-1.5 text-base font-semibold">
                <dt>Invoice total</dt>
                <dd className="num">{formatINR(calc.total)}</dd>
              </div>
            </dl>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Payment</h3>
              {!canPay ? (
                <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">Your login can't record payments. The invoice will be issued unpaid; record the payment from Payments.</p>
              ) : (
                <>
                  {advance > 0 && (
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">
                        Advance taken with the job · {METHOD_LABEL[job.pricing.advanceMethod] || job.pricing.advanceMethod}
                      </span>
                      <span className="num">{formatINR(advance)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3 text-sm font-medium">
                    <span>Balance to collect</span>
                    <span className="num">{formatINR(balance)}</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="bill-collect">Collect now (₹)</Label>
                      <Input
                        id="bill-collect"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={collectTouched ? collect : String(balance)}
                        onChange={(e) => {
                          setCollectTouched(true);
                          setCollect(e.target.value);
                          setError("");
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <span className="text-sm font-medium">Paid by</span>
                      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Paid by">
                        {methods.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            role="radio"
                            aria-checked={method === m.value}
                            onClick={() => setMethod(m.value)}
                            className={cn(
                              "flex h-9 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              method === m.value && "border-primary bg-primary-soft text-primary-strong hover:bg-primary-soft"
                            )}
                          >
                            <m.icon className="h-4 w-4" />
                            {METHOD_LABEL[m.value]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {method !== "cash" && collectNow > 0 && (
                    <div className="space-y-1.5">
                      <Label htmlFor="bill-ref">{method === "upi" ? "UPI reference" : "Card approval code"}</Label>
                      <Input id="bill-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
                    </div>
                  )}
                  {collectNow < balance && <p className="text-xs text-warning-strong">{formatINR(round2(balance - collectNow))} will stay due on the invoice.</p>}
                </>
              )}
              {job.status === "ready" && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={markCollected} onCheckedChange={(v) => setMarkCollected(v === true)} />
                  The customer is taking the job now (mark collected)
                </label>
              )}
            </section>
            {error && (
              <p role="alert" className="text-sm text-destructive-strong">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={customer.state === "loading"}>
            {step || (canPay && advance + collectNow > 0 ? `Create invoice & record ${formatINR(round2(advance + collectNow))}` : "Create invoice")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
