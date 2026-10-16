import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  ClipboardCheck,
  Download,
  Eye,
  MessageCircle,
  PackageCheck,
  Pencil,
  Phone,
  Play,
  Plus,
  Receipt,
  RotateCcw,
  Store,
  Trash2,
  Undo2,
  UserRoundCog,
  CheckCircle2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type RowAction } from "@/components/data";
import { CounterBillingDialog } from "@/components/walkIn/CounterBillingDialog";
import { CounterJobEditor } from "@/components/walkIn/CounterJobEditor";
import { AssignOperatorDialog, QualityCheckDialog, ReadyDialog } from "@/components/walkIn/JobActionDialogs";
import { JobDetailSheet } from "@/components/walkIn/JobDetailSheet";
import { JobQueueBoard, type PrimaryAction } from "@/components/walkIn/JobQueueBoard";
import {
  INVOICE_PAYMENT_META,
  JOB_TYPE_LABEL,
  PRIORITY_META,
  STATUS_META,
  errorText,
  fmtDuration,
  fmtPhone,
  fmtWhen,
  isBilled,
  operatorName,
  promiseLabel,
  readyWhatsAppLink,
  telLink
} from "@/components/walkIn/counterJobMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { counterJobsApi, type CounterJob, type CounterListParams, type CounterListResponse, type CounterStats, type CounterStatus, type Operator } from "@/lib/api/walkIn";
import { formatINR, plural } from "@/lib/format";

const PAGE_SIZE = 25;
type View = "board" | "overdue" | "ready" | "unbilled" | "collected" | "cancelled" | "all";

const STATUS_TOAST: Record<CounterStatus, (j: CounterJob) => string> = {
  waiting: (j) => `${j.jobNumber} is waiting`,
  in_progress: (j) => `${j.jobNumber} started`,
  quality_check: (j) => `${j.jobNumber} sent to quality check`,
  ready: (j) => `${j.jobNumber} is ready for pickup`,
  collected: (j) => `${j.jobNumber} collected`,
  cancelled: (j) => `${j.jobNumber} cancelled`
};

