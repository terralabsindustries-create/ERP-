import { useCallback, useEffect, useState } from "react";
import { CheckCircle, CreditCard, Plus, RotateCcw, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { CreatePaymentDialog } from "@/components/payments/CreatePaymentDialog";
import { METHOD_LABELS, STATUS_META, invoiceNumberOf, type PaymentRecord, type PaymentStatus, type PaymentSummary } from "@/components/payments/paymentMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, plural } from "@/lib/format";

const PAGE_SIZE = 25;

interface PaymentsResponse {
  payments: PaymentRecord[];
  /** Per status, over the search and method filter (not the status view). */
  summary: PaymentSummary;
  pagination: { current: number; total: number; totalPayments: number };
}

const TONE: Record<PaymentStatus, PillTone> = { completed: "success", pending: "warning", failed: "danger", cancelled: "neutral", refunded: "info" };
const LABEL: Record<PaymentStatus, string> = { completed: "Received", pending: "Pending", failed: "Failed", cancelled: "Cancelled", refunded: "Refunded" };
type View = PaymentStatus | "all";

export default function Payments() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canRecord = hasPermission("Payments: Record Payment");
  const canDelete = hasPermission("Payments: Delete");
  const [data, setData] = useState<PaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [view, setView] = useState<View>("all");
  const [method, setMethod] = useState("all");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<PaymentRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE) };
      if (q) p.search = q;
      if (view !== "all") p.status = view;
      if (method !== "all") p.paymentMethod = method;
      setData((await apiClient.getPayments(p)) as PaymentsResponse);
    } catch (error) {
      toast({ title: "Payments could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, q, view, method, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [q, view, method]);

  const setStatus = async (p: PaymentRecord, status: PaymentStatus) => {
    try {
      await apiClient.updatePayment(p._id, { status });
      toast({ title: `Payment marked ${STATUS_META[status].label.toLowerCase()}` });
      load();
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deletePayment(deleting._id);
      toast({ title: "Payment deleted", description: invoiceNumberOf(deleting) ? `${invoiceNumberOf(deleting)}'s balance was updated.` : undefined });
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const s = data?.summary;
  const rows = data?.payments || [];
  const total = data?.pagination.totalPayments || 0;
  const amt = (n = 0) => formatINR(n, { compact: n >= 1e5 });
  const customerOf = (p: PaymentRecord) => p.customerName || (typeof p.customerId === "object" && p.customerId ? p.customerId.name : "—");

  const columns: Column<PaymentRecord>[] = [
    { id: "date", header: "Date", cell: (p) => <span className="whitespace-nowrap">{fmtDate(p.paymentDate)}</span>, sortValue: (p) => p.paymentDate, className: "w-[120px]" },
    {
      id: "customer",
      header: "Customer",
      cell: (p) => <EntityCell avatar={customerOf(p)} title={customerOf(p)} subtitle={<span className="font-mono">{p.paymentId}</span>} />,
      sortValue: (p) => customerOf(p).toLowerCase(),
      className: "min-w-[220px]"
    },
    {
      id: "invoice",
      header: "Invoice",
      cell: (p) => (invoiceNumberOf(p) ? <span className="font-mono text-[13px]">{invoiceNumberOf(p)}</span> : <span className="text-muted-foreground">On account</span>),
      hideBelow: "md"
    },
    { id: "method", header: "Method", cell: (p) => METHOD_LABELS[p.paymentMethod] || p.paymentMethod, sortValue: (p) => p.paymentMethod, hideBelow: "lg" },
    {
      id: "ref",
      header: "Reference",
      cell: (p) => <span className="block max-w-[180px] truncate text-muted-foreground">{p.referenceNumber || "—"}</span>,
      hideBelow: "xl"
    },
    { id: "amount", header: "Amount", align: "right", cell: (p) => <span className="font-semibold">{formatINR(p.amount)}</span>, sortValue: (p) => p.amount },
    { id: "status", header: "Status", cell: (p) => <StatusPill tone={TONE[p.status]}>{LABEL[p.status]}</StatusPill>, className: "w-[110px]" }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Payments"
        description="Money received from customers and the invoices it was set against."
        actions={
          canRecord && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              Record payment
            </Button>
          )
        }
      />

      <MetricBar
        loading={!data}
        metrics={[
          { label: "Received", value: amt(s?.completed.amount), hint: plural(s?.completed.count || 0, "payment"), tone: "success", onClick: () => setView(view === "completed" ? "all" : "completed"), active: view === "completed" },
          {
            label: "Pending",
            value: amt(s?.pending.amount),
            hint: s?.pending.count ? `${s.pending.count} awaiting clearance` : "Nothing pending",
            tone: s?.pending.count ? "warning" : "default",
            onClick: () => setView(view === "pending" ? "all" : "pending"),
            active: view === "pending"
          },
          {
            label: "Failed",
            value: amt(s?.failed.amount),
            hint: `${s?.failed.count || 0} bounced or failed`,
            tone: s?.failed.count ? "danger" : "default",
            onClick: () => setView(view === "failed" ? "all" : "failed"),
            active: view === "failed"
          },
          { label: "Refunded", value: amt(s?.refunded.amount), hint: plural(s?.refunded.count || 0, "payment") }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All", count: s?.all.count },
            { value: "completed", label: "Received", count: s?.completed.count },
            { value: "pending", label: "Pending", count: s?.pending.count, tone: "warning" },
            { value: "failed", label: "Failed", count: s?.failed.count, tone: "danger" },
            { value: "refunded", label: "Refunded", count: s?.refunded.count },
            { value: "cancelled", label: "Cancelled", count: s?.cancelled.count }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search customer, invoice, payment no. or reference" />}>
              <FilterSelect label="Method" value={method} onChange={setMethod} options={Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
            </Toolbar>
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="payments" />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(p) => p._id}
            loading={loading}
            actions={(p) => [
              { label: "Mark received", icon: CheckCircle, onClick: () => setStatus(p, "completed"), hidden: !canRecord || p.status === "completed" },
              { label: "Mark failed (bounced)", icon: XCircle, onClick: () => setStatus(p, "failed"), hidden: !canRecord || p.status !== "completed" },
              { label: "Mark refunded", icon: RotateCcw, onClick: () => setStatus(p, "refunded"), hidden: !canRecord || p.status !== "completed" },
              { label: "Delete payment", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(p), hidden: !canDelete }
            ]}
            actionsLabel={(p) => `Actions for ${p.paymentId}`}
            mobile={(p) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{customerOf(p)}</span>
                  <span className="num font-semibold">{formatINR(p.amount)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {fmtDate(p.paymentDate)} · {METHOD_LABELS[p.paymentMethod] || p.paymentMethod}
                    {invoiceNumberOf(p) ? ` · ${invoiceNumberOf(p)}` : ""}
                  </span>
                  <StatusPill tone={TONE[p.status]}>{LABEL[p.status]}</StatusPill>
                </div>
              </div>
            )}
            empty={
              q || view !== "all" || method !== "all" ? (
                <EmptyState compact icon={CreditCard} title="No payments in this view" description="Try another search, status or method." />
              ) : (
                <EmptyState
                  icon={CreditCard}
                  title="No payments recorded yet"
                  description="Payments you record against invoices appear here, and update the invoice's balance."
                  action={
                    canRecord && (
                      <Button onClick={() => setCreateOpen(true)}>
                        <Plus />
                        Record payment
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <CreatePaymentDialog open={createOpen} onOpenChange={setCreateOpen} onPaymentCreated={load} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this payment?"
        description={
          deleting
            ? `${formatINR(deleting.amount)} from ${customerOf(deleting)}.${invoiceNumberOf(deleting) && deleting.status === "completed" ? ` ${invoiceNumberOf(deleting)} will show this amount as due again.` : ""}`
            : undefined
        }
        onConfirm={remove}
      />
    </PageShell>
  );
}
