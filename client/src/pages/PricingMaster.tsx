import { useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Power, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/LoadState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { EditorSheet, EditorSection } from "@/components/users/EditorSheet";
import { DataCard, DataTable, EntityCell, SearchField, StatusPill, Toolbar, type Column } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useLoader } from "@/hooks/useLoader";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";
import { lineAmounts, rangeLabel, slabFor, slabRanges, validateSlabs } from "@/lib/pricing";

type ItemType = "digital" | "flex" | "offset" | "general";
interface PriceItem {
  _id: string; type: ItemType; name: string; mediaName?: string; paperType?: string; gsm?: number; printSize?: string;
  sides?: "simplex" | "duplex" | null; hsnCode?: string; gstRate: number; taxInclusive: boolean; unit?: string;
  defaultRate?: number | null; slabs: { minQty: number; rate: number }[]; isActive: boolean;
}
interface Row { minQty: string; rate: string }
const TYPES: { value: ItemType; label: string }[] = [
  { value: "digital", label: "Digital" }, { value: "flex", label: "Flex" }, { value: "offset", label: "Offset" }, { value: "general", label: "General" },
];

/** Editable quantity/rate rows with live validation, sorted ranges, and a price preview. */
function SlabEditor({ rows, onChange, gstRate, taxInclusive }: { rows: Row[]; onChange: (r: Row[]) => void; gstRate: number; taxInclusive: boolean }) {
  const [previewQty, setPreviewQty] = useState("25");
  const { slabs, errors } = useMemo(() => validateSlabs(rows), [rows]);
  const ranges = useMemo(() => slabRanges(slabs), [slabs]);
  const qty = Number(previewQty);
  const hit = qty > 0 ? slabFor(slabs, qty) : null;
  const amounts = hit ? lineAmounts(qty, hit.rate, gstRate, taxInclusive) : null;
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <div><Label className="text-xs">Minimum quantity</Label><Input inputMode="decimal" aria-label={`Minimum quantity ${i + 1}`} value={r.minQty} onChange={(e) => set(i, { minQty: e.target.value })} /></div>
            <div><Label className="text-xs">Unit rate (₹)</Label><Input inputMode="decimal" aria-label={`Unit rate ${i + 1}`} value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} /></div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Delete slab ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { minQty: "", rate: "" }])}><Plus className="h-4 w-4" /> Add new quantity</Button>
      </div>
      {errors.length > 0 && <ul role="alert" className="space-y-0.5 text-xs text-destructive">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {ranges.length > 0 && (
        <div className="rounded-md border text-sm">
          {ranges.map((r) => <div key={r.minQty} className="flex justify-between border-b px-3 py-1.5 last:border-0"><span>{rangeLabel(r)} units</span><span className="font-medium">{formatINR(r.rate)} each</span></div>)}
        </div>
      )}
      <div className="rounded-md bg-muted/50 p-3 text-sm">
        <Label className="text-xs">Price preview: quantity</Label>
        <Input className="mt-1 w-32" inputMode="decimal" aria-label="Price preview quantity" value={previewQty} onChange={(e) => setPreviewQty(e.target.value)} />
        <p className="mt-2" aria-live="polite">
          {hit && amounts ? <>{qty} × {formatINR(hit.rate)} = <b>{formatINR(amounts.total)}</b> {taxInclusive ? "incl." : "+"} GST {gstRate}% ({formatINR(amounts.gst)}; taxable {formatINR(amounts.taxable)})</> : "No rate applies to this quantity."}
        </p>
      </div>
    </div>
  );
}

