import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, Calculator, Download, History, MoreHorizontal, Package, PackagePlus, Pencil, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { CreateItemDialog } from "@/components/inventory/CreateItemDialog";
import { StockAdjustDialog, StockHistorySheet } from "@/components/inventory/StockMovements";
import { UnitConverterDialog } from "@/components/inventory/UnitConverterDialog";
import { InventoryAnalytics } from "@/components/inventory/InventoryAnalytics";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR, localDate } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Item {
  _id: string;
  name: string;
  sku?: string;
  category?: string;
  quantity?: number;
  unit?: string;
  unitCost?: number;
  minStockLevel?: number;
  supplier?: string;
  location?: string;
  hsnCode?: string;
  gstRate?: number;
  isFreeItem?: boolean;
  description?: string;
}

type Level = "out" | "critical" | "low" | "ok";
type View = "all" | "reorder" | "critical" | "out" | "analytics";

// From quantity against the reorder level; independent of the item's
// active/inactive lifecycle status.
const levelOf = (i: Item): Level => {
  const q = i.quantity || 0;
  const min = i.minStockLevel || 0;
  if (q <= 0) return "out";
  if (q <= min / 2) return "critical";
  if (q <= min) return "low";
  return "ok";
};
const LEVEL: Record<Level, { label: string; tone: PillTone; bar: string }> = {
  out: { label: "Out of stock", tone: "danger", bar: "bg-destructive" },
  critical: { label: "Critical", tone: "danger", bar: "bg-destructive" },
  low: { label: "Low", tone: "warning", bar: "bg-warning" },
  ok: { label: "In stock", tone: "success", bar: "bg-success" }
};
const inView = (i: Item, v: View) =>
  v === "reorder" ? levelOf(i) !== "ok" : v === "critical" ? levelOf(i) === "critical" : v === "out" ? levelOf(i) === "out" : true;
const valueOf = (i: Item) => (i.quantity || 0) * (i.unitCost || 0);

