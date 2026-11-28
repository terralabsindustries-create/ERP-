import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EditorSheet } from "@/components/users/EditorSheet";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";
import { newIdempotencyKey } from "@/components/payments/paymentMeta";
import {
  SALES_TYPES, isAreaUnit, orderPayload,
  type ChargeForm, type OrderLineForm, type OrderTotals, type PricedLine, type ProductRateSummary, type QuotationLine, type SalesOrderRecord, type SavedLine,
} from "@/lib/salesOrders";

interface Customer { _id: string; name: string; phone?: string; address?: string; gstNumber?: string; customerType?: string }

let keySeq = 1;
const blankLine = (): OrderLineForm => ({ key: keySeq++, product: null, query: "", copies: "", length: "", width: "", dimUnit: "ft", discountType: "percent", discountValue: "", overrideRate: "", overrideReason: "", wastage: "", workType: "", basicDetails: "", additionalDetails: "", stages: { design: false, printing: true, finishing: false } });
const blankCharge = (): ChargeForm => ({ key: keySeq++, name: "", amount: "", gstRate: "18", taxable: true });
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Create or edit a sales order. Every amount shown is the server's: the form
 * sends what was typed to POST /product-rates/price (debounced) and displays
 * the answer; the same code prices the order again when it is saved. If the
 * price call fails, what was typed stays and a Retry button asks again.
 */
