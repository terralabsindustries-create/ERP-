import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Eye, FileCheck2, FileDiff, FileText, IndianRupee, Mail, MessageSquare, Pencil, Plus, Printer, Trash2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, MetricBar, Pagination, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { AdvancedCreateInvoiceDialog } from "@/components/invoices/AdvancedCreateInvoiceDialog";
import { ViewInvoiceDialog, type InvoiceSendChannel } from "@/components/invoices/ViewInvoiceDialog";
import { EditInvoiceDialog } from "@/components/invoices/EditInvoiceDialog";
import { CreditNoteDialog } from "@/components/invoices/CreditNoteDialog";
import { GstComplianceDialog } from "@/components/invoices/GstComplianceDialog";
import { InvoicePaymentDialog, type RecordedPaymentReceipt } from "@/components/invoices/InvoicePaymentDialog";
import { InvoicePaymentReconciliation, type InvoicePaymentBreakdown } from "@/components/invoices/InvoicePaymentReconciliation";
import { DocumentSavedDialog } from "@/components/documents/DocumentSavedDialog";
import { BulkSendInvoicesDialog } from "@/components/invoices/BulkSendInvoicesDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { preparePrintingWhenIdle, printOutcomeMessage, printPdf, saveFile } from "@/lib/printPdf";
import { bulkInvoicePdf } from "@/lib/bulkPdf";
import { dueLabel, fmtDate, formatINR } from "@/lib/format";
import { invoiceState, isInvoiceOverdue as isOverdue, isInvoiceSettled } from "@/lib/invoiceStatus";

export interface InvoiceRow {
  _id: string;
  id?: string;
  invoiceNumber: string;
  customerId?: { _id: string; name: string; email?: string; phone?: string } | null;
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
  deliveryStatus?: "delivered" | "part_delivered" | "in_transit" | "scheduled" | "failed" | "ready" | "not_delivered" | "collected" | "untracked";
  deliveryEvidence?: string;
  deliverySource?: "job" | "counter" | "invoice";
  createdAt: string;
}

interface PendingJob {
  _id: string;
  title: string;
  status: string;
  customerId?: { _id: string; name: string } | null;
  items?: unknown[];
  estimatedCost?: number;
  createdAt: string;
}

type View = "all" | "unpaid" | "overdue" | "paid" | "draft" | "cancelled" | "to_invoice";
const PAGE_SIZE = 25;