/** Quantity with a thin bar showing it against twice the reorder level. */
function StockCell({ item }: { item: Item }) {
  const q = item.quantity || 0;
  const min = item.minStockLevel || 0;
  const pct = min > 0 ? Math.min(100, (q / (min * 2)) * 100) : q > 0 ? 100 : 0;
  return (
    <div className="ml-auto w-28">
      <div className="num text-right">
        <span className="font-semibold">{q.toLocaleString("en-IN")}</span> <span className="text-xs text-muted-foreground">{item.unit || "units"}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", LEVEL[levelOf(item)].bar)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function Inventory() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [category, setCategory] = useState("all");
  const [itemDialog, setItemDialog] = useState<{ open: boolean; item: Item | null }>({ open: false, item: null });
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [history, setHistory] = useState<{ open: boolean; itemId?: string }>({ open: false });
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [dialog, setDialog] = useState<"units" | null>(null);
  const navigate = useNavigate();

  const canEdit = hasPermission("Inventory: Create & Edit");
  const canAdjust = hasPermission("Inventory: Adjust Stock");
  const canDelete = hasPermission("Inventory: Delete");
  // Purchase costs and stock value are only for logins with "View Cost".
  const canSeeCost = hasPermission("Inventory: View Cost");

  const load = useCallback(async () => {
    try {
      const res = await apiClient.getInventory();
      setItems(Array.isArray(res) ? (res as Item[]) : ((res as { inventory?: Item[] })?.inventory || []));
    } catch (error) {
      toast({ title: "Stock could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(() => Array.from(new Set(items.map((i) => i.category).filter(Boolean))).sort() as string[], [items]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(
      (i) =>
        inView(i, view) &&
        (category === "all" || i.category === category) &&
        (!q || [i.name, i.sku, i.category, i.supplier, i.location].some((f) => (f || "").toLowerCase().includes(q)))
    );
  }, [items, search, view, category]);

  const value = items.reduce((s, i) => s + valueOf(i), 0);
  const reorder = items.filter((i) => levelOf(i) !== "ok").length;
  const critical = items.filter((i) => levelOf(i) === "critical").length;
  const out = items.filter((i) => levelOf(i) === "out").length;

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      ["Name", "Category", "SKU", "Quantity", "Unit", ...(canSeeCost ? ["Unit cost"] : []), "Reorder level", ...(canSeeCost ? ["Value"] : []), "Supplier", "Location"].join(","),
      ...items.map((i) =>
        [i.name, i.category, i.sku, i.quantity || 0, i.unit, ...(canSeeCost ? [i.unitCost || 0] : []), i.minStockLevel || 0, ...(canSeeCost ? [valueOf(i)] : []), i.supplier, i.location].map(esc).join(",")
      )
    ].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `stock_${localDate()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast({ title: `Exported ${items.length} items` });
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteInventoryItem(deleting._id);
      toast({ title: `${deleting.name} removed` });
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not removed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const columns: Column<Item>[] = [
    {
      id: "name",
      header: "Item",
      cell: (i) => <EntityCell icon={Package} title={i.name} subtitle={i.sku ? <span className="font-mono">{i.sku}</span> : i.description} />,
      sortValue: (i) => i.name.toLowerCase(),
      className: "min-w-[240px]"
    },
    { id: "category", header: "Category", cell: (i) => (i.category ? <Tag>{i.category}</Tag> : "—"), sortValue: (i) => i.category || "", hideBelow: "lg" },
    { id: "stock", header: "In stock", align: "right", cell: (i) => <StockCell item={i} />, sortValue: (i) => i.quantity || 0, className: "w-[150px]" },
    {
      id: "min",
      header: "Reorder at",
      align: "right",
      cell: (i) => <span className="text-muted-foreground">{(i.minStockLevel || 0).toLocaleString("en-IN")}</span>,
      sortValue: (i) => i.minStockLevel || 0,
      hideBelow: "md"
    },
    ...(canSeeCost
      ? [
          { id: "cost", header: "Unit cost", align: "right" as const, cell: (i: Item) => formatINR(i.unitCost || 0), sortValue: (i: Item) => i.unitCost || 0, hideBelow: "lg" as const },
          { id: "value", header: "Value", align: "right" as const, cell: (i: Item) => <span className="font-medium">{formatINR(valueOf(i))}</span>, sortValue: valueOf }
        ]
      : []),
    {
      id: "level",
      header: "Level",
      cell: (i) => <StatusPill tone={LEVEL[levelOf(i)].tone}>{LEVEL[levelOf(i)].label}</StatusPill>,
      sortValue: (i) => ["out", "critical", "low", "ok"].indexOf(levelOf(i)),
      className: "w-[130px]"
    },
    {
      id: "supplier",
      header: "Supplier",
      cell: (i) => <Stack top={i.supplier || <span className="text-muted-foreground">—</span>} bottom={i.location} />,
      hideBelow: "xl"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Materials & purchase"
        title="Paper & stock"
        description="Paper, board, inks, plates and consumables — what's on the shelf, what it's worth and what to reorder."
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal />
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setHistory({ open: true })}>
                  <History />
                  Stock history
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/purchase-orders?new=1")}>
                  <ShoppingCart />
                  Purchase order
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog("units")}>
                  <Calculator />
                  Unit converter
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={exportCsv} disabled={!items.length}>
                  <Download />
                  Export CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canEdit && (
              <Button onClick={() => setItemDialog({ open: true, item: null })}>
                <Plus />
                Add item
              </Button>
            )}
          </>
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Items", value: items.length, hint: `${categories.length} categor${categories.length === 1 ? "y" : "ies"}` },
          canSeeCost
            ? { label: "Stock value", value: formatINR(value, { compact: value >= 1e5 }), hint: "Quantity × unit cost" }
            : { label: "Critical", value: critical, hint: "At half the reorder level or below", tone: critical ? "danger" : "default", onClick: () => setView(view === "critical" ? "all" : "critical"), active: view === "critical" },
          {
            label: "To reorder",
            value: reorder,
            hint: "At or below the reorder level",
            tone: reorder ? "warning" : "success",
            onClick: () => setView(view === "reorder" ? "all" : "reorder"),
            active: view === "reorder"
          },
          {
            label: "Out of stock",
            value: out,
            hint: critical ? `${critical} more critical` : "Nothing critical",
            tone: out ? "danger" : "default",
            onClick: () => setView(view === "out" ? "all" : "out"),
            active: view === "out"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All items", count: items.length },
            { value: "reorder", label: "To reorder", count: reorder, tone: "warning" },
            { value: "critical", label: "Critical", count: critical, tone: "danger" },
            { value: "out", label: "Out of stock", count: out, tone: "danger" },
            { value: "analytics", label: "Analytics", icon: BarChart3 }
          ]}
        />

        {view === "analytics" ? (
          <InventoryAnalytics canSeeCost={canSeeCost} />
        ) : (
          <DataCard
            toolbar={
              <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search item, SKU, supplier or location" />}>
                {categories.length > 1 && <FilterSelect label="Category" value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} />}
              </Toolbar>
            }
            footer={
              !loading &&
              rows.length > 0 && (
                <div className="flex justify-between gap-3">
                  <span>
                    {rows.length} of {items.length} items
                  </span>
                  {canSeeCost && <span className="num">Value in view: {formatINR(rows.reduce((s, i) => s + valueOf(i), 0))}</span>}
                </div>
              )
            }
          >
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(i) => i._id}
              loading={loading}
              onRowClick={canEdit ? (i) => setItemDialog({ open: true, item: i }) : undefined}
              actions={(i) => [
                { label: "Edit item", icon: Pencil, onClick: () => setItemDialog({ open: true, item: i }), hidden: !canEdit },
                { label: "Update stock", icon: PackagePlus, onClick: () => setAdjusting(i), hidden: !canAdjust },
                { label: "Stock history", icon: History, onClick: () => setHistory({ open: true, itemId: i._id }) },
                { label: "Remove item", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(i), hidden: !canDelete }
              ]}
              actionsLabel={(i) => `Actions for ${i.name}`}
              defaultSort={{ id: "level", dir: "asc" }}
              mobile={(i) => (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{i.name}</span>
                    <StatusPill tone={LEVEL[levelOf(i)].tone}>{LEVEL[levelOf(i)].label}</StatusPill>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {(i.quantity || 0).toLocaleString("en-IN")} {i.unit || "units"} · reorder at {(i.minStockLevel || 0).toLocaleString("en-IN")}
                    </span>
                    {canSeeCost && <span className="num">{formatINR(valueOf(i))}</span>}
                  </div>
                </div>
              )}
              empty={
                items.length === 0 ? (
                  <EmptyState
                    icon={Package}
                    title="No stock items yet"
                    description="Add the paper, inks, plates and consumables you keep, with a reorder level for each."
                    action={
                      canEdit && (
                        <Button onClick={() => setItemDialog({ open: true, item: null })}>
                          <Plus />
                          Add item
                        </Button>
                      )
                    }
                  />
                ) : (
                  <EmptyState compact tone={view !== "all" && !search ? "success" : "default"} icon={Package} title={view !== "all" && !search ? "Nothing here — stock is healthy" : "No items match"} />
                )
              }
            />
          </DataCard>
        )}
      </div>

      <StockAdjustDialog item={adjusting} onOpenChange={(o) => !o && setAdjusting(null)} onDone={load} />
      <StockHistorySheet open={history.open} itemId={history.itemId} items={items} onOpenChange={(open) => setHistory((h) => ({ ...h, open }))} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="The item and its stock level are removed from Paper & stock. Past purchase bills and invoices keep their lines."
        confirmLabel="Remove"
        onConfirm={remove}
      />
      <CreateItemDialog
        open={itemDialog.open}
        onOpenChange={(open) => setItemDialog((d) => ({ ...d, open }))}
        onItemCreated={load}
        item={itemDialog.item}
      />
      <UnitConverterDialog open={dialog === "units"} onOpenChange={(o) => !o && setDialog(null)} />
    </PageShell>
  );
}