export default function WalkInJobs() {
  const { hasPermission, user } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Walk-In Jobs: Create & Edit");
  const canBill = canEdit && hasPermission("Invoicing: Create & Edit");
  const canSeeInvoices = hasPermission("Invoicing");
  const businessName = user?.companyName;

  const [stats, setStats] = useState<CounterStats | null>(null);
  const [view, setView] = useState<View>("board");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [jobType, setJobType] = useState("all");
  const [priority, setPriority] = useState("all");
  const [operator, setOperator] = useState("all");
  const [page, setPage] = useState(1);
  const [boardJobs, setBoardJobs] = useState<CounterJob[]>([]);
  const [list, setList] = useState<CounterListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [operators, setOperators] = useState<Operator[]>([]);

  const [editor, setEditor] = useState<{ open: boolean; job: CounterJob | null }>({ open: false, job: null });
  const [detail, setDetail] = useState<CounterJob | null>(null);
  const [assigning, setAssigning] = useState<CounterJob | null>(null);
  const [checking, setChecking] = useState<CounterJob | null>(null);
  const [notifying, setNotifying] = useState<CounterJob | null>(null);
  const [billing, setBilling] = useState<CounterJob | null>(null);
  const [cancelling, setCancelling] = useState<CounterJob | null>(null);
  const [deleting, setDeleting] = useState<CounterJob | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await counterJobsApi.stats());
    } catch (error) {
      toast({ title: "Counter figures could not be loaded", description: errorText(error), variant: "destructive" });
    }
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters: CounterListParams = { search: q || undefined, jobType, priority, operator };
      if (view === "board") {
        setBoardJobs(await counterJobsApi.listAll({ ...filters, view: "active" }));
      } else {
        const sort: Pick<CounterListParams, "sortBy" | "sortOrder"> = view === "overdue" || view === "ready" ? { sortBy: "promisedAt", sortOrder: "asc" } : { sortBy: "createdAt", sortOrder: "desc" };
        setList(await counterJobsApi.list({ ...filters, ...sort, view, page, limit: PAGE_SIZE }));
      }
    } catch (error) {
      toast({ title: "Counter jobs could not be loaded", description: errorText(error), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [view, q, jobType, priority, operator, page, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadStats();
    counterJobsApi
      .operators()
      .then(setOperators)
      .catch(() => setOperators([]));
  }, [loadStats]);
  useEffect(() => setPage(1), [view, q, jobType, priority, operator]);

  const refresh = () => {
    load();
    loadStats();
  };

  /** After any change: refresh the lists, keep the open detail current, and offer to tell the customer once it's ready. */
  const changed = (before: CounterJob, after: CounterJob) => {
    setDetail((d) => (d && d._id === after._id ? after : d));
    if (after.status === "ready" && before.status !== "ready") setNotifying(after);
    refresh();
  };

  const act = async (job: CounterJob, run: () => Promise<CounterJob>, title: (j: CounterJob) => string) => {
    try {
      const after = await run();
      toast({ title: title(after) });
      changed(job, after);
    } catch (error) {
      toast({ title: "Not updated", description: errorText(error), variant: "destructive" });
      throw error;
    }
  };

  const move = (job: CounterJob, to: CounterStatus, note?: string) => act(job, () => counterJobsApi.setStatus(job._id, to, note), STATUS_TOAST[to]).catch(() => undefined);

  const downloadInvoice = async (job: CounterJob) => {
    const id = job.billing?.invoice?._id;
    if (!id) return;
    try {
      await apiClient.downloadInvoicePDF(id);
    } catch (error) {
      toast({ title: "Invoice could not be downloaded", description: errorText(error), variant: "destructive" });
    }
  };

  const primary = (job: CounterJob): PrimaryAction | null => {
    if (!canEdit) return null;
    const bill = { label: "Bill", icon: Receipt, run: () => setBilling(job), variant: "default" as const };
    switch (job.status) {
      case "waiting":
        return { label: "Start", icon: Play, run: () => move(job, "in_progress") };
      case "in_progress":
        return { label: "Send to QC", icon: ClipboardCheck, run: () => move(job, "quality_check") };
      case "quality_check":
        return { label: "Record check", icon: ClipboardCheck, run: () => setChecking(job), variant: "default" };
      case "ready":
        return !isBilled(job) && canBill ? bill : { label: "Mark collected", icon: PackageCheck, run: () => move(job, "collected"), variant: "success" };
      case "collected":
        return !isBilled(job) && canBill ? bill : null;
      default:
        return null;
    }
  };

  const actions = (job: CounterJob): RowAction[] => {
    const s = job.status;
    const open = s !== "collected" && s !== "cancelled";
    const billed = isBilled(job);
    return [
      { label: "View details", icon: Eye, onClick: () => setDetail(job) },
      { label: "Edit", icon: Pencil, onClick: () => setEditor({ open: true, job }), hidden: !canEdit },
      { label: "Start", icon: Play, onClick: () => move(job, "in_progress"), hidden: !canEdit || s !== "waiting", separated: true },
      { label: "Send to quality check", icon: ClipboardCheck, onClick: () => move(job, "quality_check"), hidden: !canEdit || s !== "in_progress", separated: true },
      { label: "Mark ready (skip check)", icon: CheckCircle2, onClick: () => move(job, "ready"), hidden: !canEdit || s !== "in_progress" },
      { label: "Back to waiting", icon: Undo2, onClick: () => move(job, "waiting"), hidden: !canEdit || s !== "in_progress" },
      { label: "Record quality check", icon: ClipboardCheck, onClick: () => setChecking(job), hidden: !canEdit || s !== "quality_check", separated: true },
      { label: "Bill job", icon: Receipt, onClick: () => setBilling(job), hidden: !canBill || billed || (s !== "ready" && s !== "collected"), separated: true },
      { label: "Mark collected", icon: PackageCheck, onClick: () => move(job, "collected"), hidden: !canEdit || s !== "ready" },
      { label: "Send back to production", icon: Undo2, onClick: () => move(job, "in_progress"), hidden: !canEdit || s !== "ready" },
      { label: "Move back to ready", icon: Undo2, onClick: () => move(job, "ready"), hidden: !canEdit || s !== "collected" },
      { label: "Reopen", icon: RotateCcw, onClick: () => move(job, "waiting"), hidden: !canEdit || s !== "cancelled" },
      { label: "WhatsApp customer", icon: MessageCircle, onClick: () => window.open(readyWhatsAppLink(job, businessName), "_blank", "noopener,noreferrer"), hidden: s !== "ready", separated: true },
      { label: "Call customer", icon: Phone, onClick: () => window.location.assign(telLink(job.customerPhone)), separated: s !== "ready" },
      { label: "Assign operator", icon: UserRoundCog, onClick: () => setAssigning(job), hidden: !canEdit || !open },
      { label: "Download invoice", icon: Download, onClick: () => downloadInvoice(job), hidden: !canSeeInvoices || !job.billing?.invoice },
      { label: "Cancel job", icon: Ban, destructive: true, separated: true, onClick: () => setCancelling(job), hidden: !canEdit || !open || billed },
      { label: "Delete", icon: Trash2, destructive: true, separated: !open || billed, onClick: () => setDeleting(job), hidden: !canEdit || billed }
    ];
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await counterJobsApi.remove(deleting._id);
      toast({ title: `${deleting.jobNumber} deleted` });
      if (detail?._id === deleting._id) setDetail(null);
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: errorText(error), variant: "destructive" });
      throw error;
    }
  };

  const cancel = async () => {
    if (!cancelling) return;
    await act(cancelling, () => counterJobsApi.setStatus(cancelling._id, "cancelled"), STATUS_TOAST.cancelled);
    setCancelling(null);
  };

  const c = stats?.counts;
  const filtered = !!q || jobType !== "all" || priority !== "all" || operator !== "all";
  const rows = list?.jobs || [];
  const total = list?.pagination.totalJobs || 0;
  const turnaround =
    stats && stats.avgTurnaroundMinutes !== null
      ? `Average turnaround ${fmtDuration(stats.avgTurnaroundMinutes)}, taken to ready, over ${plural(stats.turnaroundSample, "job")} in the last 30 days`
      : "Average turnaround shows once jobs are finished";

  const amountCell = (j: CounterJob) => {
    const inv = j.billing?.invoice;
    if (inv) return <Stack top={<span className="font-semibold">{formatINR(inv.totalAmount)}</span>} bottom={<span className="font-mono">{inv.invoiceNumber}</span>} />;
    if (j.billing?.invoiceNumber) return <Stack top={formatINR(j.billing.amount || 0)} bottom={<span className="font-mono">{j.billing.invoiceNumber}</span>} />;
    return j.pricing.estimatedCost ? <Stack top={formatINR(j.pricing.estimatedCost)} bottom="Estimate" /> : <span className="text-muted-foreground">—</span>;
  };

  const statusCell = (j: CounterJob) => (
    <div className="flex flex-wrap items-center gap-1">
      <StatusPill tone={STATUS_META[j.status].tone}>{STATUS_META[j.status].label}</StatusPill>
      {j.isOverdue && <StatusPill tone="danger">Overdue</StatusPill>}
      {j.billing?.invoice && j.billing.invoice.paymentStatus !== "paid" && (
        <StatusPill tone={INVOICE_PAYMENT_META[j.billing.invoice.paymentStatus]?.tone || "warning"}>{INVOICE_PAYMENT_META[j.billing.invoice.paymentStatus]?.label}</StatusPill>
      )}
    </div>
  );

  const columns: Column<CounterJob>[] = [
    {
      id: "job",
      header: "Job",
      cell: (j) => <Stack top={<span className="font-mono text-[13px]">{j.jobNumber}</span>} bottom={JOB_TYPE_LABEL[j.jobType]} />,
      sortValue: (j) => j.jobNumber,
      className: "w-[150px]"
    },
    {
      id: "customer",
      header: "Customer",
      cell: (j) => <EntityCell avatar={j.customerName} title={j.customerName} subtitle={fmtPhone(j.customerPhone)} />,
      sortValue: (j) => j.customerName.toLowerCase(),
      className: "min-w-[200px]"
    },
    {
      id: "what",
      header: "What",
      cell: (j) => <span className="block max-w-[260px] truncate" title={j.description}>{j.description}</span>,
      hideBelow: "lg"
    },
    {
      id: "promised",
      header: "Promised",
      cell: (j) => (
        <Stack
          top={<span className="whitespace-nowrap">{fmtWhen(j.timeline.estimatedCompletion)}</span>}
          bottom={j.isOverdue ? <span className="text-destructive-strong">{promiseLabel(j)}</span> : promiseLabel(j) || (j.timeline.priority !== "medium" ? PRIORITY_META[j.timeline.priority].label : undefined)}
        />
      ),
      sortValue: (j) => j.timeline.estimatedCompletion,
      hideBelow: "md"
    },
    { id: "operator", header: "Operator", cell: (j) => operatorName(j) || <span className="text-muted-foreground">Not assigned</span>, sortValue: (j) => operatorName(j), hideBelow: "xl" },
    { id: "amount", header: "Amount", align: "right", cell: amountCell, sortValue: (j) => j.billing?.invoice?.totalAmount ?? j.pricing.estimatedCost },
    { id: "status", header: "Status", cell: statusCell, sortValue: (j) => j.status, className: "w-[170px]" }
  ];

  const newJob = canEdit && (
    <Button onClick={() => setEditor({ open: true, job: null })}>
      <Plus />
      New job
    </Button>
  );

  return (
    <PageShell>
      <PageHeader
        eyebrow="Production"
        title="Counter jobs"
        description="Walk-in work taken at the front counter — made while the customer waits or the same day, then billed and collected."
        actions={newJob}
      />

      <MetricBar
        loading={!stats}
        metrics={[
          { label: "Jobs today", value: stats?.todayJobs ?? 0, hint: `${plural(stats?.collectedToday || 0, "job")} collected today` },
          {
            label: "In queue",
            value: stats?.inQueue ?? 0,
            hint: stats?.overdue ? `${stats.overdue} past the promised time` : "Nothing overdue",
            tone: stats?.overdue ? "danger" : "default",
            onClick: () => setView(stats?.overdue && view === "board" ? "overdue" : "board"),
            active: view === "board" || view === "overdue"
          },
          {
            label: "Ready for pickup",
            value: stats?.readyForPickup ?? 0,
            hint: stats?.unbilled ? `${stats.unbilled} not billed yet` : "All billed",
            tone: stats?.readyForPickup ? "success" : "default",
            onClick: () => setView(view === "ready" ? "board" : "ready"),
            active: view === "ready"
          },
          {
            label: "Billed today",
            value: formatINR(stats?.billedToday || 0, { compact: (stats?.billedToday || 0) >= 1e5 }),
            hint: plural(stats?.billedTodayCount || 0, "invoice"),
            tone: stats?.billedToday ? "info" : "default"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "board", label: "Queue", count: c ? c.queue + c.ready : undefined },
            { value: "overdue", label: "Overdue", count: stats?.overdue, tone: "danger" },
            { value: "ready", label: "Ready for pickup", count: c?.ready },
            { value: "unbilled", label: "Not billed", count: stats?.unbilled, tone: "warning" },
            { value: "collected", label: "Collected", count: c?.collected },
            { value: "cancelled", label: "Cancelled", count: c?.cancelled },
            { value: "all", label: "All jobs", count: c?.all }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search job, customer or phone" />}>
              <FilterSelect label="Type" value={jobType} onChange={setJobType} options={Object.entries(JOB_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
              <FilterSelect label="Priority" value={priority} onChange={setPriority} options={(["urgent", "high", "medium", "low"] as const).map((p) => ({ value: p, label: PRIORITY_META[p].label }))} />
              <FilterSelect
                label="Operator"
                value={operator}
                onChange={setOperator}
                options={[{ value: "unassigned", label: "Not assigned" }, ...operators.map((o) => ({ value: o._id, label: o.fullName }))]}
              />
            </Toolbar>
          }
          footer={
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{turnaround}</span>
              {view !== "board" && !loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="jobs" />}
            </div>
          }
        >
          {view === "board" ? (
            !loading && boardJobs.length === 0 ? (
              filtered ? (
                <EmptyState compact icon={Store} title="No jobs in the queue match" description="Try another search or filter." />
              ) : (
                <EmptyState icon={Store} title="The counter queue is clear" description="Jobs taken at the counter show here until they're collected." action={newJob} />
              )
            ) : (
              <JobQueueBoard jobs={boardJobs} loading={loading} actions={actions} primary={primary} onOpen={setDetail} />
            )
          ) : (
            <DataTable<CounterJob>
              columns={columns}
              rows={rows}
              rowKey={(j) => j._id}
              loading={loading}
              onRowClick={(j) => setDetail(j)}
              actions={actions}
              actionsLabel={(j) => `Actions for ${j.jobNumber}`}
              mobile={(j) => (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{j.customerName}</span>
                    <span className="num shrink-0 text-sm">{amountCell(j)}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    <span className="font-mono">{j.jobNumber}</span> · {j.description}
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className={j.isOverdue ? "text-destructive-strong" : undefined}>{promiseLabel(j) || fmtWhen(j.createdAt)}</span>
                    {statusCell(j)}
                  </div>
                </div>
              )}
              empty={
                filtered || view !== "all" ? (
                  <EmptyState compact icon={Store} title="No jobs in this view" description="Try another view, search or filter." />
                ) : (
                  <EmptyState icon={Store} title="No counter jobs yet" description="Take the first walk-in job — it joins the queue as waiting." action={newJob} />
                )
              }
            />
          )}
        </DataCard>
      </div>

      <CounterJobEditor
        open={editor.open}
        job={editor.job}
        onOpenChange={(o) => setEditor((e) => ({ ...e, open: o }))}
        onSaved={(saved, created) => {
          setDetail((d) => (d && d._id === saved._id ? saved : d));
          if (created && view !== "board" && view !== "all") setView("board");
          refresh();
        }}
      />
      <JobDetailSheet
        job={detail}
        onOpenChange={(o) => !o && setDetail(null)}
        primary={detail ? primary(detail) : null}
        onEdit={canEdit && detail ? () => setEditor({ open: true, job: detail }) : undefined}
        businessName={businessName}
      />
      <AssignOperatorDialog
        job={assigning}
        operators={operators}
        onOpenChange={(o) => !o && setAssigning(null)}
        onAssign={(job, operatorId) => act(job, () => counterJobsApi.assign(job._id, operatorId), (j) => (operatorName(j) ? `${j.jobNumber} assigned to ${operatorName(j)}` : `${j.jobNumber} unassigned`))}
      />
      <QualityCheckDialog
        job={checking}
        onOpenChange={(o) => !o && setChecking(null)}
        onRecord={(job, passed, notes) => act(job, () => counterJobsApi.qualityCheck(job._id, passed, notes), (j) => (passed ? `${j.jobNumber} passed — ready for pickup` : `${j.jobNumber} sent back to production`))}
      />
      <ReadyDialog job={notifying} businessName={businessName} onOpenChange={(o) => !o && setNotifying(null)} />
      <CounterBillingDialog
        job={billing}
        onOpenChange={(o) => !o && setBilling(null)}
        onBilled={(after) => {
          setDetail((d) => (d && d._id === after._id ? after : d));
          refresh();
        }}
      />
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={`Cancel ${cancelling?.jobNumber || "this job"}?`}
        description={cancelling ? `${cancelling.customerName} · ${cancelling.description}. It leaves the queue; you can reopen it later.${cancelling.pricing.advancePaid ? ` Return the ${formatINR(cancelling.pricing.advancePaid)} advance to the customer.` : ""}` : undefined}
        confirmLabel="Cancel job"
        cancelLabel="Keep job"
        onConfirm={cancel}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.jobNumber || "this job"}?`}
        description={deleting ? `${deleting.customerName} · ${deleting.description}. This can't be undone — cancel the job instead to keep a record.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