function CustomerRates({ item }: { item: PriceItem }) {
  const { toast } = useToast();
  const [customerId, setCustomerId] = useState("");
  const [fixed, setFixed] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const customers = useLoader<any>((s) => apiClient.getWithSignal("/customers", { status: "all", limit: 100 }, s), []);
  const rates = useLoader<any>((s) => apiClient.getWithSignal(`/price-items/${item._id}/customer-rates`, undefined, s), [item._id]);
  const list = rates.data?.rates || [];
  const load = (r: any) => { setCustomerId(r.customerId?._id || ""); setFixed(r.fixedRate ?? ""); setRows((r.slabs || []).map((s: any) => ({ minQty: String(s.minQty), rate: String(s.rate) }))); };
  const save = async () => {
    const { slabs, errors } = validateSlabs(rows);
    if (errors.length) return toast({ title: errors[0], variant: "destructive" });
    setSaving(true);
    try {
      await apiClient.put(`/price-items/${item._id}/customer-rates/${customerId}`, { fixedRate: fixed === "" ? null : Number(fixed), slabs, reason });
      toast({ title: "Customer rate saved" }); setReason(""); rates.reload();
    } catch (e) { toast({ title: "Not saved", description: e instanceof Error ? e.message : undefined, variant: "destructive" }); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-3">
      {rates.error ? <ErrorState error={rates.error} what="customer rates" onRetry={rates.reload} compact /> : list.length > 0 && (
        <div className="rounded-md border text-sm">
          {list.map((r: any) => (
            <button type="button" key={r._id} className="flex w-full items-center justify-between border-b px-3 py-1.5 text-left last:border-0 hover:bg-muted/50" onClick={() => load(r)}>
              <span className="flex items-center gap-2"><UserRound className="h-4 w-4" />{r.customerId?.name}</span>
              <span className="text-muted-foreground">{r.fixedRate != null ? `${formatINR(r.fixedRate)} fixed` : ""}{r.slabs?.length ? ` · ${r.slabs.length} qty rates` : ""}</span>
            </button>
          ))}
        </div>
      )}
      <Select value={customerId} onValueChange={setCustomerId}>
        <SelectTrigger aria-label="Customer"><SelectValue placeholder="Choose a customer" /></SelectTrigger>
        <SelectContent>{(customers.data?.customers || []).map((c: any) => <SelectItem key={c._id} value={c._id}>{c.name}</SelectItem>)}</SelectContent>
      </Select>
      {customerId && (
        <>
          <div><Label className="text-xs">Fixed rate (₹, optional)</Label><Input inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} /></div>
          <SlabEditor rows={rows} onChange={setRows} gstRate={item.gstRate} taxInclusive={item.taxInclusive} />
          <div><Label className="text-xs">Reason for the change</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <Button type="button" onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}Save customer rate</Button>
        </>
      )}
    </div>
  );
}

