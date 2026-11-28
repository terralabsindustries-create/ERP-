import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ErrorState } from "@/components/common/LoadState";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { cn } from "@/lib/utils";
import {
  PARTY_TYPES, SALES_TYPES, UNITS, exclusiveFromInclusive, inclusiveFromExclusive,
  type ProductRateFull, type ProductRateSummary, type RateRule, type Slab,
} from "@/lib/salesOrders";

const blankProduct = (): ProductRateFull => ({ _id: "", materialType: "", productName: "", productCode: "", unit: "pieces", gstRate: 18, taxExempt: false, cessRate: 0, isActive: true, hsnCode: "", rules: [{ slabs: [{ from: 1, to: null, exclusiveRate: "", inclusiveRate: "" }] }] });
const blankSlab = (prevTo?: number | string | null): Slab => ({ from: prevTo !== null && prevTo !== undefined && prevTo !== "" ? Number(prevTo) + 1 : 1, to: null, exclusiveRate: "", inclusiveRate: "" });

/** Product Rate Master: pick a product on the left, see and edit its rate rules on the right. */
export default function ProductRates() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Product Rates: Create & Edit");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);
  const [material, setMaterial] = useState("all");
  const [materials, setMaterials] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ProductRateSummary[]>([]);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<ProductRateFull | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [customerHits, setCustomerHits] = useState<{ _id: string; name: string; phone?: string }[]>([]);
  const [customerFor, setCustomerFor] = useState<number | null>(null);
  const customerSearchSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.listProductRates({ search: debounced || undefined, materialType: material, page, limit: 15 });
      setList(r.products || []);
      setPages(r.pagination?.pages || 1);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [debounced, material, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [debounced, material]);
  useEffect(() => { apiClient.productRateMaterialTypes().then((r) => setMaterials(r.materialTypes || [])).catch(() => undefined); }, [list.length]);

  const open = async (id: string) => {
    setSelected(id);
    setErrors([]);
    setFormLoading(true);
    try {
      const r = await apiClient.getProductRate(id);
      const p = r.product;
      setForm({ ...p, rules: (p.rules || []).map((rule: RateRule) => ({ ...rule, customerName: (rule as RateRule & { customerName?: string }).customerName })) });
    } catch (e) {
      toast({ title: "Could not open the product", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setFormLoading(false);
    }
  };

  const update = (patch: Partial<ProductRateFull>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const updateRule = (i: number, patch: Partial<RateRule>) => setForm((f) => f && { ...f, rules: f.rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const updateSlab = (ri: number, si: number, patch: Partial<Slab>) =>
    setForm((f) => f && { ...f, rules: f.rules.map((r, k) => (k === ri ? { ...r, slabs: r.slabs.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : r)) });

  // Entering one side of a slab fills the other from the product's GST (the server re-checks both).
  const gst = form?.taxExempt ? 0 : Number(form?.gstRate) || 0;
  const setExclusive = (ri: number, si: number, v: string) => updateSlab(ri, si, { exclusiveRate: v, inclusiveRate: v === "" ? "" : inclusiveFromExclusive(Number(v), gst), rateBasis: "exclusive" });
  const setInclusive = (ri: number, si: number, v: string) => updateSlab(ri, si, { inclusiveRate: v, exclusiveRate: v === "" ? "" : exclusiveFromInclusive(Number(v), gst), rateBasis: "inclusive" });

  const searchCustomers = async (q: string, ruleIndex: number) => {
    setCustomerFor(ruleIndex);
    const seq = ++customerSearchSeq.current;
    if (q.trim().length < 2) { setCustomerHits([]); return; }
    try {
      const r = await apiClient.get<{ customers: { _id: string; name: string; phone?: string }[] }>("/customers", { search: q, limit: 8 });
      if (seq === customerSearchSeq.current) setCustomerHits(r.customers || []);
    } catch { /* the field stays usable */ }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setErrors([]);
    try {
      const payload = {
        ...form,
        rules: form.rules.map((r) => ({
          customerId: r.customerId || undefined, partyType: r.partyType || undefined, salesType: r.salesType || undefined,
          minimumQuantity: r.minimumQuantity === "" ? undefined : r.minimumQuantity, minimumAmount: r.minimumAmount === "" ? undefined : r.minimumAmount,
          slabs: r.slabs.map((s) => ({ from: s.from, to: s.to === "" ? null : s.to, exclusiveRate: s.rateBasis === "inclusive" ? undefined : s.exclusiveRate, inclusiveRate: s.rateBasis === "inclusive" ? s.inclusiveRate : undefined, rateBasis: s.rateBasis, isMinimum: !!s.isMinimum, unit: form.unit })),
        })),
      };
      const r = (await apiClient.saveProductRate(form._id || null, payload)) as { data?: { product: ProductRateFull } } & { product?: ProductRateFull };
      const saved = r.product || r.data?.product;
      toast({ title: "Product rates saved" });
      await load();
      if (saved) open(saved._id);
    } catch (e) {
      const err = e as { message?: string; errors?: unknown };
      setErrors(Array.isArray(err.errors) && err.errors.every((x) => typeof x === "string") ? (err.errors as string[]) : [err.message || "Could not save"]);
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async () => {
    if (!form?._id) return;
    try {
      await apiClient.deactivateProductRate(form._id);
      toast({ title: `${form.productName} deactivated`, description: "Existing orders keep their prices." });
      setForm(null);
      setSelected(null);
      load();
    } catch (e) {
      toast({ title: "Not deactivated", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Sales & estimating"
        title="Product rates"
        description="Rates for each material product by sales type, party type or a specific customer, with quantity or area slabs. The most specific rule wins: customer, then party type, then sales type, then the default."
        actions={canEdit && <Button onClick={() => { setForm(blankProduct()); setSelected(null); setErrors([]); }}><Plus />New product</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <section aria-label="Products" className="rounded-xl border bg-card p-3 shadow-card">
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input aria-label="Search products" className="pl-8" placeholder="Product name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={material} onValueChange={setMaterial}>
              <SelectTrigger aria-label="Material type"><SelectValue placeholder="Material type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All material types</SelectItem>
                {materials.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 max-h-[60vh] space-y-1 overflow-y-auto">
            {loadError ? <ErrorState error={loadError} onRetry={load} /> : loading ? (
              <div className="flex justify-center p-6"><Loader2 className="animate-spin text-muted-foreground" /></div>
            ) : list.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No products match.</p>
            ) : list.map((p) => (
              <button
                key={p._id}
                type="button"
                onClick={() => open(p._id)}
                aria-pressed={selected === p._id}
                className={cn("w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted", selected === p._id ? "border-primary bg-primary-soft/40" : "border-transparent", !p.isActive && "opacity-60")}
              >
                <div className="font-medium">{p.productName}</div>
                <div className="text-xs text-muted-foreground">{p.materialType}{p.productCode ? ` · ${p.productCode}` : ""} · {p.unit}{!p.isActive ? " · inactive" : ""}</div>
              </button>
            ))}
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span>Page {page} of {pages}</span>
              <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </section>

        <section aria-label="Rates" className="rounded-xl border bg-card p-4 shadow-card">
          {formLoading ? <div className="flex justify-center p-10"><Loader2 className="animate-spin" /></div> : !form ? (
            <p className="p-6 text-sm text-muted-foreground">Choose a product to see its rates{canEdit ? ", or add a new one" : ""}.</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (canEdit) save(); }} className="space-y-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="space-y-1"><Label htmlFor="pr-material">Material type *</Label><Input id="pr-material" value={form.materialType} onChange={(e) => update({ materialType: e.target.value })} disabled={!canEdit} /></div>
                <div className="space-y-1 md:col-span-2"><Label htmlFor="pr-name">Product name *</Label><Input id="pr-name" value={form.productName} onChange={(e) => update({ productName: e.target.value })} disabled={!canEdit} /></div>
                <div className="space-y-1"><Label htmlFor="pr-code">Product code</Label><Input id="pr-code" value={form.productCode || ""} onChange={(e) => update({ productCode: e.target.value })} disabled={!canEdit} /></div>
                <div className="space-y-1">
                  <Label>Unit</Label>
                  <Select value={form.unit} onValueChange={(v) => update({ unit: v })} disabled={!canEdit}>
                    <SelectTrigger aria-label="Unit"><SelectValue /></SelectTrigger>
                    <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1"><Label htmlFor="pr-gst">GST %</Label><Input id="pr-gst" type="number" min="0" max="100" step="any" value={form.taxExempt ? 0 : form.gstRate} onChange={(e) => update({ gstRate: Number(e.target.value) })} disabled={!canEdit || form.taxExempt} /></div>
                <div className="space-y-1"><Label htmlFor="pr-cess">Cess %</Label><Input id="pr-cess" type="number" min="0" step="any" value={form.cessRate || 0} onChange={(e) => update({ cessRate: Number(e.target.value) })} disabled={!canEdit || form.taxExempt} /></div>
                <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={!!form.taxExempt} onChange={(e) => update({ taxExempt: e.target.checked })} disabled={!canEdit} />Tax-exempt</label>
              </div>

              {form.rules.map((rule, ri) => (
                <fieldset key={ri} className="space-y-3 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">Rate rule {ri + 1}{!rule.customerId && !rule.partyType && !rule.salesType ? " — default" : ""}</legend>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="relative space-y-1">
                      <Label htmlFor={`pr-c-${ri}`}>Specific customer</Label>
                      <Input id={`pr-c-${ri}`} placeholder="Type 2+ letters" defaultValue={rule.customerName || ""} disabled={!canEdit} onChange={(e) => { updateRule(ri, { customerId: undefined, customerName: e.target.value }); searchCustomers(e.target.value, ri); }} />
                      {rule.customerId && <p className="text-xs text-primary">Customer rate</p>}
                      {customerFor === ri && customerHits.length > 0 && (
                        <ul className="absolute z-20 mt-1 max-h-40 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
                          {customerHits.map((c) => (
                            <li key={c._id}><button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => { updateRule(ri, { customerId: c._id, customerName: c.name }); setCustomerHits([]); setCustomerFor(null); }}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</button></li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label>Party type</Label>
                      <Select value={rule.partyType || "any"} onValueChange={(v) => updateRule(ri, { partyType: v === "any" ? undefined : v })} disabled={!canEdit}>
                        <SelectTrigger aria-label="Party type"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="any">Any</SelectItem>{PARTY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pr-s-${ri}`}>Sales type</Label>
                      <Input id={`pr-s-${ri}`} list="sales-types" placeholder="Any" value={rule.salesType || ""} onChange={(e) => updateRule(ri, { salesType: e.target.value || undefined })} disabled={!canEdit} />
                    </div>
                    <div className="flex items-end justify-end">{canEdit && form.rules.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setForm((f) => f && { ...f, rules: f.rules.filter((_, k) => k !== ri) })}><Trash2 />Remove rule</Button>}</div>
                    <div className="space-y-1"><Label htmlFor={`pr-mq-${ri}`}>Minimum billable quantity / area</Label><Input id={`pr-mq-${ri}`} type="number" min="0" step="any" value={rule.minimumQuantity ?? ""} onChange={(e) => updateRule(ri, { minimumQuantity: e.target.value })} disabled={!canEdit} /></div>
                    <div className="space-y-1"><Label htmlFor={`pr-ma-${ri}`}>Minimum amount (excl. GST)</Label><Input id={`pr-ma-${ri}`} type="number" min="0" step="any" value={rule.minimumAmount ?? ""} onChange={(e) => updateRule(ri, { minimumAmount: e.target.value })} disabled={!canEdit} /></div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-1">From</th><th className="p-1">To (blank = no limit)</th><th className="p-1">Exclusive ₹</th><th className="p-1">Inclusive ₹</th><th className="p-1" title="Stored as in the reference software; it does not change any price until the business confirms its meaning">Minimum</th><th /></tr></thead>
                      <tbody>
                        {rule.slabs.map((s, si) => (
                          <tr key={si}>
                            <td className="p-1"><Input aria-label={`Slab ${si + 1} from`} type="number" min="0" step="any" value={s.from} onChange={(e) => updateSlab(ri, si, { from: e.target.value })} disabled={!canEdit} /></td>
                            <td className="p-1"><Input aria-label={`Slab ${si + 1} to`} type="number" min="0" step="any" placeholder="∞" value={s.to ?? ""} onChange={(e) => updateSlab(ri, si, { to: e.target.value === "" ? null : e.target.value })} disabled={!canEdit} /></td>
                            <td className="p-1"><Input aria-label={`Slab ${si + 1} exclusive rate`} type="number" min="0" step="any" value={s.exclusiveRate} onChange={(e) => setExclusive(ri, si, e.target.value)} disabled={!canEdit} /></td>
                            <td className="p-1"><Input aria-label={`Slab ${si + 1} inclusive rate`} type="number" min="0" step="any" value={s.inclusiveRate} onChange={(e) => setInclusive(ri, si, e.target.value)} disabled={!canEdit} /></td>
                            <td className="p-1 text-center"><input aria-label={`Slab ${si + 1} minimum`} type="checkbox" className="h-4 w-4" checked={!!s.isMinimum} onChange={(e) => updateSlab(ri, si, { isMinimum: e.target.checked })} disabled={!canEdit} /></td>
                            <td className="p-1">{canEdit && rule.slabs.length > 1 && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete slab ${si + 1}`} onClick={() => updateRule(ri, { slabs: rule.slabs.filter((_, k) => k !== si) })}><Trash2 /></Button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {canEdit && <Button type="button" variant="subtle" size="sm" onClick={() => updateRule(ri, { slabs: [...rule.slabs.map((s, k, a) => (k === a.length - 1 && s.to === null ? s : s)), blankSlab(rule.slabs[rule.slabs.length - 1]?.to)] })}><Plus />Add slab</Button>}
                </fieldset>
              ))}
              <datalist id="sales-types">{SALES_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
              {canEdit && <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => f && { ...f, rules: [...f.rules, { slabs: [blankSlab()] }] })}><Plus />Add rate rule</Button>}

              {errors.length > 0 && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-sm text-destructive-strong">
                  <ul className="list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
              )}
              {canEdit && (
                <div className="flex justify-between gap-2">
                  <div>{form._id && hasPermission("Product Rates: Delete") && form.isActive && <Button type="button" variant="outline" onClick={deactivate}>Deactivate</Button>}</div>
                  <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />}Save rates</Button>
                </div>
              )}
            </form>
          )}
        </section>
      </div>
    </PageShell>
  );
}
