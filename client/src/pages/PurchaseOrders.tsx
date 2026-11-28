import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { Ban, ClipboardList, Download, Eye, FilePlus2, Loader2, Mail, PackageCheck, Pencil, Plus, Printer, Send, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { EditorSheet, EditorSection } from "@/components/users/EditorSheet";
import { ConfirmDialog, DataCard, DataTable, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { newIdempotencyKey } from "@/components/payments/paymentMeta";

type Status = "draft" | "sent" | "acknowledged" | "partial" | "completed" | "cancelled";
type View = "open" | "draft" | "sent" | "partial" | "completed" | "cancelled" | "all";

interface POLine {
  inventoryId: string | { _id: string };
  itemName: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  receivedQuantity: number;
}

interface PO {
  _id: string;
  poNumber: string;
  vendorId: string | { _id: string; name: string };
  vendorName: string;
  status: Status;
  expectedDelivery?: string;
  items: POLine[];
  totalAmount: number;
  notes?: string;
  terms?: string;
  createdAt: string;
  sentAt?: string;
  approvedAt?: string;
  completedAt?: string;
  /** The purchase bill generated from this order, once there is one. */
  purchaseBillNumber?: string;
  receipts?: { _id: string; receivedAt: string; receivedByName?: string; reference?: string; reversedAt?: string; lines: { itemName: string; quantity: number }[] }[];
}

/** Placed (approved) and not cancelled: such an order can have its bill generated. */
const billable = (po: PO) => !po.purchaseBillNumber && (["sent", "acknowledged"].includes(po.status) || (["partial", "completed"].includes(po.status) && !!po.approvedAt));

interface StockItem {
  _id: string;
  name: string;
  unit?: string;
  unitCost?: number;
  quantity?: number;
  supplier?: string;
}

interface Stats {
  counts: Record<Status, number>;
  open: number;
  openValue: number;
  overdue: number;
  total: number;
}

const PAGE = 25;
const STATUS: Record<Status, { label: string; tone: PillTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Ordered", tone: "info" },
  acknowledged: { label: "Confirmed", tone: "info" },
  partial: { label: "Part received", tone: "warning" },
  completed: { label: "Received", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" }
};
const lineId = (l: POLine) => (typeof l.inventoryId === "object" ? l.inventoryId._id : l.inventoryId);
/** One row per stock item: an older order may list the same item on two lines. */
const receiveRows = (po: PO) => {
  const rows = new Map<string, { id: string; itemName: string; quantity: number; receivedQuantity: number }>();
  for (const l of po.items) {
    const row = rows.get(lineId(l)) || { id: lineId(l), itemName: l.itemName, quantity: 0, receivedQuantity: 0 };
    row.quantity += l.quantity;
    row.receivedQuantity += l.receivedQuantity;
    rows.set(row.id, row);
  }
  return [...rows.values()];
};
const vendorIdOf = (po: PO) => (typeof po.vendorId === "object" ? po.vendorId._id : po.vendorId);
const isOverdue = (po: PO) => ["sent", "acknowledged", "partial"].includes(po.status) && !!po.expectedDelivery && new Date(po.expectedDelivery) < new Date(new Date().setHours(0, 0, 0, 0));
const progress = (po: PO) => {
  const ordered = po.items.reduce((s, l) => s + l.quantity, 0);
  const got = po.items.reduce((s, l) => s + l.receivedQuantity, 0);
  return ordered ? Math.round((got / ordered) * 100) : 0;
};

interface FormLine {
  key: string;
  inventoryId: string;
  quantity: string;
  unitCost: string;
}
const newLine = (): FormLine => ({ key: Math.random().toString(36).slice(2), inventoryId: "", quantity: "", unitCost: "" });
const EMPTY = { vendorId: "", expectedDelivery: "", notes: "", terms: "Net 30", lines: [newLine()] };

export default function PurchaseOrders() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const canEdit = hasPermission("Inventory: Create & Edit") || hasPermission("Purchase Bills: Create & Edit");
  const canBill = hasPermission("Purchase Bills: Create & Edit");

  const [rows, setRows] = useState<PO[]>([]);
  // A failed load shows as an error with Retry, never as an empty list.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("open");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [vendor, setVendor] = useState("all");
  const [page, setPage] = useState(1);

  const [vendors, setVendors] = useState<{ _id: string; name: string }[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [editor, setEditor] = useState<{ open: boolean; po: PO | null }>({ open: false, po: null });
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState<"draft" | "send" | null>(null);
  const [receiving, setReceiving] = useState<PO | null>(null);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [receiveRef, setReceiveRef] = useState("");
  const receiveAttempt = useRef<{ signature: string; key: string } | null>(null);
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ po: PO; action: "cancel" | "delete" } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      const [list, s] = (await Promise.all([
        apiClient.get("/purchase-orders", { status: view, search: q, vendorId: vendor !== "all" ? vendor : undefined, page, limit: PAGE }),
        apiClient.get("/purchase-orders/stats/summary")
      ])) as [{ purchaseOrders?: PO[]; pagination?: { total?: number } }, { stats?: Stats }];
      setRows(list?.purchaseOrders || []);
      setTotal(list?.pagination?.total || 0);
      setStats(s?.stats || null);
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, [view, q, vendor, page, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [view, q, vendor]);
  useEffect(() => {
    apiClient
      .listAll<{ _id: string; name: string }>("/vendors", "vendors")
      .then(setVendors)
      .catch(() => setVendors([]));
  }, []);

  const loadStock = async () => {
    if (stock.length) return stock;
    try {
      const res = await apiClient.getInventory();
      const list = (Array.isArray(res) ? res : (res as { inventory?: StockItem[] })?.inventory || []) as StockItem[];
      setStock(list);
      return list;
    } catch {
      return [];
    }
  };

  const openEditor = useCallback(
    async (po: PO | null) => {
      setForm(
        po
          ? {
              vendorId: vendorIdOf(po),
              expectedDelivery: po.expectedDelivery ? format(new Date(po.expectedDelivery), "yyyy-MM-dd") : "",
              notes: po.notes || "",
              terms: po.terms || "Net 30",
              lines: po.items.map((l) => ({ key: Math.random().toString(36).slice(2), inventoryId: lineId(l), quantity: String(l.quantity), unitCost: String(l.unitCost) }))
            }
          : { ...EMPTY, lines: [newLine()] }
      );
      setEditor({ open: true, po });
      await loadStock();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stock]
  );

  // "Purchase order" from Paper & stock links here with ?new=1
  useEffect(() => {
    if (params.get("new") === "1" && canEdit) {
      openEditor(null);
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  }, [params, setParams, canEdit, openEditor]);

  const setLine = (key: string, patch: Partial<FormLine>) => setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const formTotal = form.lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0);

  const save = async (send: boolean) => {
    const lines = form.lines.filter((l) => l.inventoryId);
    if (!form.vendorId || !lines.length || lines.some((l) => !(Number(l.quantity) > 0))) {
      toast({ title: "Choose a supplier and give each item a quantity", variant: "destructive" });
      return;
    }
    if (lines.some((l) => !(Number(l.unitCost) > 0))) {
      toast({ title: "Give each item a unit cost above 0", variant: "destructive" });
      return;
    }
    setSaving(send ? "send" : "draft");
    const payload = {
      vendorId: form.vendorId,
      expectedDelivery: form.expectedDelivery || undefined,
      notes: form.notes,
      terms: form.terms,
      send,
      items: lines.map((l) => ({ inventoryId: l.inventoryId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) || 0 }))
    };
    try {
      if (editor.po) {
        await apiClient.put(`/purchase-orders/${editor.po._id}`, payload);
        if (send && editor.po.status === "draft") await apiClient.updatePurchaseOrderStatus(editor.po._id, "sent");
      } else {
        await apiClient.post("/purchase-orders", payload);
      }
      toast({ title: editor.po ? "Purchase order updated" : send ? "Purchase order created and marked ordered" : "Draft purchase order saved" });
      setEditor({ open: false, po: null });
      load();
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const setStatus = async (po: PO, status: "sent" | "draft" | "cancelled") => {
    try {
      await apiClient.updatePurchaseOrderStatus(po._id, status);
      toast({ title: status === "sent" ? `${po.poNumber} marked ordered` : status === "cancelled" ? `${po.poNumber} cancelled` : `${po.poNumber} back to draft` });
      load();
    } catch (error) {
      toast({ title: "Not changed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  // One click, like generating payroll: the order's lines become its purchase bill.
  const generateBill = async (po: PO) => {
    try {
      const res = (await apiClient.generatePurchaseBills([po._id])) as { bills?: { billNumber: string }[] };
      toast({ title: `${res?.bills?.[0]?.billNumber || "Bill"} generated from ${po.poNumber}`, description: "It is on the Purchase bills page; add the supplier's invoice number when it arrives." });
      load();
    } catch (error) {
      toast({ title: "Bill not generated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const openReceive = (po: PO) => {
    setReceiveQty(Object.fromEntries(receiveRows(po).map((r) => [r.id, String(Math.max(0, r.quantity - r.receivedQuantity))])));
    setReceiveRef("");
    receiveAttempt.current = null;
    setReceiving(po);
  };

  const receive = async () => {
    if (!receiving) return;
    const lines = receiveRows(receiving).map((r) => ({ inventoryId: r.id, quantity: Number(receiveQty[r.id]) || 0 })).filter((l) => l.quantity > 0);
    if (!lines.length) {
      toast({ title: "Enter what arrived", variant: "destructive" });
      return;
    }
    const payload = { lines, reference: receiveRef || undefined };
    // The same submission retried (a double click, a dropped connection) keeps
    // its key, so the server records the delivery once.
    const signature = JSON.stringify(payload);
    if (receiveAttempt.current?.signature !== signature) receiveAttempt.current = { signature, key: newIdempotencyKey() };
    setReceiveBusy(true);
    try {
      const res = (await apiClient.post(`/purchase-orders/${receiving._id}/receive`, { ...payload, idempotencyKey: receiveAttempt.current.key })) as { purchaseOrder?: PO };
      toast({ title: res?.purchaseOrder?.status === "completed" ? "Order received in full" : "Delivery recorded", description: "Stock was added to Paper & stock." });
      setReceiving(null);
      load();
    } catch (error) {
      toast({ title: "Not recorded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setReceiveBusy(false);
    }
  };

  // Documents: preview opens the PDF in a new tab, print opens the print dialog, download saves it.
  const [emailing, setEmailing] = useState<PO | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailNote, setEmailNote] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [returning, setReturning] = useState<PO | null>(null);
  const [returnReceipt, setReturnReceipt] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);
  const failed = (title: string) => (error: unknown) => toast({ title, description: error instanceof Error ? error.message : undefined, variant: "destructive" });
  const previewPdf = async (po: PO) => {
    // Open the tab inside the click so a pop-up blocker allows it, then point it at the PDF.
    const tab = window.open("", "_blank");
    try {
      const file = await apiClient.getPurchaseOrderPdfFile(po._id, po.poNumber);
      const url = URL.createObjectURL(file.blob);
      if (tab) tab.location.href = url; else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      failed("Could not open the purchase order")(error);
    }
  };
  const sendEmail = async () => {
    if (!emailing) return;
    setEmailBusy(true);
    try {
      await apiClient.sendPurchaseOrderEmail(emailing._id, emailTo.trim(), emailNote.trim());
      toast({ title: `${emailing.poNumber} sent`, description: emailTo.trim() || "To the supplier's email on file" });
      setEmailing(null);
    } catch (error) {
      failed("Not sent")(error);
    } finally {
      setEmailBusy(false);
    }
  };
  const openReturn = (po: PO) => {
    const live = (po.receipts || []).filter((r) => !r.reversedAt);
    setReturning(po);
    setReturnReceipt(live.length ? live[live.length - 1]._id : "");
    setReturnReason("");
  };
  const submitReturn = async () => {
    if (!returning || !returnReceipt || !returnReason.trim()) return;
    setReturnBusy(true);
    try {
      await apiClient.returnPurchaseOrderDelivery(returning._id, returnReceipt, returnReason.trim());
      toast({ title: "Delivery returned", description: "Stock and the order were adjusted. The delivery stays on record as returned." });
      setReturning(null);
      load();
    } catch (error) {
      failed("Not returned")(error);
    } finally {
      setReturnBusy(false);
    }
  };

  const confirmAction = async () => {
    if (!confirm) return;
    if (confirm.action === "cancel") {
      await setStatus(confirm.po, "cancelled");
    } else {
      try {
        await apiClient.deletePurchaseOrder(confirm.po._id);
        toast({ title: `${confirm.po.poNumber} deleted` });
        load();
      } catch (error) {
        toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
        throw error;
      }
    }
    setConfirm(null);
  };

  const stockById = useMemo(() => new Map(stock.map((s) => [s._id, s])), [stock]);
  const c = stats?.counts;

  const columns: Column<PO>[] = [
    {
      id: "po",
      header: "Order",
      cell: (po) => <Stack top={<span className="font-mono text-[13px] font-semibold text-primary">{po.poNumber}</span>} bottom={`${plural(po.items.length, "item")} · ${fmtDate(po.createdAt)}`} />,
      sortValue: (po) => po.poNumber,
      className: "w-[180px]"
    },
    { id: "vendor", header: "Supplier", cell: (po) => <span className="font-medium">{po.vendorName}</span>, sortValue: (po) => po.vendorName.toLowerCase(), className: "min-w-[180px]" },
    {
      id: "items",
      header: "Items",
      cell: (po) => (
        <span className="block max-w-[260px] truncate text-muted-foreground" title={po.items.map((l) => `${l.itemName} × ${l.quantity}`).join(", ")}>
          {po.items.map((l) => l.itemName).join(", ")}
        </span>
      ),
      hideBelow: "xl"
    },
    {
      id: "expected",
      header: "Expected",
      cell: (po) =>
        po.expectedDelivery ? <span className={cn("whitespace-nowrap", isOverdue(po) && "font-medium text-destructive-strong")}>{fmtDate(po.expectedDelivery)}</span> : <span className="text-muted-foreground">—</span>,
      sortValue: (po) => po.expectedDelivery || "9999",
      hideBelow: "md"
    },
    { id: "total", header: "Value", align: "right", cell: (po) => <span className="font-semibold">{formatINR(po.totalAmount)}</span>, sortValue: (po) => po.totalAmount, hideBelow: "lg" },
    {
      id: "status",
      header: "Status",
      cell: (po) => (
        <Stack
          top={<StatusPill tone={isOverdue(po) ? "danger" : STATUS[po.status].tone}>{isOverdue(po) ? "Late" : STATUS[po.status].label}</StatusPill>}
          bottom={[po.status === "partial" ? `${progress(po)}% received` : "", po.purchaseBillNumber ? `Billed · ${po.purchaseBillNumber}` : ""].filter(Boolean).join(" · ") || undefined}
        />
      ),
      sortValue: (po) => po.status,
      className: "w-[140px]"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Materials & purchase"
        title="Purchase orders"
        description="Paper, ink and consumables ordered from suppliers. Receiving an order adds it to stock."
        actions={
          canEdit && (
            <Button onClick={() => openEditor(null)}>
              <Plus />
              New purchase order
            </Button>
          )
        }
      />

      <MetricBar
        loading={!stats}
        metrics={[
          { label: "Open orders", value: stats?.open ?? 0, hint: `${formatINR(stats?.openValue || 0, { compact: (stats?.openValue || 0) >= 1e5 })} on order`, onClick: () => setView("open"), active: view === "open" },
          { label: "Waiting for delivery", value: (c?.sent || 0) + (c?.acknowledged || 0), hint: c?.partial ? `${c.partial} part received` : "None part received", onClick: () => setView("sent"), active: view === "sent" },
          { label: "Late", value: stats?.overdue ?? 0, hint: stats?.overdue ? "Past the expected date" : "Nothing late", tone: stats?.overdue ? "danger" : "default" },
          { label: "Drafts", value: c?.draft || 0, hint: "Not ordered yet", onClick: () => setView("draft"), active: view === "draft" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "open", label: "Open", count: stats?.open },
            { value: "draft", label: "Drafts", count: c?.draft },
            { value: "sent", label: "Ordered", count: (c?.sent || 0) + (c?.acknowledged || 0) },
            { value: "partial", label: "Part received", count: c?.partial, tone: "warning" },
            { value: "completed", label: "Received", count: c?.completed },
            { value: "cancelled", label: "Cancelled", count: c?.cancelled },
            { value: "all", label: "All", count: stats?.total }
          ]}
        />
        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search PO number, supplier or item" />}>
              <FilterSelect label="Supplier" value={vendor} onChange={setVendor} options={vendors.map((v) => ({ value: v._id, label: v.name }))} />
            </Toolbar>
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE} total={total} onPageChange={setPage} noun="orders" />}
        >
          <DataTable
            error={loadError}
            onRetry={() => load()}
            columns={columns}
            rows={rows}
            rowKey={(po) => po._id}
            loading={loading}
            onRowClick={canEdit ? (po) => (["draft", "sent", "acknowledged"].includes(po.status) && !po.purchaseBillNumber && !po.items.some((l) => l.receivedQuantity > 0) ? openEditor(po) : ["partial"].includes(po.status) ? openReceive(po) : undefined) : undefined}
            actions={(po) => [
              { label: "Preview PDF", icon: Eye, onClick: () => previewPdf(po) },
              { label: "Print", icon: Printer, onClick: () => { apiClient.printPurchaseOrderPDF(po._id, po.poNumber).catch(failed("Could not print")); } },
              { label: "Download PDF", icon: Download, onClick: () => { apiClient.downloadPurchaseOrderPDF(po._id, po.poNumber).catch(failed("Could not download")); } },
              { label: "Email supplier", icon: Mail, onClick: () => { setEmailing(po); setEmailTo(""); setEmailNote(""); }, hidden: !canEdit || po.status === "cancelled" },
              { label: "Return delivery", icon: Undo2, onClick: () => openReturn(po), hidden: !canEdit || !(po.receipts || []).some((r) => !r.reversedAt) },
              { label: "Generate bill", icon: FilePlus2, onClick: () => generateBill(po), hidden: !canBill || !billable(po) },
              { label: "Receive goods", icon: PackageCheck, onClick: () => openReceive(po), hidden: !canEdit || !["sent", "acknowledged", "partial"].includes(po.status) },
              { label: "Mark ordered", icon: Send, onClick: () => setStatus(po, "sent").catch(() => undefined), hidden: !canEdit || po.status !== "draft" },
              { label: "Edit", icon: Pencil, onClick: () => openEditor(po), hidden: !canEdit || !!po.purchaseBillNumber || !["draft", "sent", "acknowledged"].includes(po.status) || po.items.some((l) => l.receivedQuantity > 0) },
              { label: "Cancel order", icon: Ban, separated: true, onClick: () => setConfirm({ po, action: "cancel" }), hidden: !canEdit || !!po.purchaseBillNumber || !["draft", "sent", "acknowledged", "partial"].includes(po.status) },
              { label: "Delete", icon: Trash2, destructive: true, onClick: () => setConfirm({ po, action: "delete" }), hidden: !canEdit || !["draft", "cancelled"].includes(po.status) || po.items.some((l) => l.receivedQuantity > 0) }
            ]}
            actionsLabel={(po) => `Actions for ${po.poNumber}`}
            mobile={(po) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{po.vendorName}</span>
                  <StatusPill tone={isOverdue(po) ? "danger" : STATUS[po.status].tone}>{isOverdue(po) ? "Late" : STATUS[po.status].label}</StatusPill>
                </div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{po.poNumber}</span> · {plural(po.items.length, "item")} · {formatINR(po.totalAmount)}
                  {po.expectedDelivery ? ` · due ${fmtDate(po.expectedDelivery)}` : ""}
                </div>
              </div>
            )}
            empty={
              <EmptyState
                icon={ClipboardList}
                title={q || vendor !== "all" || view !== "open" ? "No orders in this view" : "No open purchase orders"}
                description={q || vendor !== "all" || view !== "open" ? undefined : "Order paper and supplies from a supplier, then receive them here to add them to stock."}
                action={
                  canEdit &&
                  !q &&
                  view === "open" && (
                    <Button onClick={() => openEditor(null)}>
                      <Plus />
                      New purchase order
                    </Button>
                  )
                }
              />
            }
          />
        </DataCard>
      </div>

      <EditorSheet
        open={editor.open}
        onOpenChange={(open) => setEditor((s) => ({ ...s, open }))}
        wide
        title={editor.po ? `Edit ${editor.po.poNumber}` : "New purchase order"}
        description="What you're ordering, from whom, and when you expect it."
        onSubmit={(e) => {
          e.preventDefault();
          save(editor.po ? editor.po.status !== "draft" : true);
        }}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setEditor({ open: false, po: null })}>
              Cancel
            </Button>
            {(!editor.po || editor.po.status === "draft") && (
              <Button type="button" variant="outline" disabled={!!saving} onClick={() => save(false)}>
                {saving === "draft" && <Loader2 className="animate-spin" />}
                Save as draft
              </Button>
            )}
            <Button type="submit" disabled={!!saving}>
              {saving === "send" && <Loader2 className="animate-spin" />}
              {editor.po && editor.po.status !== "draft" ? "Save changes" : "Save and mark ordered"}
            </Button>
          </>
        }
      >
        <EditorSection title="Supplier">
          <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
            <div className="space-y-1.5">
              <Label htmlFor="po-vendor">Supplier</Label>
              <Select value={form.vendorId} onValueChange={(v) => setForm({ ...form, vendorId: v })}>
                <SelectTrigger id="po-vendor">
                  <SelectValue placeholder={vendors.length ? "Choose a supplier" : "No suppliers yet — add one on Suppliers"} />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v._id} value={v._id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="po-expected">Expected by</Label>
              <Input id="po-expected" type="date" value={form.expectedDelivery} onChange={(e) => setForm({ ...form, expectedDelivery: e.target.value })} />
            </div>
          </div>
        </EditorSection>

        <EditorSection title="Items" description="Choose stock items; the last cost is filled in for you.">
          <div className="space-y-2">
            {form.lines.map((l) => {
              const item = stockById.get(l.inventoryId);
              const lineTotal = (Number(l.quantity) || 0) * (Number(l.unitCost) || 0);
              return (
                <div key={l.key} className="grid grid-cols-[1fr_auto] gap-2 rounded-md border p-2.5 sm:grid-cols-[minmax(0,1fr)_100px_120px_110px_auto] sm:items-end">
                  <div className="col-span-2 space-y-1 sm:col-span-1">
                    <Label className="text-xs text-muted-foreground">Item</Label>
                    <Select
                      value={l.inventoryId}
                      onValueChange={(v) => {
                        const s = stockById.get(v);
                        setLine(l.key, { inventoryId: v, unitCost: l.unitCost || String(s?.unitCost ?? "") });
                      }}
                    >
                      <SelectTrigger aria-label="Item">
                        <SelectValue placeholder={stock.length ? "Choose an item" : "Loading stock…"} />
                      </SelectTrigger>
                      <SelectContent>
                        {stock.map((s) => (
                          <SelectItem key={s._id} value={s._id}>
                            {s.name}
                            {s.unit ? ` (${s.unit})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Qty{item?.unit ? ` (${item.unit})` : ""}</Label>
                    <Input type="number" inputMode="decimal" min="0" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} aria-label="Quantity" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Unit cost (₹)</Label>
                    <Input type="number" inputMode="decimal" min="0" step="0.01" value={l.unitCost} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} aria-label="Unit cost" />
                  </div>
                  <div className="num pb-2 text-right text-sm font-medium sm:pb-2.5">{formatINR(lineTotal)}</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="self-end text-muted-foreground"
                    aria-label="Remove item"
                    disabled={form.lines.length === 1}
                    onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((x) => x.key !== l.key) }))}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
            <div className="flex items-center justify-between">
              <Button type="button" variant="subtle" size="sm" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, newLine()] }))}>
                <Plus />
                Add item
              </Button>
              <span className="text-sm">
                Total <span className="num font-semibold">{formatINR(formTotal)}</span>
              </span>
            </div>
          </div>
        </EditorSection>

        <EditorSection title="Terms & notes">
          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="po-terms">Payment terms</Label>
              <Input id="po-terms" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="po-notes">Notes for the supplier</Label>
              <Textarea id="po-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" />
            </div>
          </div>
        </EditorSection>
      </EditorSheet>

      <Dialog open={!!emailing} onOpenChange={(o) => !o && !emailBusy && setEmailing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email {emailing?.poNumber}</DialogTitle>
            <DialogDescription>The PDF is attached. Leave the address blank to use the supplier's email on file.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="po-email-to">Send to</Label><Input id="po-email-to" type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="supplier@example.com" /></div>
            <div className="space-y-1.5"><Label htmlFor="po-email-note">Message (optional)</Label><Textarea id="po-email-note" value={emailNote} onChange={(e) => setEmailNote(e.target.value)} rows={3} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailing(null)} disabled={emailBusy}>Cancel</Button>
            <Button onClick={sendEmail} disabled={emailBusy}>{emailBusy && <Loader2 className="animate-spin" />}Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!returning} onOpenChange={(o) => !o && !returnBusy && setReturning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return a delivery — {returning?.poNumber}</DialogTitle>
            <DialogDescription>Takes the goods back out of stock and off the order. The delivery stays on record as returned. It is refused if the stock has already been used.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Delivery</Label>
              <Select value={returnReceipt} onValueChange={setReturnReceipt}>
                <SelectTrigger><SelectValue placeholder="Choose a delivery" /></SelectTrigger>
                <SelectContent>
                  {(returning?.receipts || []).filter((r) => !r.reversedAt).map((r) => (
                    <SelectItem key={r._id} value={r._id}>{fmtDate(r.receivedAt)} · {r.lines.map((l) => `${l.itemName} × ${l.quantity}`).join(", ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="po-return-reason">Reason *</Label><Textarea id="po-return-reason" value={returnReason} onChange={(e) => setReturnReason(e.target.value)} rows={2} maxLength={300} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturning(null)} disabled={returnBusy}>Cancel</Button>
            <Button variant="destructive" onClick={submitReturn} disabled={returnBusy || !returnReceipt || !returnReason.trim()}>{returnBusy && <Loader2 className="animate-spin" />}Return delivery</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!receiving} onOpenChange={(o) => !o && !receiveBusy && setReceiving(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Receive goods</DialogTitle>
            <DialogDescription>{receiving ? `${receiving.poNumber} · ${receiving.vendorName}. What arrives is added to Paper & stock.` : null}</DialogDescription>
          </DialogHeader>
          {receiving && (
            <div className="space-y-3">
              <div className="divide-y rounded-md border">
                {receiveRows(receiving).map((l) => {
                  const due = l.quantity - l.receivedQuantity;
                  return (
                    <div key={l.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <Stack top={<span className="font-medium">{l.itemName}</span>} bottom={`${l.receivedQuantity} of ${l.quantity} received`} />
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        max={due}
                        disabled={due <= 0}
                        value={receiveQty[l.id] ?? ""}
                        onChange={(e) => setReceiveQty((r) => ({ ...r, [l.id]: e.target.value }))}
                        className="h-8 w-24 text-right"
                        aria-label={`Quantity of ${l.itemName} received`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="receive-ref">Supplier challan or bill no.</Label>
                <Input id="receive-ref" value={receiveRef} onChange={(e) => setReceiveRef(e.target.value)} placeholder="Optional" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiving(null)} disabled={receiveBusy}>
              Cancel
            </Button>
            <Button onClick={receive} disabled={receiveBusy}>
              {receiveBusy ? <Loader2 className="animate-spin" /> : <PackageCheck />}
              Add to stock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.action === "cancel" ? `Cancel ${confirm.po.poNumber}?` : `Delete ${confirm?.po.poNumber}?`}
        description={confirm?.action === "cancel" ? "Nothing more will be received against it. Stock already received stays." : "The order is removed. This can't be undone."}
        confirmLabel={confirm?.action === "cancel" ? "Cancel order" : "Delete"}
        cancelLabel="Keep"
        onConfirm={confirmAction}
      />
    </PageShell>
  );
}