export function SalesOrderEditor({ open, onOpenChange, order, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; order?: SalesOrderRecord | null; onSaved: () => void }) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canDiscount = hasPermission("Sales Orders: Apply Discount");
  const canOverride = hasPermission("Sales Orders: Override Rate");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerHits, setCustomerHits] = useState<Customer[]>([]);
  const [orderDate, setOrderDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [projectName, setProjectName] = useState("");
  const [salesType, setSalesType] = useState<string>("Retail");
  const [copyOption, setCopyOption] = useState("copy");
  const [mobile, setMobile] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<OrderLineForm[]>([blankLine()]);
  const [charges, setCharges] = useState<ChargeForm[]>([]);
  const [quotationNo, setQuotationNo] = useState("");
  const [quotationId, setQuotationId] = useState<string | undefined>();
  const [priced, setPriced] = useState<{ lines: PricedLine[]; totals: OrderTotals; partyType?: string; customerState?: string } | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [productHits, setProductHits] = useState<{ line: number; items: ProductRateSummary[] }>({ line: -1, items: [] });
  const requestId = useRef(newIdempotencyKey());
  const priceSeq = useRef(0);
  const searchSeq = useRef(0);

  // Load the order being edited, or start blank.
  useEffect(() => {
    if (!open) return;
    requestId.current = newIdempotencyKey();
    setFormError(null); setPriced(null); setPriceError(null); setQuotationId(undefined); setQuotationNo(""); setCustomerHits([]);
    if (!order) {
      setCustomer(null); setCustomerQuery(""); setOrderDate(today()); setDueDate(""); setProjectName(""); setSalesType("Retail"); setCopyOption("copy");
      setMobile(""); setAddress(""); setNotes(""); setLines([blankLine()]); setCharges([]);
      return;
    }
    const cust = typeof order.customerId === "object" ? order.customerId : { _id: order.customerId, name: order.customerName };
    setCustomer({ _id: String(cust._id), name: order.customerName || cust.name });
    setCustomerQuery(order.customerName || "");
    setOrderDate(String(order.orderDate || "").slice(0, 10) || today());
    setDueDate(order.dueDate ? String(order.dueDate).slice(0, 10) : "");
    setProjectName(order.projectName || ""); setSalesType(order.salesType || "Retail"); setCopyOption(order.copyOption || "copy");
    setMobile(order.customerSnapshot?.mobile || ""); setAddress(order.customerSnapshot?.address || ""); setNotes(order.notes || "");
    setLines((order.orderLines || []).map((l: SavedLine) => ({
      key: keySeq++,
      product: { _id: String(l.productId), productName: l.productName, productCode: l.productCode, materialType: l.materialType, unit: l.unit, gstRate: l.pricing?.gstRate ?? 0, isActive: true },
      query: "", copies: String(l.copies ?? ""), length: l.length ? String(l.length) : "", width: l.width ? String(l.width) : "", dimUnit: l.dimUnit || "ft",
      discountType: l.discountType || "percent", discountValue: l.discountValue ? String(l.discountValue) : "",
      overrideRate: l.pricingSnapshot?.override ? String(l.pricingSnapshot.override.rate) : "", overrideReason: l.pricingSnapshot?.override?.reason || "",
      wastage: l.wastage ? String(l.wastage) : "", workType: l.workType || "", basicDetails: l.basicDetails || "", additionalDetails: l.additionalDetails || "",
      stages: l.stages || { design: false, printing: false, finishing: false },
    })));
    setCharges((order.otherCharges || []).map((c) => ({ key: keySeq++, name: c.name || "", amount: String(c.amount ?? ""), gstRate: String(c.gstRate ?? 0), taxable: c.taxable !== false })));
  }, [open, order]);

  // Server-side customer search, 2+ letters, never the whole customer list.
  useEffect(() => {
    if (!open || customer || customerQuery.trim().length < 2) { setCustomerHits([]); return; }
    const t = setTimeout(async () => {
      const seq = ++searchSeq.current;
      try {
        const r = await apiClient.get<{ customers: Customer[] }>("/customers", { search: customerQuery, limit: 8, status: "active" });
        if (seq === searchSeq.current) setCustomerHits(r.customers || []);
      } catch { /* typing again retries */ }
    }, 250);
    return () => clearTimeout(t);
  }, [customerQuery, customer, open]);

  const pickCustomer = (c: Customer) => {
    setCustomer(c); setCustomerQuery(c.name); setCustomerHits([]);
    setMobile(c.phone || ""); setAddress(c.address || "");
  };

  // Live server pricing, debounced; a newer request makes older answers irrelevant.
  const price = useCallback(async () => {
    if (!customer || !lines.some((l) => l.product && Number(l.copies) > 0)) { setPriced(null); return; }
    const seq = ++priceSeq.current;
    setPricing(true);
    setPriceError(null);
    try {
      const r = await apiClient.priceOrder(orderPayload({ customerId: customer._id, salesType, lines, charges }));
      if (seq === priceSeq.current) setPriced(r as never);
    } catch (e) {
      if (seq === priceSeq.current) setPriceError(e instanceof Error ? e.message : "Could not price the order");
    } finally {
      if (seq === priceSeq.current) setPricing(false);
    }
  }, [customer, salesType, lines, charges]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(price, 300);
    return () => clearTimeout(t);
  }, [open, price]);

  const searchProducts = async (q: string, line: number) => {
    const seq = ++searchSeq.current;
    if (q.trim().length < 1) { setProductHits({ line, items: [] }); return; }
    try {
      const r = await apiClient.listProductRates({ search: q, active: "true", limit: 8 });
      if (seq === searchSeq.current) setProductHits({ line, items: r.products || [] });
    } catch { /* typing again retries */ }
  };
  const setLine = (key: number, patch: Partial<OrderLineForm>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const fetchQuotation = async () => {
    try {
      const found = await apiClient.get<{ quotations: { _id: string; quotationNumber: string }[] }>("/quotations", { search: quotationNo.trim(), limit: 1 });
      const q = found.quotations?.[0];
      if (!q) { toast({ title: "Quotation not found", variant: "destructive" }); return; }
      const d = await apiClient.salesOrderFromQuotation(q._id);
      if (d.existingOrder) { toast({ title: `Already has order ${d.existingOrder}`, description: "Cancel that order first to create another from this quotation.", variant: "destructive" }); return; }
      setQuotationId(q._id);
      if (d.customer) pickCustomer({ _id: String(d.customerId), name: d.customer.name, phone: d.customer.phone, address: d.customer.address, gstNumber: d.customer.gstNumber });
      setLines((d.lines as QuotationLine[]).map((l) => ({
        ...blankLine(), copies: String(l.copies || ""), length: l.length ? String(l.length) : "", width: l.width ? String(l.width) : "", basicDetails: l.basicDetails || "",
        product: l.productId ? { _id: String(l.productId), productName: l.itemName, materialType: l.materialType || "", unit: l.unit || "pieces", gstRate: 0, isActive: true } : null,
        workType: l.productId ? "" : `Quoted item: ${l.itemName}`,
      })));
      const unmatched = (d.lines as QuotationLine[]).filter((l) => !l.productId).length;
      toast({ title: `Details fetched from ${q.quotationNumber}`, description: unmatched ? `${unmatched} line(s) match no product: choose the product for each.` : undefined });
    } catch (e) {
      toast({ title: "Could not read the quotation", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const problems = (): string | null => {
    if (!customer) return "Choose a customer.";
    const real = lines.filter((l) => l.product);
    if (!real.length) return "Add at least one product.";
    for (const [i, l] of lines.entries()) {
      if (!l.product) continue;
      if (!(Number(l.copies) > 0)) return `Line ${i + 1}: enter the number of copies.`;
      if (isAreaUnit(l.product.unit) && !(Number(l.length) > 0 && Number(l.width) > 0)) return `Line ${i + 1}: enter length and width.`;
      if (l.overrideRate !== "" && !l.overrideReason.trim()) return `Line ${i + 1}: give a reason for changing the rate.`;
    }
    if (priced?.lines.some((l) => !l.priced)) return "A line has no rate for this customer. Fix it or configure a rate before saving.";
    return null;
  };

  const save = async () => {
    const p = problems();
    if (p) { setFormError(p); return; }
    setSaving(true);
    setFormError(null);
    try {
      const body = { ...orderPayload({ customerId: customer!._id, salesType, lines, charges }), orderDate, dueDate: dueDate || undefined, projectName, copyOption, mobile, address, notes, quotationId, clientRequestId: order ? undefined : requestId.current };
      await apiClient.saveSalesOrder(order?._id || null, body);
      toast({ title: order ? "Order updated" : "Order created", description: "It is waiting for approval." });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      const err = e as { message?: string };
      setFormError(err.message || "Could not save the order. What you entered is kept; try again.");
    } finally {
      setSaving(false);
    }
  };

  const totals = priced?.totals;
  return (
    <EditorSheet
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={order ? `Edit order ${order.orderNumber}` : "New sales order"}
      description="Prices come from the Product Rate master and are worked out by the server."
      onSubmit={(e) => { e.preventDefault(); save(); }}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={saving || pricing}>{saving && <Loader2 className="animate-spin" />}{order ? "Save changes" : "Create order"}</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <div className="relative col-span-2 space-y-1 md:col-span-1">
            <Label htmlFor="so-customer">Customer *</Label>
            <Input id="so-customer" autoComplete="off" placeholder="Search name or mobile" value={customerQuery} onChange={(e) => { setCustomerQuery(e.target.value); if (customer) setCustomer(null); }} />
            {customerHits.length > 0 && (
              <ul role="listbox" className="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
                {customerHits.map((c) => <li key={c._id}><button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => pickCustomer(c)}>{c.name}{c.phone ? ` · ${c.phone}` : ""}{c.customerType ? ` · ${c.customerType}` : ""}</button></li>)}
              </ul>
            )}
            {customer && priced?.partyType && <p className="text-xs text-muted-foreground">Party type: {priced.partyType}{priced.customerState ? ` · ${priced.customerState}` : ""}</p>}
          </div>
          <div className="space-y-1"><Label htmlFor="so-date">Order date</Label><Input id="so-date" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="so-due">Delivery date</Label><Input id="so-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="so-project">Project name</Label><Input id="so-project" value={projectName} onChange={(e) => setProjectName(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>Sales type</Label>
            <Select value={salesType} onValueChange={setSalesType}><SelectTrigger aria-label="Sales type"><SelectValue /></SelectTrigger><SelectContent>{SALES_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="space-y-1"><Label htmlFor="so-mobile">Mobile</Label><Input id="so-mobile" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="so-address">Address</Label><Input id="so-address" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>Copy</Label>
            <Select value={copyOption} onValueChange={setCopyOption}><SelectTrigger aria-label="Copy option"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="copy">Copy (default)</SelectItem><SelectItem value="no_copy">No copy</SelectItem></SelectContent></Select>
          </div>
          {!order && (
            <div className="col-span-2 flex items-end gap-2 md:col-span-2">
              <div className="flex-1 space-y-1"><Label htmlFor="so-quote">Fetch from quotation</Label><Input id="so-quote" placeholder="Quotation number" value={quotationNo} onChange={(e) => setQuotationNo(e.target.value)} /></div>
              <Button type="button" variant="outline" onClick={fetchQuotation} disabled={!quotationNo.trim()}>Fetch</Button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Products</h3>
          {lines.map((l, i) => {
            const pl = priced?.lines?.[lines.filter((x) => x.product).findIndex((x) => x.key === l.key)];
            const area = isAreaUnit(l.product?.unit);
            return (
              <div key={l.key} className="space-y-2 rounded-lg border p-3">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                  <div className="relative col-span-2 space-y-1 md:col-span-3">
                    <Label htmlFor={`so-p-${l.key}`}>Product {i + 1}</Label>
                    <Input id={`so-p-${l.key}`} autoComplete="off" placeholder="Search product name or code" value={l.product ? l.product.productName : l.query}
                      onChange={(e) => { setLine(l.key, { product: null, query: e.target.value }); searchProducts(e.target.value, i); }} />
                    {l.product && <p className="text-xs text-muted-foreground">{l.product.materialType} · {l.product.unit} · GST {l.product.taxExempt ? "exempt" : `${l.product.gstRate}%`}</p>}
                    {productHits.line === i && productHits.items.length > 0 && !l.product && (
                      <ul role="listbox" className="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
                        {productHits.items.map((p) => <li key={p._id}><button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => { setLine(l.key, { product: p }); setProductHits({ line: -1, items: [] }); }}>{p.productName} <span className="text-muted-foreground">· {p.materialType}{p.productCode ? ` · ${p.productCode}` : ""}</span></button></li>)}
                      </ul>
                    )}
                  </div>
                  <div className="space-y-1"><Label htmlFor={`so-c-${l.key}`}>Copies</Label><Input id={`so-c-${l.key}`} type="number" min="0" step="any" inputMode="decimal" value={l.copies} onChange={(e) => setLine(l.key, { copies: e.target.value })} /></div>
                  {area && <div className="space-y-1"><Label htmlFor={`so-l-${l.key}`}>Length</Label><Input id={`so-l-${l.key}`} type="number" min="0" step="any" value={l.length} onChange={(e) => setLine(l.key, { length: e.target.value })} /></div>}
                  {area && <div className="space-y-1"><Label htmlFor={`so-w-${l.key}`}>Width</Label><Input id={`so-w-${l.key}`} type="number" min="0" step="any" value={l.width} onChange={(e) => setLine(l.key, { width: e.target.value })} /></div>}
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                  {canDiscount && (
                    <div className="space-y-1"><Label htmlFor={`so-d-${l.key}`}>Discount {l.discountType === "percent" ? "%" : "₹"}</Label>
                      <div className="flex gap-1"><Input id={`so-d-${l.key}`} type="number" min="0" step="any" value={l.discountValue} onChange={(e) => setLine(l.key, { discountValue: e.target.value })} />
                        <Button type="button" variant="outline" size="sm" aria-label="Toggle percent or amount" onClick={() => setLine(l.key, { discountType: l.discountType === "percent" ? "amount" : "percent" })}>{l.discountType === "percent" ? "%" : "₹"}</Button></div></div>
                  )}
                  {canOverride && <div className="space-y-1"><Label htmlFor={`so-o-${l.key}`}>Override rate</Label><Input id={`so-o-${l.key}`} type="number" min="0" step="any" value={l.overrideRate} onChange={(e) => setLine(l.key, { overrideRate: e.target.value })} /></div>}
                  {canOverride && l.overrideRate !== "" && <div className="col-span-2 space-y-1"><Label htmlFor={`so-or-${l.key}`}>Reason for override *</Label><Input id={`so-or-${l.key}`} value={l.overrideReason} onChange={(e) => setLine(l.key, { overrideReason: e.target.value })} /></div>}
                  <div className="space-y-1"><Label htmlFor={`so-wa-${l.key}`}>Wastage</Label><Input id={`so-wa-${l.key}`} type="number" min="0" step="any" value={l.wastage} onChange={(e) => setLine(l.key, { wastage: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor={`so-wt-${l.key}`}>Work type</Label><Input id={`so-wt-${l.key}`} value={l.workType} onChange={(e) => setLine(l.key, { workType: e.target.value })} /></div>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="space-y-1"><Label htmlFor={`so-b-${l.key}`}>Basic details</Label><Input id={`so-b-${l.key}`} value={l.basicDetails} onChange={(e) => setLine(l.key, { basicDetails: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor={`so-a-${l.key}`}>Additional details</Label><Input id={`so-a-${l.key}`} value={l.additionalDetails} onChange={(e) => setLine(l.key, { additionalDetails: e.target.value })} /></div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-4 text-sm" role="group" aria-label="Production stages">
                    {(["design", "printing", "finishing"] as const).map((s) => (
                      <label key={s} className="flex items-center gap-1.5 capitalize"><input type="checkbox" className="h-4 w-4" checked={l.stages[s]} onChange={(e) => setLine(l.key, { stages: { ...l.stages, [s]: e.target.checked } })} />{s}</label>
                    ))}
                  </div>
                  <div className="text-right text-sm">
                    {pl ? (pl.priced ? <span><span className="text-muted-foreground">₹{pl.rate} × {pl.billableBasis}{pl.discount ? ` − ₹${pl.discount}` : ""} + GST ₹{pl.gst} = </span><b>{formatINR(pl.total)}</b></span> : <span className="text-destructive-strong">{pl.warnings[0]?.message}</span>) : null}
                    {pl?.adjustments?.map((a, k) => <div key={k} className="text-xs text-amber-700">{a.message}</div>)}
                  </div>
                  {lines.length > 1 && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove product ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button>}
                </div>
              </div>
            );
          })}
          <Button type="button" variant="subtle" size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus />Add product</Button>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Other charges</h3>
          {charges.map((c) => (
            <div key={c.key} className="grid grid-cols-2 items-end gap-2 md:grid-cols-5">
              <div className="space-y-1 md:col-span-2"><Label htmlFor={`so-cn-${c.key}`}>Charge</Label><Input id={`so-cn-${c.key}`} value={c.name} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, name: e.target.value } : x)))} /></div>
              <div className="space-y-1"><Label htmlFor={`so-ca-${c.key}`}>Amount ₹</Label><Input id={`so-ca-${c.key}`} type="number" min="0" step="any" value={c.amount} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, amount: e.target.value } : x)))} /></div>
              <div className="space-y-1"><Label htmlFor={`so-cg-${c.key}`}>GST %</Label><Input id={`so-cg-${c.key}`} type="number" min="0" max="100" step="any" value={c.taxable ? c.gstRate : 0} disabled={!c.taxable} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, gstRate: e.target.value } : x)))} /></div>
              <div className="flex items-center gap-2 pb-2"><label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="h-4 w-4" checked={!c.taxable} onChange={(e) => setCharges((cs) => cs.map((x) => (x.key === c.key ? { ...x, taxable: !e.target.checked } : x)))} />Non-taxable</label>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove charge" onClick={() => setCharges((cs) => cs.filter((x) => x.key !== c.key))}><Trash2 /></Button></div>
            </div>
          ))}
          <Button type="button" variant="subtle" size="sm" onClick={() => setCharges((cs) => [...cs, blankCharge()])}><Plus />Add charge</Button>
        </div>

        <div className="space-y-1"><Label htmlFor="so-notes">Notes / production instructions</Label><Textarea id="so-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

        <div className="rounded-lg border bg-muted/30 p-3 text-sm" aria-live="polite">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Summary {pricing && <Loader2 className="ml-1 inline h-3.5 w-3.5 animate-spin" aria-label="Calculating" />}</h3>
            {priceError && <Button type="button" size="sm" variant="outline" onClick={price}><RefreshCw />Retry</Button>}
          </div>
          {priceError && <p role="alert" className="mb-2 text-destructive-strong">{priceError} Your entries are kept.</p>}
          {totals ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
              {([
                ["Taxable amount", totals.taxableAmount], ["CGST", totals.cgst], ["SGST", totals.sgst], ["IGST", totals.igst], ["Cess", totals.cess],
                ["Non-taxable", totals.nonTaxableAmount], ["Discount", totals.discount], ["Round-off", totals.roundOff],
              ] as [string, number][]).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{k}</dt><dd>{formatINR(v)}</dd></div>)}
              <div className="col-span-2 flex justify-between border-t pt-1 font-semibold md:col-span-4"><dt>Total / amount due</dt><dd>{formatINR(totals.total)}</dd></div>
            </dl>
          ) : <p className="text-muted-foreground">Choose a customer and a product with copies to see the price.</p>}
        </div>
        {formError && <p role="alert" className="text-sm text-destructive-strong">{formError}</p>}
      </div>
    </EditorSheet>
  );
}