export default function PricingMaster() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Pricing Master: Create & Edit");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const q = useDebounced(search, 300);
  const list = useLoader<any>((s) => apiClient.getWithSignal("/price-items", { search: q || undefined, type: type === "all" ? undefined : type, limit: 100 }, s), [q, type]);
  const items: PriceItem[] = list.data?.items || [];
  const [editing, setEditing] = useState<Partial<PriceItem> | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"item" | "customers">("item");

  const open = (item?: PriceItem) => {
    setEditing(item ? { ...item } : { type: "digital", gstRate: 18, taxInclusive: false, isActive: true, sides: "simplex", slabs: [] });
    setRows((item?.slabs || []).map((s) => ({ minQty: String(s.minQty), rate: String(s.rate) }))); setTab("item");
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { slabs, errors } = validateSlabs(rows);
    if (errors.length) return toast({ title: errors[0], variant: "destructive" });
    setSaving(true);
    try {
      const body = { ...editing, slabs, defaultRate: editing.defaultRate === undefined || editing.defaultRate === null || (editing.defaultRate as any) === "" ? null : Number(editing.defaultRate) };
      delete (body as any)._id;
      if (editing._id) await apiClient.put(`/price-items/${editing._id}`, body); else await apiClient.post("/price-items", body);
      toast({ title: "Item saved" }); setEditing(null); list.reload();
    } catch (err) { toast({ title: "Not saved", description: err instanceof Error ? err.message : undefined, variant: "destructive" }); } finally { setSaving(false); }
  };
  const toggle = async (item: PriceItem) => {
    try { await apiClient.put(`/price-items/${item._id}`, { isActive: !item.isActive }); list.reload(); }
    catch (err) { toast({ title: "Not changed", description: err instanceof Error ? err.message : undefined, variant: "destructive" }); }
  };
  const set = (patch: Partial<PriceItem>) => setEditing((p) => ({ ...p, ...patch }));

  const columns: Column<PriceItem>[] = [
    { id: "name", header: "Item", cell: (i) => <EntityCell title={i.name} subtitle={[i.mediaName, i.printSize, i.sides].filter(Boolean).join(" · ")} /> },
    { id: "type", header: "Type", cell: (i) => <span className="capitalize">{i.type}</span> },
    { id: "rates", header: "Rates", cell: (i) => (i.slabs.length ? `${formatINR(i.slabs[i.slabs.length - 1].rate)} – ${formatINR(i.slabs[0].rate)} · ${i.slabs.length} slabs` : i.defaultRate != null ? formatINR(i.defaultRate) : "—") },
    { id: "gst", header: "GST", cell: (i) => `${i.gstRate}% ${i.taxInclusive ? "incl." : "excl."}` },
    { id: "status", header: "Status", cell: (i) => <StatusPill tone={i.isActive ? "success" : "neutral"}>{i.isActive ? "Active" : "Inactive"}</StatusPill> },
    { id: "actions", header: "", cell: (i) => canEdit && (
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" aria-label={`Edit ${i.name}`} onClick={() => open(i)}><Pencil className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" aria-label={i.isActive ? `Deactivate ${i.name}` : `Activate ${i.name}`} onClick={() => toggle(i)}><Power className="h-4 w-4" /></Button>
      </div>
    ) },
  ];

  return (
    <PageShell>
      <PageHeader title="Pricing Master" description="Items with quantity-based rates, GST settings and customer-specific prices." actions={canEdit && <Button onClick={() => open()}><Plus className="h-4 w-4" /> New item</Button>} />
      <DataCard>
        <Toolbar>
          <SearchField value={search} onChange={setSearch} placeholder="Search item, media, size or HSN" />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-40" aria-label="Item type"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All types</SelectItem>{TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
          </Select>
        </Toolbar>
        {list.error && !list.data ? <ErrorState error={list.error} what="items" onRetry={list.reload} retrying={list.isRefreshing} />
          : list.isLoading ? <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin" /></div>
          : items.length === 0 ? <EmptyState title="No items yet" description={q || type !== "all" ? "No item matches these filters." : "Add your first item to start quantity-based pricing."} />
          : <DataTable columns={columns} rows={items} rowKey={(i) => i._id} />}
      </DataCard>

      <EditorSheet open={!!editing} onOpenChange={(o) => !o && setEditing(null)} wide onSubmit={save}
        title={editing?._id ? "Edit item" : "New item"} description="Rates apply to the whole line: the highest minimum quantity not above the order quantity wins."
        footer={<><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />}Save</Button></>}>
        {editing && (
          <>
            {editing._id && <div className="flex gap-2"><Button type="button" size="sm" variant={tab === "item" ? "default" : "outline"} onClick={() => setTab("item")}>Item</Button><Button type="button" size="sm" variant={tab === "customers" ? "default" : "outline"} onClick={() => setTab("customers")}>Customer rates</Button></div>}
            {tab === "customers" && editing._id ? <CustomerRates item={editing as PriceItem} /> : (
              <>
                <EditorSection title="Item">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2"><Label>Item name</Label><Input required aria-label="Item name" value={editing.name || ""} onChange={(e) => set({ name: e.target.value })} /></div>
                    <div><Label>Type</Label>
                      <Select value={editing.type} onValueChange={(v) => set({ type: v as ItemType })}><SelectTrigger aria-label="Type"><SelectValue /></SelectTrigger><SelectContent>{TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent></Select></div>
                    <div><Label>Media name</Label><Input value={editing.mediaName || ""} onChange={(e) => set({ mediaName: e.target.value })} /></div>
                    <div><Label>Paper type</Label><Input value={editing.paperType || ""} onChange={(e) => set({ paperType: e.target.value })} /></div>
                    <div><Label>GSM</Label><Input inputMode="decimal" value={editing.gsm ?? ""} onChange={(e) => set({ gsm: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
                    <div><Label>Printing size</Label><Input value={editing.printSize || ""} onChange={(e) => set({ printSize: e.target.value })} /></div>
                    <div><Label>Printing</Label>
                      <Select value={editing.sides || "none"} onValueChange={(v) => set({ sides: v === "none" ? null : (v as "simplex" | "duplex") })}><SelectTrigger aria-label="Sides"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Not applicable</SelectItem><SelectItem value="simplex">Simplex</SelectItem><SelectItem value="duplex">Duplex</SelectItem></SelectContent></Select></div>
                  </div>
                </EditorSection>
                <EditorSection title="Tax">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><Label>HSN / SAC code</Label><Input value={editing.hsnCode || ""} onChange={(e) => set({ hsnCode: e.target.value })} /></div>
                    <div><Label>GST %</Label><Input inputMode="decimal" value={editing.gstRate ?? ""} onChange={(e) => set({ gstRate: Number(e.target.value) })} /></div>
                    <label className="flex items-center gap-2 text-sm"><Switch checked={!!editing.taxInclusive} onCheckedChange={(v) => set({ taxInclusive: v })} aria-label="Rates include GST" />Rates include GST</label>
                    <div><Label>Default rate (₹, optional)</Label><Input inputMode="decimal" value={editing.defaultRate ?? ""} onChange={(e) => set({ defaultRate: e.target.value === "" ? null : (e.target.value as any) })} /></div>
                  </div>
                </EditorSection>
                <EditorSection title="Quantity-based rates"><SlabEditor rows={rows} onChange={setRows} gstRate={editing.gstRate ?? 0} taxInclusive={!!editing.taxInclusive} /></EditorSection>
              </>
            )}
          </>
        )}
      </EditorSheet>
    </PageShell>
  );
}
