import { useState, useEffect } from "react";
import { StatCard } from "@/components/common/StatTile";
import { useSearchParams } from "react-router-dom";
import { JobStatusBadge, PriorityBadge } from "@/components/jobs/JobStatusBadge";
import { dueState, STAGES } from "@/lib/printWorkflow";
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
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { ConfirmDialog } from "@/components/data";

export default function Jobs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [jobs, setJobs] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") || "");
  // A search from the header while already on this page arrives as a new ?q.
  const qParam = searchParams.get("q");
  useEffect(() => {
    if (qParam !== null) setSearchTerm(qParam);
  }, [qParam]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  // "New Job Ticket" in the header links here with ?new=1
  const [showCreateDialog, setShowCreateDialog] = useState(() => searchParams.get("new") === "1");
  const [assignTaskDialog, setAssignTaskDialog] = useState({ open: false, jobId: "" });
  const [updateStatusDialog, setUpdateStatusDialog] = useState({ open: false, jobId: "", currentStatus: "" });
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [invoiceToEdit, setInvoiceToEdit] = useState<any>(null);
  const [showEditInvoiceDialog, setShowEditInvoiceDialog] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  useEffect(() => {
    fetchJobs();
    fetchCustomers();
  }, []);

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setShowCreateDialog(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams]);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      // The API pages at 10 by default; the list filters client-side, so load them all.
      const response = await apiClient.getJobs({ limit: 500 });
      const jobsData = (response as any)?.jobs || (response as any) || [];

      const processedJobs = jobsData.map((job: any) => ({
        ...job,
        customer: job.customerId?.name || job.customer || 'Unknown Customer',
        customerId: job.customerId?._id || job.customerId,
        customerEmail: job.customerId?.email,
        customerPhone: job.customerId?.phone,
        customerCompany: job.customerId?.company,
        invoiceId: job.invoices?.[0]?._id || null,
        invoiceItems: job.invoices?.[0]?.items || null
      }));

      setJobs(processedJobs);
    } catch (error) {
      console.error('Error fetching jobs:', error);
      toast({
        title: "Error",
        description: "Failed to fetch jobs",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchCustomers = async () => {
    try {
      const customersData = await apiClient.listAll('/customers', 'customers');
      setCustomers(customersData);
    } catch (error) {
      console.error('Error fetching customers:', error);
    }
  };

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

  const handleGenerateInvoice = (job: any) => {
    setSelectedJob(job);
    setShowInvoiceDialog(true);
  };

  // Generating an invoice from a job hands the PDF straight to the person who
  // asked for it, the same way the quick-job flow does.
  const downloadInvoice = async (invoice: any) => {
    const invoiceId = invoice?._id || invoice?.id;
    if (!invoiceId) return;

    try {
      await apiClient.downloadInvoicePDF(invoiceId);
    } catch (error: any) {
      console.error('Error downloading invoice PDF:', error);
      toast({
        title: "Download failed",
        description: error?.message || "The invoice was created, but its PDF could not be downloaded.",
        variant: "destructive",
      });
    }
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

  // Filter jobs
  const filteredJobs = jobs.filter((job) => {
    const customerName = job.customer || '';
    const matchesSearch =
      job.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      job.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === "all" || job.status === statusFilter;
    const matchesPriority = priorityFilter === "all" || job.priority === priorityFilter;

    return matchesSearch && matchesStatus && matchesPriority;
  });

  // Calculate stats
  const totalJobs = jobs.length;
  const activeJobs = jobs.filter(job => !["completed", "delivered", "cancelled"].includes(job.status)).length;
  const completedJobs = jobs.filter(job => ["completed", "delivered"].includes(job.status)).length;
  // What a job was billed for (its invoices, incl. GST); the estimate until it is billed.
  const billedOf = (job: any) => (job.invoices || []).reduce((sum: number, inv: any) => sum + (inv.totalAmount || 0), 0);
  const estimateOf = (job: any) => job.estimated_cost || job.estimatedCost || 0;
  const totalRevenue = jobs.reduce((sum, job) => sum + billedOf(job), 0);

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
            Every print job from enquiry to delivery — specs, status, deadlines and billing
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          New Job Ticket
        </Button>
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
      </div>

      {/* Jobs Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">All job tickets{!loading && <span className="ml-2 font-normal text-muted-foreground">{filteredJobs.length}</span>}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              Loading jobs...
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <FileText className="h-10 w-10 text-muted-foreground opacity-40" />
              <h3 className="text-lg font-semibold">No jobs found</h3>
              <p className="text-muted-foreground text-sm max-w-sm">
                {searchTerm || statusFilter !== "all" || priorityFilter !== "all"
                  ? "Try adjusting your filters"
                  : "Create your first job to get started"}
              </p>
              {searchTerm || statusFilter !== "all" || priorityFilter !== "all" ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchTerm("");
                    setStatusFilter("all");
                    setPriorityFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Job
                </Button>
              )}
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
                    <tr key={job.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium">{job.customer}</div>
                        {job.customerCompany && (
                          <div className="text-xs text-muted-foreground">{job.customerCompany}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{job.title}</div>
                        {(job.printSpecs?.quantity > 1 || job.printSpecs?.paperType || job.printSpecs?.printSize) && (
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                            {[
                              job.printSpecs?.quantity > 1 ? `${Number(job.printSpecs.quantity).toLocaleString('en-IN')} pcs` : null,
                              job.printSpecs?.printSize,
                              job.printSpecs?.paperType,
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
                              ? "font-medium text-[hsl(30_90%_32%)]"
                              : ""
                          }`}
                        >
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(job.dueDate)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {billedOf(job) > 0 ? (
                          formatCurrency(Math.round(billedOf(job)))
                        ) : estimateOf(job) > 0 ? (
                          <span className="text-muted-foreground" title="Estimate — not billed yet">
                            {formatCurrency(estimateOf(job))} <span className="text-xs">est.</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not billed</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleGenerateInvoice(job)}>
                              <FileText className="h-4 w-4" />
                              Generate Invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEditInvoice(job)}>
                              <FileEdit className="h-4 w-4" />
                              Edit Invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleUpdateStatus(job.id)}>
                              <Edit className="h-4 w-4" />
                              Update Status
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setAssignTaskDialog({ open: true, jobId: job.id })}>
                              <UserPlus className="h-4 w-4" />
                              Assign Task
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDeleteJob(job.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete Job
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <CreateJobDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onJobCreated={fetchJobs}
        customers={customers}
        onCustomersUpdate={fetchCustomers}
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
          onInvoiceCreated={(invoice) => {
            fetchJobs();
            setShowInvoiceDialog(false);
            downloadInvoice(invoice);
          }}
          preselectedJob={selectedJob}
          preselectedCustomer={{
            _id: selectedJob.customerId,
            name: selectedJob.customer,
            email: selectedJob.customerEmail,
            phone: selectedJob.customerPhone,
            company: selectedJob.customerCompany
          }}
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