import { useCallback, useEffect, useState } from "react";
import { Ban, Check, ClipboardList, FilePlus2, Loader2, Pencil, Plus, RefreshCw, Trash2, Wallet, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, FilterSelect, Pagination, SearchField, Stack, StatusPill, Toolbar, type Column, type PillTone } from "@/components/data";
import { SalesOrderEditor } from "@/components/salesOrders/SalesOrderEditor";
import { newIdempotencyKey } from "@/components/payments/paymentMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR } from "@/lib/format";
import type { SalesOrderRecord } from "@/lib/salesOrders";

interface Row {
  _id: string; orderNumber: string; orderDate: string; projectName?: string; customer: string; mobile?: string;
  total: number; discount: number; paid: number; balance: number; approvalStatus: "pending" | "approved" | "cancelled";
  productionStatus: string; processStatus: string; assignedTo?: string; invoiced: boolean;
}
const TONE: Record<string, PillTone> = { pending: "warning", approved: "success", cancelled: "neutral" } as Record<string, PillTone>;
const PAGE = 15;
const STAGES = ["design", "printing", "finishing"] as const;

/** The approval queue for sales orders, with the production stages, advances and invoice for each. */
export default function SalesOrders() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const can = (a: string) => hasPermission(`Sales Orders: ${a}`);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);
  const [approval, setApproval] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [editor, setEditor] = useState<{ open: boolean; order?: SalesOrderRecord }>({ open: false });
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [advance, setAdvance] = useState<{ row: Row; customerId: string } | null>(null);
  const [advAmount, setAdvAmount] = useState("");
  const [advMethod, setAdvMethod] = useState("cash");
  const [advRef, setAdvRef] = useState("");
  const [advKey, setAdvKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<SalesOrderRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.listSalesOrders({ search: debounced || undefined, approval, from: from || undefined, to: to || undefined, page, limit: PAGE });
      setRows(r.orders as Row[]); setTotal(r.pagination.total); setCounts(r.counts || {}); setLoadError(null);
    } catch (e) { setLoadError(e); } finally { setLoading(false); }
  }, [debounced, approval, from, to, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [debounced, approval, from, to]);

  const fail = (title: string) => (e: unknown) => toast({ title, description: e instanceof Error ? e.message : undefined, variant: "destructive" });
  const openEdit = async (r: Row) => { try { setEditor({ open: true, order: (await apiClient.getSalesOrder(r._id)).order }); } catch (e) { fail("Could not open the order")(e); } };
  const approve = async (r: Row) => { try { await apiClient.approveSalesOrder(r._id); toast({ title: `${r.orderNumber} approved` }); load(); } catch (e) { fail("Not approved")(e); load(); } };
  const doCancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    try { const res = (await apiClient.cancelSalesOrder(cancelling._id, cancelReason.trim())) as { message?: string }; toast({ title: `${cancelling.orderNumber} cancelled`, description: res.message }); setCancelling(null); setCancelReason(""); load(); }
    catch (e) { fail("Not cancelled")(e); } finally { setBusy(false); }
  };
  const doDelete = async () => { if (!deleting) return; try { await apiClient.deleteSalesOrder(deleting._id); toast({ title: `${deleting.orderNumber} deleted` }); load(); } catch (e) { fail("Not deleted")(e); throw e; } };
  const openStages = async (r: Row) => { try { setStages((await apiClient.getSalesOrder(r._id)).order); } catch (e) { fail("Could not open the order")(e); } };
  const stageAct = async (stage: string, action: "start" | "complete" | "skip") => {
    if (!stages) return;
    const reason = action === "skip" && stages.production?.[stage]?.required ? window.prompt(`Reason for skipping ${stage}?`) || "" : undefined;
    if (action === "skip" && stages.production?.[stage]?.required && !reason) return;
    try { const r = (await apiClient.salesOrderStage(stages._id, stage, action, { reason })) as { order?: SalesOrderRecord; data?: { order: SalesOrderRecord } }; setStages(r.order || r.data?.order || null); load(); }
    catch (e) { fail("Not changed")(e); }
  };
  const invoice = async (r: Row) => {
    try { const res = await apiClient.invoiceSalesOrder(r._id); toast({ title: "Draft invoice created", description: res.invoice?.invoiceNumber }); load(); } catch (e) { fail("Invoice not created")(e); load(); }
  };
  const openAdvance = async (r: Row) => {
    try { const o = (await apiClient.getSalesOrder(r._id)).order; const cid = typeof o.customerId === "object" ? o.customerId._id : o.customerId; setAdvance({ row: r, customerId: String(cid) }); setAdvAmount(""); setAdvRef(""); setAdvKey(newIdempotencyKey()); }
    catch (e) { fail("Could not open the order")(e); }
  };
  const saveAdvance = async () => {
    if (!advance) return;
    setBusy(true);
    try {
      // One key per dialog: a double click or retry records the advance once.
      await apiClient.createPayment({ customerId: advance.customerId, salesOrderId: advance.row._id, amount: Number(advAmount), paymentMethod: advMethod, referenceNumber: advRef || undefined, idempotencyKey: advKey });
      toast({ title: "Advance recorded", description: `${formatINR(Number(advAmount))} for ${advance.row.orderNumber}` });
      setAdvance(null); load();
    } catch (e) { fail("Advance not recorded")(e); } finally { setBusy(false); }
  };

  const columns: Column<Row>[] = [
    { id: "date", header: "Order date", cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.orderDate)}</span>, hideBelow: "md" },
    { id: "no", header: "Order no.", cell: (r) => <Stack top={<span className="font-mono text-[13px] font-semibold text-primary">{r.orderNumber}</span>} bottom={r.projectName} /> },
    { id: "cust", header: "Customer", cell: (r) => <Stack top={<span className="font-medium">{r.customer}</span>} bottom={r.mobile} /> },
    { id: "total", header: "Total", align: "right", cell: (r) => <span className="font-semibold">{formatINR(r.total)}</span> },
    { id: "disc", header: "Discount", align: "right", cell: (r) => formatINR(r.discount), hideBelow: "xl" },
    { id: "paid", header: "Paid", align: "right", cell: (r) => formatINR(r.paid), hideBelow: "lg" },
    { id: "bal", header: "Balance", align: "right", cell: (r) => <span className={r.balance > 0 ? "font-medium" : "text-muted-foreground"}>{formatINR(r.balance)}</span>, hideBelow: "lg" },
    { id: "prod", header: "Production", cell: (r) => <span className="capitalize text-muted-foreground">{r.productionStatus?.replace(/_/g, " ")}</span>, hideBelow: "xl" },
    { id: "proc", header: "Process", cell: (r) => <span className="text-muted-foreground">{r.processStatus}</span>, hideBelow: "xl" },
    { id: "staff", header: "Assigned", cell: (r) => r.assignedTo || <span className="text-muted-foreground">—</span>, hideBelow: "xl" },
    { id: "appr", header: "Approval", cell: (r) => <StatusPill tone={TONE[r.approvalStatus] || "neutral"}>{r.approvalStatus}</StatusPill> },
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Sales & estimating"
        title="Sales orders"
        description="Approve orders before production starts. An approved order moves through design, printing and finishing, then is invoiced."
        actions={<div className="flex gap-2"><Button variant="outline" onClick={load} aria-label="Refresh"><RefreshCw />Refresh</Button>{can("Create & Edit") && <Button onClick={() => setEditor({ open: true })}><Plus />New order</Button>}</div>}
      />
      <DataCard
        toolbar={
          <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Order number, customer or mobile" />}>
            <FilterSelect label="Approval" value={approval} onChange={setApproval} options={[{ value: "pending", label: `Pending (${counts.pending || 0})` }, { value: "approved", label: `Approved (${counts.approved || 0})` }, { value: "cancelled", label: `Cancelled (${counts.cancelled || 0})` }]} />
            <Input aria-label="From date" type="date" className="h-9 w-auto min-w-[9.5rem]" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input aria-label="To date" type="date" className="h-9 w-auto min-w-[9.5rem]" value={to} onChange={(e) => setTo(e.target.value)} />
          </Toolbar>
        }
        footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE} total={total} onPageChange={setPage} noun="orders" />}
      >
        <DataTable
          error={loadError}
          onRetry={load}
          columns={columns}
          rows={rows}
          rowKey={(r) => r._id}
          loading={loading}
          empty={
            <EmptyState
              icon={ClipboardList}
              title={debounced || approval !== "all" || from || to ? "No orders match" : "No sales orders yet"}
              description={debounced || approval !== "all" || from || to ? "Try a different search or filter." : "Create an order, approve it, and it moves through production."}
              action={can("Create & Edit") && !debounced && approval === "all" && <Button onClick={() => setEditor({ open: true })}><Plus />New order</Button>}
            />
          }
          actions={(r) => [
            { label: "Approve", icon: Check, onClick: () => approve(r), hidden: !can("Approve") || r.approvalStatus !== "pending" },
            { label: "Edit", icon: Pencil, onClick: () => openEdit(r), hidden: !can("Create & Edit") || r.approvalStatus !== "pending" },
            { label: "Production stages", icon: Workflow, onClick: () => openStages(r), hidden: r.approvalStatus !== "approved" },
            { label: "Record advance", icon: Wallet, onClick: () => openAdvance(r), hidden: !hasPermission("Payments: Record Payment") || r.approvalStatus === "cancelled" },
            { label: "Create invoice", icon: FilePlus2, onClick: () => invoice(r), hidden: !hasPermission("Invoicing: Create & Edit") || r.approvalStatus !== "approved" || r.invoiced },
            { label: "Cancel order", icon: Ban, separated: true, onClick: () => setCancelling(r), hidden: !can("Cancel") || r.approvalStatus === "cancelled" },
            { label: "Delete", icon: Trash2, destructive: true, onClick: () => setDeleting(r), hidden: !can("Delete") || r.approvalStatus === "approved" },
          ]}
          actionsLabel={(r) => `Actions for ${r.orderNumber}`}
          mobile={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3"><span className="font-mono text-[13px] font-semibold text-primary">{r.orderNumber}</span><StatusPill tone={TONE[r.approvalStatus] || "neutral"}>{r.approvalStatus}</StatusPill></div>
              <div className="font-medium">{r.customer}</div>
              <div className="text-xs text-muted-foreground">{r.projectName ? `${r.projectName} · ` : ""}{formatINR(r.total)} · balance {formatINR(r.balance)}</div>
            </div>
          )}
        />
      </DataCard>

      <SalesOrderEditor open={editor.open} onOpenChange={(o) => setEditor((e) => ({ ...e, open: o }))} order={editor.order} onSaved={load} />

      <Dialog open={!!cancelling} onOpenChange={(o) => !o && !busy && setCancelling(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel {cancelling?.orderNumber}?</DialogTitle><DialogDescription>The order stays on record as cancelled. Any advance taken stays on the customer's account.</DialogDescription></DialogHeader>
          <div className="space-y-1"><Label htmlFor="so-cancel">Reason *</Label><Textarea id="so-cancel" rows={2} maxLength={300} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></div>
          <DialogFooter><Button variant="outline" onClick={() => setCancelling(null)} disabled={busy}>Keep order</Button><Button variant="destructive" onClick={doCancel} disabled={busy || !cancelReason.trim()}>{busy && <Loader2 className="animate-spin" />}Cancel order</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.orderNumber}?`} description="Only an order with no invoice, payment or production can be deleted. This can't be undone." confirmLabel="Delete" cancelLabel="Keep" onConfirm={doDelete} />

      <Dialog open={!!advance} onOpenChange={(o) => !o && !busy && setAdvance(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record advance — {advance?.row.orderNumber}</DialogTitle><DialogDescription>Recorded as a payment on the customer's account, linked to this order. Balance now {advance ? formatINR(advance.row.balance) : ""}.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label htmlFor="adv-amt">Amount ₹ *</Label><Input id="adv-amt" type="number" min="0.01" step="0.01" value={advAmount} onChange={(e) => setAdvAmount(e.target.value)} /></div>
            <div className="space-y-1"><Label>Method</Label>
              <Select value={advMethod} onValueChange={setAdvMethod}><SelectTrigger aria-label="Payment method"><SelectValue /></SelectTrigger>
                <SelectContent>{[["cash", "Cash"], ["bank_transfer", "Bank"], ["cheque", "Cheque"], ["upi", "UPI"], ["card", "Card"], ["wallet", "Wallet"]].map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1"><Label htmlFor="adv-ref">Reference</Label><Input id="adv-ref" value={advRef} onChange={(e) => setAdvRef(e.target.value)} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAdvance(null)} disabled={busy}>Cancel</Button><Button onClick={saveAdvance} disabled={busy || !(Number(advAmount) > 0)}>{busy && <Loader2 className="animate-spin" />}Record</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!stages} onOpenChange={(o) => !o && setStages(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Production — {stages?.orderNumber}</DialogTitle><DialogDescription>Stages run in order: design, printing, finishing. A stage the order does not need can be left out.</DialogDescription></DialogHeader>
          <ul className="space-y-2">
            {STAGES.map((s) => {
              const st = stages?.production?.[s] || { required: false, status: "pending" };
              return (
                <li key={s} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                  <div><div className="font-medium capitalize">{s}{!st.required && <span className="ml-2 text-xs font-normal text-muted-foreground">not required</span>}</div><div className="text-xs text-muted-foreground">{st.status.replace("_", " ")}{st.assigneeName ? ` · ${st.assigneeName}` : ""}</div></div>
                  {can("Change Stage") && (
                    <div className="flex gap-1">
                      {st.required && st.status === "pending" && <Button size="sm" onClick={() => stageAct(s, "start")}>Start</Button>}
                      {st.status === "in_progress" && <Button size="sm" onClick={() => stageAct(s, "complete")}>Complete</Button>}
                      {st.status === "pending" && <Button size="sm" variant="outline" onClick={() => stageAct(s, "skip")}>Skip</Button>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <DialogFooter><Button variant="outline" onClick={() => setStages(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
