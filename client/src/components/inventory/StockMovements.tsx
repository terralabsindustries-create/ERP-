import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ClipboardCheck, Loader2, PackageX, RotateCcw, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/common/EmptyState";
import { FilterSelect, Pagination, Stack } from "@/components/data";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface StockItem {
  _id: string;
  name: string;
  quantity?: number;
  unit?: string;
}

type Mode = "in" | "out" | "damage" | "return" | "count";

const MODES: { value: Mode; label: string; hint: string; icon: typeof ArrowDownLeft }[] = [
  { value: "in", label: "Stock in", hint: "Received from a supplier", icon: ArrowDownLeft },
  { value: "out", label: "Stock out", hint: "Used for a job", icon: ArrowUpRight },
  { value: "damage", label: "Damaged", hint: "Spoiled or wasted", icon: PackageX },
  { value: "return", label: "Returned", hint: "Back from a job or customer", icon: RotateCcw },
  { value: "count", label: "Stock count", hint: "Set what's on the shelf", icon: ClipboardCheck }
];

/** Records one change to an item's stock: in, out, damaged, returned or a count. */
export function StockAdjustDialog({ item, initialMode = "in", onOpenChange, onDone }: { item: StockItem | null; initialMode?: Mode; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [qty, setQty] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    setMode(initialMode);
    setQty("");
    setReference("");
    setNotes("");
  }, [item, initialMode]);

  const now = item?.quantity || 0;
  const n = Number(qty);
  const valid = qty !== "" && Number.isFinite(n) && (mode === "count" ? n >= 0 : n > 0);
  const after = !valid ? null : mode === "count" ? n : mode === "in" || mode === "return" ? now + n : now - n;
  const unit = item?.unit || "units";

  const save = async () => {
    if (!item || !valid || after === null) return;
    if (after < 0) {
      toast({ title: `Only ${now.toLocaleString("en-IN")} ${unit} in stock`, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (mode === "count") {
        await apiClient.adjustInventory(item._id, n, "Stock count", notes || undefined);
      } else {
        await apiClient.moveStock(item._id, {
          change: mode === "in" || mode === "return" ? n : -n,
          type: mode === "in" ? "purchase" : mode === "damage" ? "damage" : mode === "return" ? "return" : "adjustment",
          reason: MODES.find((m) => m.value === mode)?.hint,
          reference: reference || undefined,
          notes: notes || undefined
        });
      }
      toast({ title: "Stock updated", description: `${item.name}: ${now.toLocaleString("en-IN")} → ${after.toLocaleString("en-IN")} ${unit}` });
      onOpenChange(false);
      onDone();
    } catch (error) {
      toast({ title: "Stock not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!item} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update stock</DialogTitle>
          <DialogDescription>{item?.name}</DialogDescription>
        </DialogHeader>
        {item && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Kind of change">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                    mode === m.value ? "border-primary bg-primary-soft/40" : "hover:bg-muted"
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    <m.icon className="h-3.5 w-3.5" />
                    {m.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{m.hint}</span>
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stock-qty">{mode === "count" ? `Counted quantity (${unit})` : `Quantity (${unit})`}</Label>
              <Input id="stock-qty" type="number" inputMode="decimal" min="0" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span className="text-muted-foreground">In stock</span>
              <span className="num font-medium">
                {now.toLocaleString("en-IN")}
                {after !== null && (
                  <>
                    {" "}
                    → <span className={cn(after < 0 && "text-destructive-strong")}>{after.toLocaleString("en-IN")}</span>
                  </>
                )}{" "}
                {unit}
              </span>
            </div>
            {mode !== "count" && (
              <div className="space-y-1.5">
                <Label htmlFor="stock-ref">Reference</Label>
                <Input id="stock-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={mode === "in" ? "Supplier bill or challan no." : "Job or note"} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="stock-notes">Notes</Label>
              <Textarea id="stock-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !valid || (after !== null && after < 0)}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Movement {
  _id: string;
  itemName: string;
  inventoryItem?: { _id: string; name: string; unit?: string } | string | null;
  movementType: "sale" | "purchase" | "adjustment" | "return" | "damage" | "transfer";
  quantity: number;
  unit: string;
  previousQuantity: number;
  newQuantity: number;
  referenceType?: string;
  referenceNumber?: string;
  reason?: string;
  notes?: string;
  performedByName?: string;
  createdAt: string;
}

const TYPE_LABEL: Record<Movement["movementType"], string> = { sale: "Sold on invoice", purchase: "Stock in", adjustment: "Adjusted", return: "Returned", damage: "Damaged", transfer: "Transferred" };
const PAGE = 25;

/** Every change to stock — received, sold on invoices, used, damaged, counted — newest first. */
export function StockHistorySheet({ open, onOpenChange, items, itemId }: { open: boolean; onOpenChange: (o: boolean) => void; items: StockItem[]; itemId?: string }) {
  const { toast } = useToast();
  const [item, setItem] = useState("all");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setItem(itemId || "all");
      setType("all");
      setPage(1);
    }
  }, [open, itemId]);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const res = (await apiClient.getInventoryMovements({ item: item !== "all" ? item : undefined, type: type !== "all" ? type : undefined, page, limit: PAGE })) as {
        movements?: Movement[];
        pagination?: { total?: number };
      };
      setRows(res?.movements || []);
      setTotal(res?.pagination?.total || 0);
    } catch (error) {
      toast({ title: "Stock history could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [open, item, type, page, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [item, type]);

  const sign = (m: Movement) => m.newQuantity - m.previousQuantity;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>Stock history</SheetTitle>
          <SheetDescription>Stock received, sold on invoices, used, damaged and counted.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap gap-2 border-b px-5 py-3">
          <FilterSelect label="Item" value={item} onChange={setItem} allLabel="All items" options={items.map((i) => ({ value: i._id, label: i.name }))} />
          <FilterSelect label="Change" value={type} onChange={setType} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {loading && !rows.length ? (
            <div className="flex justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState compact icon={ShoppingBag} title="No stock changes yet" description="Stock you receive, use or count, and stock sold on invoices, shows here." />
          ) : (
            <ul className="divide-y">
              {rows.map((m) => {
                const d = sign(m);
                return (
                  <li key={m._id} className="flex items-start justify-between gap-3 py-3">
                    <Stack
                      top={<span className="font-medium">{m.itemName}</span>}
                      bottom={
                        <>
                          {TYPE_LABEL[m.movementType]}
                          {m.referenceNumber ? ` · ${m.referenceNumber}` : ""}
                          {m.performedByName ? ` · ${m.performedByName}` : ""} · <span title={fmtDate(m.createdAt)}>{fmtRelative(m.createdAt)}</span>
                        </>
                      }
                    />
                    <div className="shrink-0 text-right">
                      <div className={cn("num text-sm font-semibold", d > 0 ? "text-success-strong" : d < 0 ? "text-destructive-strong" : "text-muted-foreground")}>
                        {d > 0 ? "+" : d < 0 ? "−" : ""}
                        {Math.abs(d).toLocaleString("en-IN")} {m.unit}
                      </div>
                      <div className="num text-xs text-muted-foreground">
                        {m.previousQuantity.toLocaleString("en-IN")} → {m.newQuantity.toLocaleString("en-IN")}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {total > PAGE && (
          <div className="border-t bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground">
            <Pagination page={page} pageSize={PAGE} total={total} onPageChange={setPage} noun="changes" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
