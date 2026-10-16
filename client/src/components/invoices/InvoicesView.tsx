import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Eye, FileText, IndianRupee, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, MetricBar, Pagination, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column } from "@/components/data";
import { AdvancedCreateInvoiceDialog } from "@/components/invoices/AdvancedCreateInvoiceDialog";
import { ViewInvoiceDialog } from "@/components/invoices/ViewInvoiceDialog";
import { EditInvoiceDialog } from "@/components/invoices/EditInvoiceDialog";
import { InvoicePaymentDialog } from "@/components/invoices/InvoicePaymentDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { dueLabel, fmtDate, formatINR } from "@/lib/format";
import { invoiceState, isInvoiceOverdue as isOverdue } from "@/lib/invoiceStatus";

export interface InvoiceRow {
  _id: string;
  id?: string;
  invoiceNumber: string;
  customerId?: { _id: string; name: string; phone?: string } | null;
  customerName?: string;
  jobId?: { _id: string; title: string } | null;
  jobTitle?: string;
  invoiceDate: string;
  dueDate?: string;
  totalAmount: number;
  paidAmount?: number;
  amountPaid?: number;
  balanceAmount?: number;
  status: "draft" | "sent" | "paid" | "overdue" | "cancelled" | "refunded";
  paymentStatus: "pending" | "partial" | "paid" | "overdue";
  designCharge?: number;
  createdAt: string;
}

type View = "all" | "unpaid" | "overdue" | "paid" | "draft" | "cancelled";
const PAGE_SIZE = 25;

interface ViewStats {
  all: number;
  unpaid: number;
  overdue: number;
  paid: number;
  draft: number;
  cancelled: number;
  outstanding: number;
  overdueAmount: number;
  collected: number;
  invoiced: number;
  invoicedThisMonth: number;
  countThisMonth: number;
}

const customerOf = (i: InvoiceRow) => i.customerId?.name || i.customerName || "—";
const balanceOf = (i: InvoiceRow) => i.balanceAmount ?? Math.max(0, i.totalAmount - (i.paidAmount ?? i.amountPaid ?? 0));

/**
 * The invoice list. There is one kind of invoice — issued without GST — so one
 * list. Views, totals and the list itself come from the server, so every
 * invoice is reachable however many there are.
 */
