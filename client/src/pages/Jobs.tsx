import { useState, useEffect, useRef } from "react";
import { useDebounced } from "@/hooks/useDebounced";
import { Pagination } from "@/components/data";

const PAGE_SIZE = 25;
import { StatCard } from "@/components/common/StatTile";
import { useSearchParams } from "react-router-dom";
import { JobStatusBadge, PriorityBadge } from "@/components/jobs/JobStatusBadge";
import { dueState, formatINR, STAGES } from "@/lib/printWorkflow";
import { invoiceState } from "@/lib/invoiceStatus";
import { deliveryState, type JobDelivery } from "@/lib/deliveryStatus";
import {
  Plus,
  Search,
  Calendar,
  IndianRupee,
  Clock,
  FileText,
  FileEdit,
  TrendingUp,
  CheckCircle2,
  MoreHorizontal,
  Edit,
  Trash2,
  UserPlus,
  Eye,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { CreateJobDialog } from "@/components/jobs/CreateJobDialog";
import { CreateTaskDialog } from "@/components/staff/CreateTaskDialog";
import { UpdateStatusDialog } from "@/components/jobs/UpdateStatusDialog";
import { AdvancedCreateInvoiceDialog } from "@/components/invoices/AdvancedCreateInvoiceDialog";
import { EditInvoiceDialog } from "@/components/invoices/EditInvoiceDialog";
import { ViewInvoiceDialog } from "@/components/invoices/ViewInvoiceDialog";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { ConfirmDialog, StatusPill } from "@/components/data";
import { ErrorState, StaleDataBanner } from "@/components/common/LoadState";

/** An invoice a job ticket is billed on, as GET /api/jobs returns it (never a cancelled one). */
type JobInvoice = {
  _id: string;
  invoiceNumber: string;
  totalAmount?: number;
  status: string;
  paymentStatus: string;
  balanceAmount?: number;
  dueDate?: string;
};

export default function Jobs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load is shown as an error (with the last good list kept), never as "no jobs".
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadedAt, setLoadedAt] = useState<number | undefined>(undefined);
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") || "");
  // A search from the header while already on this page arrives as a new ?q.
  const qParam = searchParams.get("q");
  useEffect(() => {
    if (qParam !== null) setSearchTerm(qParam);
  }, [qParam]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [totalMatching, setTotalMatching] = useState(0);
  const [summary, setSummary] = useState<{ total: number; active: number; completed: number; billed: number | null } | null>(null);
  const debouncedSearch = useDebounced(searchTerm.trim(), 300);
  const requestRef = useRef<AbortController | null>(null);
  // "New Job Ticket" in the header links here with ?new=1
  const [editingJob, setEditingJob] = useState<any>(null);
  const [editLockedReason, setEditLockedReason] = useState<string | undefined>(undefined);
  const [showCreateDialog, setShowCreateDialog] = useState(() => searchParams.get("new") === "1");
  const [assignTaskDialog, setAssignTaskDialog] = useState({ open: false, jobId: "" });
  const [updateStatusDialog, setUpdateStatusDialog] = useState({ open: false, jobId: "", currentStatus: "" });
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  // "Create another invoice" on a billed job: billing it in parts, on purpose.
  const [additionalInvoice, setAdditionalInvoice] = useState(false);
  // The invoice opened from a job's row (View invoice).
  const [viewingInvoice, setViewingInvoice] = useState<JobInvoice | null>(null);
  const [quotationJob, setQuotationJob] = useState<any>(null);
  const [showQuotationDialog, setShowQuotationDialog] = useState(false);
  const [invoiceToEdit, setInvoiceToEdit] = useState<any>(null);
  const [showEditInvoiceDialog, setShowEditInvoiceDialog] = useState(false);
  const { toast } = useToast();
  const { hasPermission, user } = useAuth();
  // Mirrors backend/src/utils/jobAccess.js: a designer is shown the job tickets they created.
  const ownJobsOnly = user?.role === "designer" && !user?.canViewAllData;
  // A login may see job tickets without being able to change them (e.g. the
  // accountant, who bills them); only the actions it holds are offered.
  const canInvoice = hasPermission("Invoicing: Create & Edit");
  // Reading an invoice is open to the same logins as the server allows (app.js).
  const canViewInvoice = canInvoice || ["Invoicing", "Invoicing (View No GST)", "Payments", "Accounts"].some((p) => hasPermission(p));
  const canQuote = hasPermission("Quotations: Create & Edit");
  const canCreateJob = hasPermission("Jobs: Create & Edit");
  const canChangeStatus = hasPermission("Jobs: Change Status");
  const canAssign = hasPermission("Staff & Tasks: Assign Tasks");
  const canDeleteJob = hasPermission("Jobs: Delete");


  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setShowCreateDialog(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams]);

  // Search, filters and pages run on the server over every visible job; the
  // page carries 25 light rows (invoice summaries, no line items). A newer
  // request cancels the one in flight.
  const fetchJobs = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    try {
      const response = await apiClient.getWithSignal<{ jobs: any[]; pagination: { totalJobs: number } }>("/jobs", {
        page,
        limit: PAGE_SIZE,
        search: debouncedSearch || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        priority: priorityFilter !== "all" ? priorityFilter : undefined,
        stage: stageFilter !== "all" ? stageFilter : undefined,
        from: dateFrom || undefined,
        to: dateTo || undefined,
      }, controller.signal);
      const jobsData = response?.jobs || [];

      const processedJobs = jobsData.map((job: any) => ({
        ...job,
        customer: job.customerId?.name || job.customer || 'Unknown Customer',
        customerId: job.customerId?._id || job.customerId,
        customerEmail: job.customerId?.email,
        customerPhone: job.customerId?.phone,
        customerCompany: job.customerId?.company,
        invoiceId: job.invoices?.[0]?._id || null
      }));

      setJobs(processedJobs);
      setTotalMatching(response?.pagination?.totalJobs ?? processedJobs.length);
      setLoadError(null);
      setLoadedAt(Date.now());
      setLoading(false);
    } catch (error: any) {
      if (controller.signal.aborted || error?.kind === "cancelled") return;
      console.error('Error fetching jobs:', error);
      setLoadError(error);
      setLoading(false);
    }
    apiClient.get<{ total: number; active: number; completed: number; billed: number | null }>("/jobs/stats/summary").then(setSummary).catch(() => undefined);
  };

  useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter, priorityFilter, stageFilter, dateFrom, dateTo]);
  useEffect(() => {
    fetchJobs();
    return () => requestRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, statusFilter, priorityFilter, stageFilter, dateFrom, dateTo]);

  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const handleDeleteJob = (jobId: string) => setDeletingJobId(jobId);
  const confirmDeleteJob = async () => {
    const jobId = deletingJobId;
    if (!jobId) return;
    try {
      await apiClient.deleteJob(jobId);
      setDeletingJobId(null);
      toast({
        title: "Job Deleted",
        description: "Job has been successfully deleted.",
      });
      fetchJobs();
    } catch (error) {
      console.error('Error deleting job:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete job. Please try again.",
        variant: "destructive",
      });
      throw error;
    }
  };

  const handleUpdateStatus = (jobId: string) => {
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      setUpdateStatusDialog({ open: true, jobId, currentStatus: job.status });
    }
  };

  const handleGenerateInvoice = (job: any, additional = false) => {
    setSelectedJob(job);
    setAdditionalInvoice(additional);
    setShowInvoiceDialog(true);
  };


  // The job list only carries the invoice's id, so the invoice itself is
  // fetched before the edit dialog opens on it. The row's id can also be stale
  // or missing — an invoice raised from the Invoices page is only linked to the
  // job if one was picked there — so the invoice is looked up by job as well.
  const handleEditInvoice = async (job: any) => {
    try {
      let invoiceId = job.invoiceId;

      if (!invoiceId) {
        const list: any = await apiClient.getInvoices({ jobId: job.id, limit: '1' });
        invoiceId = list?.invoices?.[0]?._id;
      }

      if (!invoiceId) {
        toast({
          title: "No invoice yet",
          description: "This job has no invoice to edit. Use Generate Invoice first.",
        });
        return;
      }

      const response: any = await apiClient.getInvoice(invoiceId);
      const invoice = response?.invoice || response;

      if (!invoice?._id) {
        throw new Error('Invoice not found');
      }

      // An issued invoice is a tax document: it is corrected with a credit or
      // debit note (Invoices → ⋯ → Credit / debit note), not edited.
      if (invoice.status !== 'draft') {
        toast({
          title: `${invoice.invoiceNumber} is already issued`,
          description: "Its amounts are locked. Raise a credit or debit note from the Invoices page to correct it.",
        });
        return;
      }

      setInvoiceToEdit(invoice);
      setShowEditInvoiceDialog(true);
    } catch (error: any) {
      console.error('Error loading invoice for job:', error);
      toast({
        title: "Error",
        description: error?.message || "Failed to load this job's invoice",
        variant: "destructive",
      });
    }
  };

  // The server has already filtered and paged the list.
  const filteredJobs = jobs;
  const filtersActive = !!searchTerm || statusFilter !== "all" || priorityFilter !== "all" || stageFilter !== "all" || !!dateFrom || !!dateTo;

  // Header figures over every visible job (GET /jobs/stats/summary), not one page.
  const totalJobs = summary?.total ?? 0;
  const activeJobs = summary?.active ?? 0;
  const completedJobs = summary?.completed ?? 0;
  // What a job was billed for (its invoices, incl. GST); the estimate until it is billed.
  // job.invoices holds the job's non-cancelled invoices only (GET /api/jobs), so
  // a job is billed as soon as it has one, whatever its payment state.
  // Opens the ticket for editing. The full job is fetched first (the list is a summary).
  const handleEditJob = async (job: any) => {
    try {
      const res: any = await apiClient.getJob(job._id || job.id);
      const full = res?.job || res;
      const live = (job.invoices || []).find((i: JobInvoice) => i.status !== "cancelled");
      const finished = ["completed", "delivered"].includes(job.status);
      setEditLockedReason(
        live ? `Billed on invoice ${live.invoiceNumber}: the customer, items, cost, paper and sheets are locked. Priority, delivery date, title and notes can still be changed.`
        : finished ? `This job is ${job.status}: its billing details are locked. Priority, delivery date, title and notes can still be changed.`
        : undefined
      );
      setEditingJob(full);
      setShowCreateDialog(true);
    } catch (error: any) {
      toast({ title: "Could not open the job", description: error?.message || "Please try again", variant: "destructive" });
    }
  };

  const isBilled = (job: { invoices?: JobInvoice[] }) => (job.invoices?.length || 0) > 0;
  const billedOf = (job: any) => (job.invoices || []).reduce((sum: number, inv: any) => sum + (inv.totalAmount || 0), 0);
  const estimateOf = (job: any) => job.estimated_cost || job.estimatedCost || 0;
  const totalRevenue = summary?.billed ?? 0;

  const formatCurrency = (amount: number) => {
    return `₹${amount.toLocaleString('en-IN')}`;
  };

  const formatDate = (dateValue: any) => {
    if (!dateValue) return 'N/A';
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return 'Invalid';
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  return (
    <div className="page-frame">
      {/* Header */}
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Job Tickets</h1>
          <p className="text-muted-foreground text-sm">
            {ownJobsOnly
              ? "The job tickets you created — specs, status, deadlines and billing"
              : "Every print job from enquiry to delivery — specs, status, deadlines and billing"}
          </p>
        </div>
        {canCreateJob && (
          <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            New Job Ticket
          </Button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Jobs" value={totalJobs} icon={FileText} />

        <StatCard label="In Progress" value={activeJobs} icon={Clock} />

        <StatCard label="Completed" value={completedJobs} icon={CheckCircle2} />

        <StatCard label="Billed" value={formatCurrency(Math.round(totalRevenue))} hint="Invoices raised for these jobs" icon={IndianRupee} />
      </div>

      {/* Filters */}
      <div className="page-filter-row">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by job title, customer, or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by stage" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stages</SelectItem>
            {STAGES.map((stage) => (
              <SelectItem key={stage.status} value={stage.status}>{stage.label}</SelectItem>
            ))}
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Priority</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="urgent">Urgent</SelectItem>
          </SelectContent>
        </Select>

        <Select value={stageFilter} onValueChange={setStageFilter}>
          <SelectTrigger className="w-[170px]" aria-label="Production stage">
            <SelectValue placeholder="Production" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any production state</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="pre_production">Pre-production</SelectItem>
            <SelectItem value="in_production">In production</SelectItem>
            <SelectItem value="ready">Ready to dispatch</SelectItem>
            <SelectItem value="closed">Delivered / cancelled</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Input type="date" aria-label="Created from" className="h-9 w-[150px]" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <span>–</span>
          <Input type="date" aria-label="Created to" className="h-9 w-[150px]" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      {/* Jobs Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{filtersActive ? "Matching job tickets" : "All job tickets"}{loadedAt !== undefined && <span className="ml-2 font-normal text-muted-foreground">{totalMatching.toLocaleString("en-IN")}</span>}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadError && loadedAt !== undefined && (
            <StaleDataBanner className="m-3" error={loadError} onRetry={fetchJobs} retrying={loading} updatedAt={loadedAt} />
          )}
          {loading && loadedAt === undefined ? (
            <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading job tickets">
              {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />)}
            </div>
          ) : loadError && loadedAt === undefined ? (
            <ErrorState error={loadError} what="job tickets" onRetry={fetchJobs} retrying={loading} />
          ) : filteredJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <FileText className="h-10 w-10 text-muted-foreground opacity-40" />
              <h3 className="text-lg font-semibold">No jobs found</h3>
              <p className="text-muted-foreground text-sm max-w-sm">
                {filtersActive
                  ? "Try adjusting your filters"
                  : "Create your first job to get started"}
              </p>
              {filtersActive ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchTerm("");
                    setStatusFilter("all");
                    setPriorityFilter("all");
                    setStageFilter("all");
                    setDateFrom("");
                    setDateTo("");
                  }}
                >
                  Clear filters
                </Button>
              ) : canCreateJob ? (
                <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Job
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-4 py-2.5">Customer</th>
                    <th className="text-left px-4 py-2.5">Job & specs</th>
                    <th className="text-left px-4 py-2.5">Stage</th>
                    <th className="text-left px-4 py-2.5">Priority</th>
                    <th className="text-left px-4 py-2.5">Due</th>
                    <th className="text-right px-4 py-2.5">Amount</th>
                    <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job) => (
                    <tr key={job.id} className="border-b hover:bg-muted transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium">{job.customer}</div>
                        {job.customerCompany && (
                          <div className="text-xs text-muted-foreground">{job.customerCompany}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{job.title}</div>
                        {(job.printSpecs?.quantity > 1 || job.printSpecs?.paperType || job.printSpecs?.printSize || job.printSpecs?.sheets > 0) && (
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                            {[
                              job.printSpecs?.quantity > 1 ? `${Number(job.printSpecs.quantity).toLocaleString('en-IN')} pcs` : null,
                              job.printSpecs?.printSize,
                              job.printSpecs?.paperType,
                              job.printSpecs?.sheets > 0 ? `${Number(job.printSpecs.sheets).toLocaleString('en-IN')} sheets` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        {job.createdBy?.fullName && (
                          <div className="text-xs text-muted-foreground">
                            Created by: {job.createdBy.fullName}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <JobStatusBadge status={job.status} />
                      </td>
                      <td className="px-4 py-3">
                        <PriorityBadge priority={job.priority} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div
                          className={`flex items-center gap-2 ${
                            dueState(job.dueDate, job.status) === "overdue"
                              ? "font-medium text-destructive"
                              : dueState(job.dueDate, job.status) === "today"
                              ? "font-semibold text-phase-press-text"
                              : ""
                          }`}
                        >
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(job.dueDate)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {isBilled(job) ? (
                          <div className="flex flex-col items-end gap-1">
                            <span>{formatINR(billedOf(job))}</span>
                            {/* Each invoice the job is billed on, with how much of it is paid. */}
                            {(job.invoices as JobInvoice[]).map((inv) => {
                              const st = invoiceState(inv);
                              return (
                                <button
                                  key={inv._id}
                                  type="button"
                                  disabled={!canViewInvoice}
                                  className="group inline-flex items-center gap-1.5 text-xs font-normal disabled:cursor-default"
                                  onClick={() => setViewingInvoice(inv)}
                                  title={`View invoice ${inv.invoiceNumber} — ${formatINR(inv.totalAmount || 0)}`}
                                >
                                  <span className="font-mono text-muted-foreground group-hover:text-foreground group-hover:underline">{inv.invoiceNumber}</span>
                                  <StatusPill tone={st.tone}>{st.label}</StatusPill>
                                </button>
                              );
                            })}
                            <DeliveryPill job={job} billed />
                          </div>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            {estimateOf(job) > 0 && (
                              <span className="text-muted-foreground" title="Estimate — not billed yet">
                                {formatCurrency(estimateOf(job))} <span className="text-xs">est.</span>
                              </span>
                            )}
                            <span className="text-destructive-strong">Not billed</span>
                            <DeliveryPill job={job} />
                            {/* The job ticket's items, notes and HSN codes come across to the invoice. */}
                            {canInvoice && job.status !== "cancelled" && (
                              <Button
                                variant="outline"
                                size="xs"
                                className="border-destructive/30 bg-destructive-soft text-destructive-strong hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive-strong"
                                onClick={() => handleGenerateInvoice(job)}
                              >
                                <FileText />
                                Create invoice
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {(canInvoice || canViewInvoice || canQuote || canCreateJob || canChangeStatus || canAssign || canDeleteJob) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canCreateJob && job.status !== "cancelled" && (
                              <DropdownMenuItem onClick={() => handleEditJob(job)}>
                                <Edit className="h-4 w-4" />
                                Edit job
                              </DropdownMenuItem>
                            )}
                            {canQuote && job.status !== "cancelled" && (
                              <DropdownMenuItem onClick={() => {
                                setQuotationJob(job);
                                setShowQuotationDialog(true);
                              }}>
                                <FileEdit className="h-4 w-4" />
                                Create quotation
                              </DropdownMenuItem>
                            )}
                            {canViewInvoice && isBilled(job) && (
                              <DropdownMenuItem onClick={() => setViewingInvoice(job.invoices[0])}>
                                <Eye className="h-4 w-4" />
                                View invoice
                              </DropdownMenuItem>
                            )}
                            {canInvoice && isBilled(job) && (
                              <>
                                <DropdownMenuItem onClick={() => handleEditInvoice(job)} disabled={!!job.invoices?.[0] && job.invoices[0].status !== "draft"}>
                                  <FileEdit className="h-4 w-4" />
                                  Edit invoice
                                </DropdownMenuItem>
                                {/* Billing a job in parts is allowed, but only on purpose. */}
                                {job.status !== "cancelled" && (
                                  <DropdownMenuItem onClick={() => handleGenerateInvoice(job, true)}>
                                    <FileText className="h-4 w-4" />
                                    Create another invoice
                                  </DropdownMenuItem>
                                )}
                              </>
                            )}
                            {canInvoice && !isBilled(job) && job.status !== "cancelled" && (
                              <DropdownMenuItem onClick={() => handleGenerateInvoice(job)}>
                                <FileText className="h-4 w-4" />
                                Create invoice
                              </DropdownMenuItem>
                            )}
                            {canChangeStatus && (
                              <DropdownMenuItem onClick={() => handleUpdateStatus(job.id)}>
                                <Edit className="h-4 w-4" />
                                Update Status
                              </DropdownMenuItem>
                            )}
                            {canAssign && (
                              <DropdownMenuItem onClick={() => setAssignTaskDialog({ open: true, jobId: job.id })}>
                                <UserPlus className="h-4 w-4" />
                                Assign Task
                              </DropdownMenuItem>
                            )}
                            {canDeleteJob && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleDeleteJob(job.id)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete Job
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalMatching > PAGE_SIZE && (
            <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
              <Pagination page={page} pageSize={PAGE_SIZE} total={totalMatching} onPageChange={setPage} noun="job tickets" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateJobDialog
        open={showCreateDialog}
        onOpenChange={(open) => { setShowCreateDialog(open); if (!open) { setEditingJob(null); setEditLockedReason(undefined); } }}
        onJobCreated={fetchJobs}
        editingJob={editingJob}
        editLockedReason={editLockedReason}
        onJobUpdated={fetchJobs}
      />

      {(() => {
        const job = jobs.find((j) => j.id === assignTaskDialog.jobId || j._id === assignTaskDialog.jobId);
        return (
          <CreateTaskDialog
            open={assignTaskDialog.open}
            onOpenChange={(open) => setAssignTaskDialog((d) => ({ ...d, open }))}
            onTaskCreated={() => {
              toast({ title: "Task assigned", description: job ? `For ${job.title}` : undefined });
            }}
            preselectedJob={job ? { _id: job._id || job.id, title: job.title, customer: job.customer, status: job.status, dueDate: job.dueDate, priority: job.priority } : undefined}
          />
        );
      })()}

      <UpdateStatusDialog
        open={updateStatusDialog.open}
        onOpenChange={(open) => setUpdateStatusDialog({ open, jobId: "", currentStatus: "" })}
        jobId={updateStatusDialog.jobId}
        currentStatus={updateStatusDialog.currentStatus}
        onStatusUpdated={fetchJobs}
      />

      {selectedJob && (
        <AdvancedCreateInvoiceDialog
          open={showInvoiceDialog}
          onOpenChange={setShowInvoiceDialog}
          onInvoiceCreated={() => {
            // The invoice dialog then offers Print / Download / Send; nothing downloads by itself.
            fetchJobs();
            setShowInvoiceDialog(false);
          }}
          preselectedJob={selectedJob}
          allowAdditionalInvoice={additionalInvoice}
          preselectedCustomer={{
            _id: selectedJob.customerId,
            name: selectedJob.customer,
            email: selectedJob.customerEmail,
            phone: selectedJob.customerPhone,
            company: selectedJob.customerCompany
          }}
        />
      )}

      {quotationJob && (
        <CreateQuotationDialog
          open={showQuotationDialog}
          // Kept mounted after closing, so its saved-quotation actions stay on screen.
          onOpenChange={setShowQuotationDialog}
          initialJob={quotationJob}
        />
      )}

      <EditInvoiceDialog
        open={showEditInvoiceDialog}
        onOpenChange={(open) => {
          setShowEditInvoiceDialog(open);
          if (!open) setInvoiceToEdit(null);
        }}
        invoice={invoiceToEdit}
        onInvoiceUpdated={fetchJobs}
      />
      {/* Payments, edits and cancellation made from here show on the job straight away. */}
      <ViewInvoiceDialog
        open={!!viewingInvoice}
        onOpenChange={(open) => !open && setViewingInvoice(null)}
        invoice={viewingInvoice as never}
        onInvoiceUpdated={fetchJobs}
      />
      <ConfirmDialog
        open={!!deletingJobId}
        onOpenChange={(o) => !o && setDeletingJobId(null)}
        title="Delete this job?"
        description={`${jobs.find((j) => j.id === deletingJobId)?.title || "The job"} is removed. Its invoices and payments stay. This can't be undone.`}
        onConfirm={confirmDeleteJob}
      />
    </div>
  );
}

/** The job's delivery state beside its payment state (lib/deliveryStatus.ts). */
function DeliveryPill({ job, billed = false }: { job: { status?: string; deliveries?: JobDelivery[] }; billed?: boolean }) {
  const st = deliveryState(job, { billed });
  if (!st) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-normal" title={st.detail}>
      <Truck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <StatusPill tone={st.tone}>{st.label}</StatusPill>
    </span>
  );
}
