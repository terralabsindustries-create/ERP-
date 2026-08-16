import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus,
  Search,
  Calendar,
  DollarSign,
  Clock,
  FileText,
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
import { Badge } from "@/components/ui/badge";
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
import { AssignTaskDialog } from "@/components/staff/AssignTaskDialog";
import { UpdateStatusDialog } from "@/components/jobs/UpdateStatusDialog";
import { AdvancedCreateInvoiceDialog } from "@/components/invoices/AdvancedCreateInvoiceDialog";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

const statusConfig: Record<string, { variant: "secondary" | "pending" | "warning" | "success" | "destructive"; label: string }> = {
  "inquiry": { variant: "secondary", label: "Inquiry" },
  "quotation_sent": { variant: "pending", label: "Quotation Sent" },
  "quotation_approved": { variant: "warning", label: "Approved" },
  "design_in_progress": { variant: "pending", label: "Designing" },
  "design_approved": { variant: "warning", label: "Design OK" },
  "production_ready": { variant: "warning", label: "Ready" },
  "ready_for_print": { variant: "warning", label: "Print Ready" },
  "quality_check": { variant: "warning", label: "QC" },
  "completed": { variant: "success", label: "Completed" },
  "delivered": { variant: "success", label: "Delivered" },
  "cancelled": { variant: "destructive", label: "Cancelled" }
};

const priorityConfig: Record<string, { variant: "secondary" | "warning" | "urgent" | "destructive"; label: string }> = {
  "low": { variant: "secondary", label: "Low" },
  "medium": { variant: "warning", label: "Medium" },
  "high": { variant: "urgent", label: "High" },
  "urgent": { variant: "destructive", label: "Urgent" }
};

export default function Jobs() {
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") || "");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [assignTaskDialog, setAssignTaskDialog] = useState({ open: false, jobId: "" });
  const [updateStatusDialog, setUpdateStatusDialog] = useState({ open: false, jobId: "", currentStatus: "" });
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const { toast } = useToast();
  const { user } = useAuth();

  useEffect(() => {
    fetchJobs();
    fetchCustomers();
  }, []);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getJobs();
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
      const response = await apiClient.getCustomer();
      const customersData = (response as any)?.customers || (response as any) || [];
      setCustomers(customersData);
    } catch (error) {
      console.error('Error fetching customers:', error);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!confirm("Are you sure you want to delete this job? This action cannot be undone.")) {
      return;
    }

    try {
      await apiClient.deleteJob(jobId);
      toast({
        title: "Job Deleted",
        description: "Job has been successfully deleted.",
      });
      fetchJobs();
    } catch (error) {
      console.error('Error deleting job:', error);
      toast({
        title: "Error",
        description: "Failed to delete job. Please try again.",
        variant: "destructive",
      });
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
  const totalRevenue = jobs.reduce((sum, job) => sum + (job.estimated_cost || job.estimatedCost || 0), 0);

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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Job Management</h1>
          <p className="text-muted-foreground text-sm">
            Track and manage all your printing jobs in one place
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Create New Job
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Jobs</p>
              <p className="text-xl font-bold">{totalJobs}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Clock className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">In Progress</p>
              <p className="text-xl font-bold">{activeJobs}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Completed</p>
              <p className="text-xl font-bold">{completedJobs}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Revenue</p>
              <p className="text-xl font-bold">{formatCurrency(totalRevenue)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center space-x-4 flex-wrap gap-2">
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
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="inquiry">Inquiry</SelectItem>
            <SelectItem value="quotation_sent">Quotation Sent</SelectItem>
            <SelectItem value="quotation_approved">Approved</SelectItem>
            <SelectItem value="design_in_progress">Designing</SelectItem>
            <SelectItem value="production_ready">Ready</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
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
          <CardTitle className="text-base">All Jobs</CardTitle>
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
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">Job Details</th>
                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Priority</th>
                    <th className="text-left px-4 py-3 font-medium">Due Date</th>
                    <th className="text-left px-4 py-3 font-medium">Amount</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job) => (
                    <tr key={job.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium">{job.title}</div>
                        <div className="text-xs text-muted-foreground font-mono">ID: {job.id}</div>
                        {job.createdBy?.fullName && (
                          <div className="text-xs text-muted-foreground">
                            Created by: {job.createdBy.fullName}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div>{job.customer}</div>
                        {job.customerCompany && (
                          <div className="text-xs text-muted-foreground">{job.customerCompany}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusConfig[job.status]?.variant || "secondary"}>
                          {statusConfig[job.status]?.label || job.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={priorityConfig[job.priority]?.variant || "secondary"}>
                          {priorityConfig[job.priority]?.label || job.priority}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(job.dueDate)}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {formatCurrency(job.estimated_cost || job.estimatedCost || 0)}
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
                              <FileText className="h-4 w-4 mr-2" />
                              {job.invoiceId ? 'Edit Invoice' : 'Generate Invoice'}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleUpdateStatus(job.id)}>
                              <Edit className="h-4 w-4 mr-2" />
                              Update Status
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setAssignTaskDialog({ open: true, jobId: job.id })}>
                              <UserPlus className="h-4 w-4 mr-2" />
                              Assign Task
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDeleteJob(job.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
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

      <AssignTaskDialog
        open={assignTaskDialog.open}
        onOpenChange={(open) => setAssignTaskDialog({ open, jobId: "" })}
        jobId={assignTaskDialog.jobId}
        onTaskAssigned={fetchJobs}
      />

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
            fetchJobs();
            setShowInvoiceDialog(false);
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
    </div>
  );
}