export function InvoicesView() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ViewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => params.get("q") || "");
  // A search from the header while already on this page arrives as a new ?q.
  const qParam = params.get("q");
  useEffect(() => {
    if (qParam !== null) setSearch(qParam);
  }, [qParam]);
  const q = useDebounced(search.trim());
  // ?view=overdue (e.g. from the dashboard) opens that view.
  const [view, setView] = useState<View>(() => {
    const v = params.get("view");
    return v === "unpaid" || v === "overdue" || v === "paid" || v === "draft" || v === "cancelled" ? v : "all";
  });
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [viewing, setViewing] = useState<InvoiceRow | null>(null);
  const [editing, setEditing] = useState<InvoiceRow | null>(null);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const [deleting, setDeleting] = useState<InvoiceRow | null>(null);

  const canCreate = hasPermission("Invoicing: Create & Edit");
  const canDelete = hasPermission("Invoicing: Delete");
  const canPay = hasPermission("Invoicing: Record Payment");
  const canPdf = hasPermission("Invoicing: Download PDF");

  const loadStats = useCallback(async () => {
    try {
      const res = await apiClient.getInvoiceViewStats();
      setStats((res?.stats as unknown as ViewStats) || null);
    } catch {
      setStats(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE), sortBy: "invoiceDate", sortOrder: "desc" };
      if (q) p.search = q;
      if (view !== "all") p.view = view;
      const res = (await apiClient.getInvoices(p)) as { invoices?: InvoiceRow[]; pagination?: { totalInvoices?: number } };
      setRows((res?.invoices || []).map((i) => ({ ...i, _id: i._id || (i.id as string) })));
      setTotal(res?.pagination?.totalInvoices ?? (res?.invoices || []).length);
    } catch (error) {
      toast({ title: "Invoices could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, q, view, toast]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [q, view]);

  const refresh = () => {
    load();
    loadStats();
  };

  const refreshViewing = async () => {
    refresh();
    if (!viewing) return;
    try {
      const r = (await apiClient.getInvoice(viewing._id)) as { invoice?: InvoiceRow };
      if (r?.invoice) setViewing({ ...r.invoice, _id: r.invoice._id || viewing._id });
    } catch {
      /* the list refresh is enough */
    }
  };

  const download = async (i: InvoiceRow) => {
    try {
      await apiClient.downloadInvoicePDF(i._id);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteInvoice(deleting._id);
      toast({ title: `${deleting.invoiceNumber} deleted` });
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const s = stats;
  const compact = (n = 0) => formatINR(n, { compact: n >= 1e5 });

  const columns: Column<InvoiceRow>[] = [
    {
      id: "number",
      header: "Invoice",
      cell: (i) => (
        <EntityCell title={i.invoiceNumber} mono subtitle={i.jobId?.title || i.jobTitle} />
      ),
      sortValue: (i) => i.invoiceNumber,
      className: "min-w-[170px]"
    },
    {
      id: "customer",
      header: "Customer",
      cell: (i) => <EntityCell avatar={customerOf(i)} title={customerOf(i)} subtitle={i.customerId?.phone} />,
      sortValue: (i) => customerOf(i).toLowerCase(),
      className: "min-w-[200px]"
    },
    { id: "date", header: "Issued", cell: (i) => <span className="whitespace-nowrap">{fmtDate(i.invoiceDate)}</span>, sortValue: (i) => i.invoiceDate, hideBelow: "lg" },
    {
      id: "due",
      header: "Due",
      cell: (i) => (
        <Stack
          top={<span className="whitespace-nowrap">{fmtDate(i.dueDate)}</span>}
          bottom={
            i.paymentStatus !== "paid" && !["draft", "cancelled"].includes(i.status) && i.dueDate ? (
              <span className={isOverdue(i) ? "text-destructive-strong" : undefined}>{dueLabel(i.dueDate)}</span>
            ) : undefined
          }
        />
      ),
      sortValue: (i) => i.dueDate || "",
      hideBelow: "md"
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (i) => (
        <Stack
          top={formatINR(i.totalAmount || 0)}
          bottom={(i.designCharge || 0) > 0 ? <span className="whitespace-nowrap">incl. design {formatINR(i.designCharge || 0)}</span> : undefined}
        />
      ),
      sortValue: (i) => i.totalAmount
    },
    {
      id: "balance",
      header: "Balance",
      align: "right",
      cell: (i) =>
        balanceOf(i) > 0.5 && !["draft", "cancelled"].includes(i.status) ? (
          <span className="font-semibold">{formatINR(balanceOf(i))}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      sortValue: balanceOf
    },
    {
      id: "status",
      header: "Status",
      cell: (i) => {
        const st = invoiceState(i);
        return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
      },
      className: "w-[110px]"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Invoices"
        description="Invoices you've issued — what's been paid and what's still owed."
        actions={
          canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              New invoice
            </Button>
          )
        }
      />

      <MetricBar
        loading={!s}
        metrics={[
          {
            label: "Outstanding",
            value: compact(s?.outstanding),
            hint: `${s?.unpaid || 0} unpaid invoice${s?.unpaid === 1 ? "" : "s"}`,
            tone: (s?.outstanding || 0) > 0 ? "warning" : "success",
            onClick: () => setView(view === "unpaid" ? "all" : "unpaid"),
            active: view === "unpaid"
          },
          {
            label: "Overdue",
            value: compact(s?.overdueAmount),
            hint: s?.overdue ? `${s.overdue} past the due date` : "Nothing overdue",
            tone: s?.overdue ? "danger" : "default",
            onClick: () => setView(view === "overdue" ? "all" : "overdue"),
            active: view === "overdue"
          },
          { label: "Collected", value: compact(s?.collected), hint: `Of ${compact(s?.invoiced)} invoiced`, tone: "success" },
          { label: "This month", value: compact(s?.invoicedThisMonth), hint: `${s?.countThisMonth || 0} invoice${s?.countThisMonth === 1 ? "" : "s"} issued` }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All", count: s?.all },
            { value: "unpaid", label: "Unpaid", count: s?.unpaid },
            { value: "overdue", label: "Overdue", count: s?.overdue, tone: "danger" },
            { value: "paid", label: "Paid", count: s?.paid },
            { value: "draft", label: "Drafts", count: s?.draft },
            { value: "cancelled", label: "Cancelled", count: s?.cancelled }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search invoice no., customer or job" />} />
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="invoices" />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(i) => i._id}
            loading={loading}
            onRowClick={(i) => setViewing(i)}
            actions={(i) => [
              { label: "Open invoice", icon: Eye, onClick: () => setViewing(i) },
              { label: "Edit invoice", icon: Pencil, onClick: () => setEditing(i), hidden: !canCreate || i.status === "cancelled" },
              { label: "Update payment", icon: IndianRupee, onClick: () => setPaying(i), hidden: !canPay || ["draft", "cancelled"].includes(i.status) },
              { label: "Download PDF", icon: Download, onClick: () => download(i), hidden: !canPdf },
              { label: "Delete invoice", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(i), hidden: !canDelete }
            ]}
            actionsLabel={(i) => `Actions for ${i.invoiceNumber}`}
            mobile={(i) => {
              const st = invoiceState(i);
              return (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{customerOf(i)}</span>
                    <span className="num font-semibold">{formatINR(i.totalAmount || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {i.invoiceNumber} · {fmtDate(i.invoiceDate)}
                    </span>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                  </div>
                </div>
              );
            }}
            empty={
              q || view !== "all" ? (
                <EmptyState
                  compact
                  icon={FileText}
                  title="No invoices in this view"
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch("");
                        setView("all");
                      }}
                    >
                      Show all invoices
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={FileText}
                  title="No invoices yet"
                  description="Raise an invoice from a job ticket, or create one here."
                  action={
                    canCreate && (
                      <Button onClick={() => setCreateOpen(true)}>
                        <Plus />
                        New invoice
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <AdvancedCreateInvoiceDialog open={createOpen} onOpenChange={setCreateOpen} onInvoiceCreated={refresh} />
      <ViewInvoiceDialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)} invoice={viewing as never} onInvoiceUpdated={refreshViewing} />
      <EditInvoiceDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} invoice={editing as never} onInvoiceUpdated={refresh} />
      <InvoicePaymentDialog invoice={paying} onOpenChange={(o) => !o && setPaying(null)} onSaved={refresh} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.invoiceNumber}?`}
        description="The invoice is removed permanently. To keep a record instead, cancel it from the invoice."
        onConfirm={remove}
      />
    </PageShell>
  );
}