interface ViewStats extends InvoicePaymentBreakdown {
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
// The job ticket's current title, else the title stored on the invoice (it
// stays after the job ticket is deleted; a counter job's number and description).
const jobOf = (i: InvoiceRow) => i.jobId?.title || i.jobTitle || "";
const balanceOf = (i: InvoiceRow) => i.balanceAmount ?? Math.max(0, i.totalAmount - (i.paidAmount ?? i.amountPaid ?? 0));
const deliveryMeta: Record<NonNullable<InvoiceRow["deliveryStatus"]>, { label: string; tone: PillTone }> = {
  delivered: { label: "Delivered", tone: "success" },
  part_delivered: { label: "Part delivered", tone: "warning" },
  in_transit: { label: "In transit", tone: "info" },
  scheduled: { label: "Scheduled", tone: "info" },
  failed: { label: "Delivery failed", tone: "danger" },
  ready: { label: "Ready", tone: "warning" },
  not_delivered: { label: "Not delivered", tone: "warning" },
  collected: { label: "Collected", tone: "success" },
  untracked: { label: "Not tracked", tone: "neutral" }
};
const deliveryOf = (i: InvoiceRow) => deliveryMeta[i.deliveryStatus || "untracked"];

/**
 * The invoice list. Amounts are invoice totals, including GST. Views, totals
 * and the list itself come from the server, so every invoice is reachable
 * however many there are.
 */
export function InvoicesView() {
  // Rows have Print: load printing in the background so the first print does not wait for it.
  useEffect(preparePrintingWhenIdle, []);
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  // A failed load shows as an error with Retry, never as an empty list.
  const [loadError, setLoadError] = useState<unknown>(null);
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
    return v === "unpaid" || v === "overdue" || v === "paid" || v === "draft" || v === "cancelled" || v === "to_invoice" ? v : "all";
  });
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingJob, setPendingJob] = useState<PendingJob | null>(null);
  const [pendingJobs, setPendingJobs] = useState<PendingJob[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [viewing, setViewing] = useState<InvoiceRow | null>(null);
  // Set when the invoice was opened to send it: the view goes straight to that form.
  const [sendVia, setSendVia] = useState<InvoiceSendChannel | null>(null);
  const [editing, setEditing] = useState<InvoiceRow | null>(null);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const [receipt, setReceipt] = useState<{ payment: RecordedPaymentReceipt; invoiceNumber: string } | null>(null);
  const [deleting, setDeleting] = useState<InvoiceRow | null>(null);
  const [issuing, setIssuing] = useState<InvoiceRow | null>(null);
  const [noting, setNoting] = useState<InvoiceRow | null>(null);
  const [complying, setComplying] = useState<InvoiceRow | null>(null);
  // Selection applies to the current page and resets when its view changes.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [view, page, q]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkSend, setBulkSend] = useState<{ channel: "email" | "whatsapp"; invoices: InvoiceRow[] } | null>(null);
  const selectedRows = rows.filter((row) => selected.has(row._id));
  const issueSelected = async () => {
    const ids = rows.filter((r) => selected.has(r._id) && r.status === "draft").map((r) => r._id);
    if (!ids.length) { toast({ title: "No drafts selected", description: "Only draft invoices can be issued." }); return; }
    setBulkBusy(true);
    try {
      const res = await apiClient.post<{ succeeded: { invoiceNumber: string }[]; failed: { reason: string }[] }>("/invoices-bulk/issue", { ids });
      toast({ title: `${res.succeeded.length} invoice${res.succeeded.length === 1 ? "" : "s"} issued`, description: res.failed.length ? `${res.failed.length} not issued: ${res.failed.map((f) => f.reason).slice(0, 3).join("; ")}` : res.succeeded.map((x) => x.invoiceNumber).join(", "), variant: res.failed.length ? "destructive" : undefined });
      setSelected(new Set());
      refresh();
    } catch (error) {
      toast({ title: "Not issued", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };
  const canNote = hasPermission("Invoicing: Credit & Debit Notes");

  const canCreate = hasPermission("Invoicing: Create & Edit");
  const canDelete = hasPermission("Invoicing: Delete");
  // Receipts are payments (POST /payments); either grant may record one against an invoice.
  const canPay = hasPermission("Payments: Record Payment") || hasPermission("Invoicing: Record Payment");
  const canCorrect = hasPermission("Invoicing: Correct Balance");
  const canPdf = hasPermission("Invoicing: Download PDF");
  const canEmail = hasPermission("Invoicing: Send Email");
  const canWhatsApp = hasPermission("WhatsApp: Send Messages");
  const canUpdateDelivery = hasPermission("Delivery: Update Status");
  const canSelectRows = canCreate || canPdf || canEmail || canWhatsApp;

  const printSelected = async () => {
    if (!selectedRows.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const note = printOutcomeMessage(await printPdf(() => bulkInvoicePdf(selectedRows)), `${selectedRows.length} invoices`);
      if (note) toast(note);
    } catch (error) {
      toast({ title: "Could not print selected invoices", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const downloadSelected = async () => {
    if (!selectedRows.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      saveFile(await bulkInvoicePdf(selectedRows));
    } catch (error) {
      toast({ title: "Could not download selected invoices", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const loadStats = useCallback(async () => {
    try {
      const res = await apiClient.getInvoiceViewStats();
      setStats((res?.stats as unknown as ViewStats) || null);
    } catch {
      setStats(null);
    }
  }, []);

  const load = useCallback(async () => {
    if (view === "to_invoice") return;
    setLoading(true);
    try {
      setLoadError(null);
      const p: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE), sortBy: "invoiceDate", sortOrder: "desc" };
      if (q) p.search = q;
      if (view !== "all") p.view = view;
      const res = (await apiClient.getInvoices(p)) as { invoices?: InvoiceRow[]; pagination?: { totalInvoices?: number } };
      setRows((res?.invoices || []).map((i) => ({ ...i, _id: i._id || (i.id as string) })));
      setTotal(res?.pagination?.totalInvoices ?? (res?.invoices || []).length);
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, [page, q, view, toast]);

  const loadPending = useCallback(async () => {
    if (!canCreate) return;
    setPendingLoading(true);
    try {
      const res = await apiClient.getJobsAwaitingInvoice({
        page: view === "to_invoice" ? page : 1,
        limit: PAGE_SIZE,
        search: view === "to_invoice" ? q : undefined
      });
      setPendingJobs(res.jobs || []);
      setPendingTotal(res.pagination?.totalJobs || 0);
    } catch (error) {
      if (view === "to_invoice") toast({ title: "Jobs awaiting invoice could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setPendingLoading(false);
    }
  }, [canCreate, page, q, view, toast]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadPending();
  }, [loadPending]);
  useEffect(() => setPage(1), [q, view]);

  const refresh = () => {
    load();
    loadStats();
    loadPending();
  };

  const invoiceJob = (job: PendingJob) => {
    setPendingJob(job);
    setCreateOpen(true);
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

  // The same PDF as Download, straight to the print dialog (see lib/printPdf).
  const print = async (i: InvoiceRow) => {
    try {
      const note = printOutcomeMessage(await apiClient.printInvoicePDF(i._id), i.invoiceNumber);
      if (note) toast(note);
    } catch (error) {
      toast({ title: "Could not print", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const send = (i: InvoiceRow, channel: InvoiceSendChannel) => {
    setSendVia(channel);
    setViewing(i);
  };

  const recordStandaloneDelivery = async (i: InvoiceRow, status: "delivered" | "not_delivered") => {
    try {
      await apiClient.patch(`/invoices/${i._id}/fulfillment`, { status });
      toast({ title: `${i.invoiceNumber} marked ${status === "delivered" ? "delivered" : "not delivered"}` });
      refresh();
    } catch (error) {
      toast({ title: "Could not update delivery", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
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

  const issue = async () => {
    if (!issuing) return;
    try {
      const res = await apiClient.issueInvoice(issuing._id);
      // Issuing gives the draft its official number.
      toast({ title: `${res?.invoice?.invoiceNumber || issuing.invoiceNumber} issued`, description: "It now has its official invoice number and counts toward revenue and receivables." });
      refresh();
    } catch (error) {
      toast({ title: "Could not issue invoice", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const s = stats;
  const compact = (n = 0) => formatINR(n, { compact: n >= 1e5 });

  const deliveryColumn: Column<InvoiceRow> = {
    id: "delivery",
    header: "Delivery",
    cell: (i) => {
      const state = deliveryOf(i);
      return <span title={i.deliveryEvidence}><StatusPill tone={state.tone}>{state.label}</StatusPill></span>;
    },
    className: "min-w-[135px]"
  };

  const columns: Column<InvoiceRow>[] = [
    {
      id: "number",
      header: "Invoice",
      cell: (i) => (
        // Every row has a second line, so rows keep one height.
        <EntityCell title={i.invoiceNumber} mono subtitle={jobOf(i) ? <span title={jobOf(i)}>{jobOf(i)}</span> : "No job ticket"} />
      ),
      sortValue: (i) => i.invoiceNumber,
      className: "min-w-[170px]"
    },
    {
      id: "customer",
      header: "Customer",
      cell: (i) => <EntityCell avatar={customerOf(i)} title={customerOf(i)} subtitle={i.customerId?.phone || "No phone number"} />,
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
            !isInvoiceSettled(i) && !["draft", "cancelled"].includes(i.status) && i.dueDate ? (
              <span className={isOverdue(i) ? "text-destructive-strong" : undefined}>{dueLabel(i.dueDate)}</span>
            ) : undefined
          }
        />
      ),
      sortValue: (i) => i.dueDate || "",
      hideBelow: "md"
    },
    ...(view === "unpaid" ? [deliveryColumn] : []),
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
        description="Track issued invoices and jobs waiting to be invoiced."
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
          { label: "Paid against invoices", value: compact(s?.collected), hint: `${compact(s?.recordedOnInvoices)} receipts · ${compact(s?.recordedOutsidePayments)} direct`, tone: "success" },
          { label: "This month", value: compact(s?.invoicedThisMonth), hint: `${s?.countThisMonth || 0} invoice${s?.countThisMonth === 1 ? "" : "s"} issued` }
        ]}
      />

      <InvoicePaymentReconciliation breakdown={s} />

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
            ...(canCreate ? [{ value: "to_invoice" as const, label: "To invoice", count: pendingTotal, tone: "warning" as const }] : []),
            { value: "cancelled", label: "Cancelled", count: s?.cancelled }
          ]}
        />

        <DataCard
          toolbar={<Toolbar search={<SearchField value={search} onChange={setSearch} placeholder={view === "to_invoice" ? "Search job title" : "Search invoice no., customer or job"} />} />}
          footer={view === "to_invoice"
            ? (!pendingLoading && pendingTotal > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={pendingTotal} onPageChange={setPage} noun="jobs" />)
            : (!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="invoices" />)}
        >
          {view === "to_invoice" ? (
            <DataTable
              columns={[
                { id: "job", header: "Job", cell: (j: PendingJob) => <EntityCell title={j.title} subtitle={`${j.items?.length || 0} item${j.items?.length === 1 ? "" : "s"}`} />, sortValue: (j: PendingJob) => j.title },
                { id: "customer", header: "Customer", cell: (j: PendingJob) => j.customerId?.name || "—", sortValue: (j: PendingJob) => j.customerId?.name || "" },
                { id: "created", header: "Created", cell: (j: PendingJob) => fmtDate(j.createdAt), hideBelow: "md" as const },
                { id: "action", header: "", cell: (j: PendingJob) => <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); invoiceJob(j); }}>Create invoice</Button> }
              ]}
              rows={pendingJobs}
              rowKey={(j) => j._id}
              loading={pendingLoading}
              onRowClick={invoiceJob}
              mobile={(j) => <div className="flex items-center justify-between gap-3"><span className="truncate font-medium">{j.title}</span><span className="text-xs text-muted-foreground">{j.customerId?.name || "—"}</span></div>}
              empty={<EmptyState icon={FileText} title={q ? "No matching jobs" : "No jobs awaiting invoice"} description={q ? undefined : "Jobs you skip at creation appear here until an invoice is raised."} />}
            />
          ) : (
          <>
          {selectedRows.length > 0 && (
            <div className="m-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs" role="region" aria-label="Bulk actions">
              <span className="font-medium">{selectedRows.length} selected</span>
              {canCreate && view === "draft" && <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={issueSelected}>Issue selected drafts</Button>}
              {canPdf && <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={printSelected}><Printer className="mr-1 h-3.5 w-3.5" />Print selected</Button>}
              {canPdf && <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={downloadSelected}><Download className="mr-1 h-3.5 w-3.5" />Download selected</Button>}
              {canEmail && <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={() => setBulkSend({ channel: "email", invoices: selectedRows })}><Mail className="mr-1 h-3.5 w-3.5" />Send email</Button>}
              {canWhatsApp && <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={() => setBulkSend({ channel: "whatsapp", invoices: selectedRows })}><MessageSquare className="mr-1 h-3.5 w-3.5" />Send WhatsApp</Button>}
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}
          <DataTable
            error={loadError}
            onRetry={() => load()}
            selectable={canSelectRows}
            selected={selected}
            onSelectedChange={setSelected}
            columns={columns}
            rows={rows}
            rowKey={(i) => i._id}
            loading={loading}
            onRowClick={(i) => {
              setSendVia(null);
              setViewing(i);
            }}
            actions={(i) => [
              { label: "Open invoice", icon: Eye, onClick: () => { setSendVia(null); setViewing(i); } },
              // Issued invoices are tax documents: corrected with a credit/debit note, not edited.
              { label: "Edit invoice", icon: Pencil, onClick: () => setEditing(i), hidden: !canCreate || i.status !== "draft" },
              { label: "Credit / debit note", icon: FileDiff, onClick: () => setNoting(i), hidden: !canNote || ["draft", "cancelled"].includes(i.status) },
              { label: "E-invoice / e-way bill", icon: FileCheck2, onClick: () => setComplying(i), hidden: ["draft", "cancelled"].includes(i.status) },
              { label: "Issue invoice", icon: FileCheck2, onClick: () => setIssuing(i), hidden: !canCreate || i.status !== "draft" },
              {
                label: balanceOf(i) > 0 && canPay ? "Record payment" : "Correct balance",
                icon: IndianRupee,
                onClick: () => setPaying(i),
                hidden: ["draft", "cancelled"].includes(i.status) || !((canPay && balanceOf(i) > 0) || canCorrect)
              },
              { label: "Mark delivered", icon: Truck, onClick: () => recordStandaloneDelivery(i, "delivered"), hidden: view !== "unpaid" || !canUpdateDelivery || i.deliverySource !== "invoice" || i.deliveryStatus === "delivered" },
              { label: "Mark not delivered", icon: Truck, onClick: () => recordStandaloneDelivery(i, "not_delivered"), hidden: view !== "unpaid" || !canUpdateDelivery || i.deliverySource !== "invoice" || i.deliveryStatus === "not_delivered" },
              { label: "Print", icon: Printer, onClick: () => print(i), hidden: !canPdf, separated: true },
              { label: "Download PDF", icon: Download, onClick: () => download(i), hidden: !canPdf },
              { label: "Send by email", icon: Mail, onClick: () => send(i, "email"), hidden: !canEmail },
              { label: "Send on WhatsApp", icon: MessageSquare, onClick: () => send(i, "whatsapp"), hidden: !canWhatsApp },
              { label: "Delete draft", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(i), hidden: !canDelete || i.status !== "draft" }
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
                  {view === "unpaid" && (
                    <div title={i.deliveryEvidence} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Delivery</span>
                      <StatusPill tone={deliveryOf(i).tone}>{deliveryOf(i).label}</StatusPill>
                    </div>
                  )}
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
          </>
          )}
        </DataCard>
      </div>

      <AdvancedCreateInvoiceDialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) setPendingJob(null); }} preselectedJob={pendingJob} onInvoiceCreated={refresh} />
      {bulkSend && <BulkSendInvoicesDialog channel={bulkSend.channel} invoices={bulkSend.invoices} onClose={() => setBulkSend(null)} onSent={refresh} />}
      <CreditNoteDialog invoice={noting} onOpenChange={(o) => !o && setNoting(null)} onChanged={refresh} />
      <GstComplianceDialog invoice={complying} onOpenChange={(o) => !o && setComplying(null)} />
      <ViewInvoiceDialog
        open={!!viewing}
        onOpenChange={(o) => {
          if (o) return;
          setViewing(null);
          setSendVia(null);
        }}
        invoice={viewing as never}
        sendVia={sendVia}
        onInvoiceUpdated={refreshViewing}
      />
      <EditInvoiceDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} invoice={editing as never} onInvoiceUpdated={refresh} />
      <InvoicePaymentDialog
        invoice={paying}
        startWith={paying && !(canPay && balanceOf(paying) > 0) ? "correct" : "record"}
        onOpenChange={(o) => !o && setPaying(null)}
        onSaved={(payment) => {
          refresh();
          if (payment) setReceipt({ payment, invoiceNumber: paying?.invoiceNumber || "Invoice" });
          setPaying(null);
        }}
      />
      {receipt && (
        <DocumentSavedDialog
          open
          onOpenChange={(open) => { if (!open) setReceipt(null); }}
          title="Payment recorded"
          details={[
            { label: "Receipt no.", value: receipt.payment.paymentId, mono: true },
            { label: "Invoice", value: receipt.invoiceNumber, mono: true },
            { label: "Amount received", value: formatINR(receipt.payment.amount), strong: true }
          ]}
          documentKey={receipt.payment._id}
          documentName={`Receipt ${receipt.payment.paymentId}`}
          loadPdf={(signal) => apiClient.getPaymentReceiptPdfFile(receipt.payment._id, receipt.payment.paymentId, signal)}
        />
      )}
      <ConfirmDialog
        open={!!issuing}
        onOpenChange={(o) => !o && setIssuing(null)}
        title={`Issue ${issuing?.invoiceNumber}?`}
        description="This moves the draft into issued invoices and includes its amount in dashboard revenue and receivables."
        confirmLabel="Issue invoice"
        cancelLabel="Keep draft"
        destructive={false}
        onConfirm={issue}
      />
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
