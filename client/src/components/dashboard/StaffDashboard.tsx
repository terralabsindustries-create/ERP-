import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { differenceInCalendarDays, format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  FileText,
  IndianRupee,
  Briefcase,
  TrendingUp,
  Calendar,
  CalendarDays,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  User,
  Wallet
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateJobDialog } from "@/components/jobs/CreateJobDialog";
import { CreateQuotationDialog } from "@/components/quotations/CreateQuotationDialog";
import { CalendarReminders } from "@/components/staff/CalendarReminders";
import { formatCurrency } from "@/lib/utils";
import { PageShell } from "@/components/layout/PageShell";
import { JobStatusBadge } from "@/components/jobs/JobStatusBadge";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import { Panel } from "@/components/common/Panel";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

interface Schedule {
  _id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  shiftType: 'morning' | 'afternoon' | 'evening' | 'night';
}

interface Task {
  _id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string;
  jobTitle?: string;
}

/** GET /api/jobs/mine — jobs this person handles or has tasks on. */
interface MyJob {
  _id: string;
  title: string;
  status: string;
  dueDate?: string;
  customerId?: { name?: string };
}

export function StaffDashboard() {
  const { user, hasPermission } = useAuth();
  const canCreateJob = hasPermission("Jobs: Create & Edit");
  const canQuote = hasPermission("Quotations: Create & Edit");
  const { toast } = useToast();
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [totalDesignCharge, setTotalDesignCharge] = useState(0);
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<unknown[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<'weekly' | 'monthly' | 'yearly' | 'all'>('all');
  
  // New state for schedule and tasks
  const [todaySchedule, setTodaySchedule] = useState<Schedule | null>(null);
  const [assignedTasks, setAssignedTasks] = useState<Task[]>([]);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);

  // Debug: Check if component is mounting
  console.log('🎯 StaffDashboard component is mounting!');
  console.log('🎯 User data:', user);
  console.log('🎯 User ID:', (user as any)?.id || (user as any)?._id);
  console.log('🎯 User role:', user?.role);

  // Design charges on the job tickets this login created (GET /api/jobs/staff/stats).
  // This replaced a calculation over the business's whole accounts ledger,
  // which showed staff the company's income and was not their earnings.
  const fetchStaffStats = useCallback(async () => {
    try {
      setLoading(true);
      const response = (await apiClient.get('/jobs/staff/stats', { period: selectedPeriod })) as { totalDesignCharge?: number };
      setTotalDesignCharge(response?.totalDesignCharge || 0);
    } catch (error: unknown) {
      toast({
        title: "Earnings could not be loaded",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
      setTotalDesignCharge(0);
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod, toast]);

  const [myJobs, setMyJobs] = useState<MyJob[] | null>(null);
  const fetchMyJobs = useCallback(async () => {
    try {
      setMyJobs(((await apiClient.getMyJobs()).jobs || []) as MyJob[]);
    } catch {
      setMyJobs([]);
    }
  }, []);

  useEffect(() => {
    if (user) fetchStaffStats();
  }, [user, fetchStaffStats]);

  // Fetch today's schedule for the logged-in staff
  const fetchTodaySchedule = useCallback(async () => {
    if (!user || !(user as any).id) {
      console.log('📅 No user or user ID available');
      return;
    }
    
    try {
      setLoadingSchedule(true);
      const staffId = (user as any).id;
      console.log(`📅 Fetching today's schedule for staff ${staffId}`);
      
      const response = await apiClient.getStaffSchedule(staffId) as any;
      console.log(`📅 Raw Schedule response:`, response);
      console.log(`📅 Response type:`, typeof response);
      console.log(`📅 Response keys:`, response ? Object.keys(response) : 'null');
      
      // Handle different response structures
      let schedules: Schedule[] = [];
      
      if (response === null || response === undefined) {
        console.log('📅 Response is null/undefined');
      } else if (Array.isArray(response)) {
        console.log('📅 Response is direct array');
        schedules = response;
      } else if (response.data && Array.isArray(response.data)) {
        console.log('📅 Response has data array');
        schedules = response.data;
      } else if (response.schedules && Array.isArray(response.schedules)) {
        console.log('📅 Response has schedules array');
        schedules = response.schedules;
      } else if (response.users && Array.isArray(response.users)) {
        console.log('📅 Response has users array (unexpected for schedules)');
        schedules = response.users;
      } else {
        console.log('📅 Unknown response structure, attempting to find array');
        // Try to find any array in the response
        const values = Object.values(response);
        const foundArray = values.find(v => Array.isArray(v));
        if (foundArray) {
          schedules = foundArray;
          console.log('📅 Found array in response:', foundArray);
        }
      }
      
      console.log(`📅 Final processed schedules:`, schedules);
      console.log(`📅 Number of schedules found:`, schedules?.length || 0);
      
      if (schedules && schedules.length > 0) {
        // Get current day and find today's schedule
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        console.log(`📅 Today is: ${today}`);
        console.log(`📅 Available schedule days:`, schedules.map(s => s.dayOfWeek));
        
        const todaySched = schedules.find((s: Schedule) => 
          s.dayOfWeek && s.dayOfWeek.toLowerCase() === today.toLowerCase()
        );
        
        console.log(`📅 Today's schedule found:`, todaySched);
        setTodaySchedule(todaySched || null);
        
        if (!todaySched) {
          console.log(`📅 No schedule for today, but staff has ${schedules.length} total schedules`);
          // Show the next available schedule as fallback
          const nextSchedule = schedules[0];
          console.log(`📅 Using next available schedule as fallback:`, nextSchedule);
          setTodaySchedule(nextSchedule);
        }
      } else {
        console.log(`📅 No schedules found for this staff member`);
        setTodaySchedule(null);
      }
    } catch (error) {
      console.error('❌ Error fetching schedule:', error);
      console.error('❌ Error details:', error.response || error.message || error);
      setTodaySchedule(null);
    } finally {
      setLoadingSchedule(false);
    }
  }, [user]);

  // Fetch assigned tasks for the logged-in staff
  const fetchAssignedTasks = useCallback(async () => {
    if (!user || !(user as any).id) {
      console.log('📋 No user or user ID available');
      return;
    }
    
    try {
      setLoadingTasks(true);
      const staffId = (user as any).id;
      console.log(`📋 Fetching assigned tasks for staff ${staffId}`);
      
      // Use the tasks endpoint - apiClient.get() should extract data automatically
      const response = await apiClient.get(`/tasks/by-staff/${staffId}`) as any;
      console.log(`📋 Staff tasks response:`, response);
      
      // Handle response more simply
      const tasks = response?.tasks || response?.data?.tasks || response?.data || response || [];
      console.log(`📋 Processed tasks:`, tasks);
      
      setAssignedTasks(tasks);
    } catch (error) {
      console.error('❌ Error fetching tasks:', error);
      toast({
        title: "Error",
        description: "Failed to fetch assigned tasks",
        variant: "destructive",
      });
      setAssignedTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  }, [user, toast]);

  useEffect(() => {
    console.log('🎯 useEffect is running in StaffDashboard');
    console.log('🎯 User available:', !!user);
    console.log('🎯 User ID:', (user as any)?.id);
    
    if (user && (user as any).id) {
      console.log('🎯 About to call fetchStaffStats, fetchTodaySchedule, fetchAssignedTasks');
      fetchTodaySchedule();
      fetchAssignedTasks();
      fetchMyJobs();
    } else {
      console.log('🎯 User or user ID not available, skipping API calls');
    }
  }, [user]); // Depend on user directly instead of the functions

  const handleJobCreated = () => {
    setShowCreateJob(false);
    fetchStaffStats(); // Refresh stats
  };

  const handleQuotationCreated = () => {
    fetchStaffStats(); // Refresh stats
  };

  const getTaskStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'success';
      case 'in_progress': return 'warning';
      case 'pending': return 'secondary';
      case 'overdue': return 'destructive';
      default: return 'secondary';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'destructive';
      case 'high': return 'warning';
      case 'medium': return 'secondary';
      case 'low': return 'outline';
      default: return 'secondary';
    }
  };

  const openTasks = assignedTasks.filter(t => t.status !== 'completed');
  const overdueTasks = openTasks.filter(t => t.dueDate && differenceInCalendarDays(new Date(t.dueDate), new Date()) < 0);
  const dueTodayTasks = openTasks.filter(t => t.dueDate && differenceInCalendarDays(new Date(t.dueDate), new Date()) === 0);
  const priorityTasks = [...assignedTasks].sort((a, b) => {
    const aDone = a.status === 'completed' ? 1 : 0;
    const bDone = b.status === 'completed' ? 1 : 0;
    return aDone - bDone || new Date(a.dueDate || '9999-12-31').getTime() - new Date(b.dueDate || '9999-12-31').getTime();
  });
  const STATUS_LABEL: Record<string, string> = { pending: "Pending", in_progress: "In progress", completed: "Completed", overdue: "Overdue" };
  const loadingRow = (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading…
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        eyebrow={format(new Date(), "EEEE, d MMMM yyyy")}
        title={`Welcome, ${user?.fullName || "there"}`}
        description="Your shift, tasks and earnings at a glance"
        actions={
          canCreateJob || canQuote ? (
            <>
              {canCreateJob && (
                <Button onClick={() => setShowCreateJob(true)}>
                  <Plus />
                  New Job Ticket
                </Button>
              )}
              {canQuote && (
                <CreateQuotationDialog onQuotationCreated={handleQuotationCreated}>
                  <Button variant="outline">
                    <FileText />
                    Create Quotation
                  </Button>
                </CreateQuotationDialog>
              )}
            </>
          ) : undefined
        }
      />

      {!loadingTasks && (overdueTasks.length > 0 || dueTodayTasks.length > 0) && (
        <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-warning/35 bg-warning-soft px-3 py-2 text-sm font-medium text-warning-strong">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {overdueTasks.length > 0 && <span>{overdueTasks.length} overdue task{overdueTasks.length === 1 ? '' : 's'}</span>}
          {dueTodayTasks.length > 0 && <span>{dueTodayTasks.length} due today</span>}
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* Earnings, with its period filter */}
        <Panel
          title="Earnings"
          icon={Wallet}
          action={
            <Select value={selectedPeriod} onValueChange={(value: 'weekly' | 'monthly' | 'yearly' | 'all') => setSelectedPeriod(value)}>
              <SelectTrigger className="h-8 w-[116px]" aria-label="Earnings period">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">All Time</SelectItem>
                <SelectItem value="weekly">This Week</SelectItem>
                <SelectItem value="monthly">This Month</SelectItem>
                <SelectItem value="yearly">This Year</SelectItem>
              </SelectContent>
            </Select>
          }
        >
          <div className="relative p-4 sm:p-5">
            <div className="num text-3xl font-semibold tracking-tight">
              {loading ? <span className="inline-block h-8 w-28 animate-pulse rounded bg-muted" /> : formatCurrency(totalDesignCharge)}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Design charges on job tickets you created
              {selectedPeriod === 'weekly' && ' in the last 7 days'}
              {selectedPeriod === 'monthly' && ' in the last 30 days'}
              {selectedPeriod === 'yearly' && ' in the last year'}
            </p>
          </div>
        </Panel>

        {/* Today's schedule */}
        <Panel title="Today's schedule" icon={CalendarDays}>
          <div className="p-4 sm:p-5">
            {loadingSchedule ? (
              loadingRow
            ) : todaySchedule ? (
              <div className="space-y-2">
                <div className="num flex items-center gap-2 text-xl font-semibold">
                  <Clock className="h-4 w-4 text-primary" />
                  {todaySchedule.startTime} – {todaySchedule.endTime}
                </div>
                <Badge variant="info" className="capitalize">
                  {todaySchedule.shiftType} shift
                </Badge>
              </div>
            ) : assignedTasks.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-warning-strong">
                  <AlertCircle className="h-4 w-4" />
                  Flexible schedule
                </div>
                <p className="text-xs text-muted-foreground">
                  Work on your {assignedTasks.length} assigned task{assignedTasks.length !== 1 ? 's' : ''}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <AlertCircle className="h-4 w-4" />
                  No schedule set
                </div>
                <p className="text-xs text-muted-foreground">Contact admin to set up your work schedule</p>
              </div>
            )}
          </div>
        </Panel>

        {/* Assigned tasks */}
        <Panel title="Your tasks" icon={CheckCircle} count={loadingTasks ? undefined : assignedTasks.length}>
          <div className="p-4 sm:p-5">
            {loadingTasks ? (
              loadingRow
            ) : assignedTasks.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{assignedTasks.filter(t => t.status === 'pending').length}</span> pending ·{" "}
                  <span className="font-semibold text-foreground">{assignedTasks.filter(t => t.status === 'in_progress').length}</span> in progress
                </p>
                <ul className="space-y-1.5">
                  {priorityTasks.slice(0, 3).map((task) => (
                    <li key={task._id} className="flex items-center gap-2 text-xs">
                      <Badge variant={getTaskStatusColor(task.status)}>{STATUS_LABEL[task.status] || task.status}</Badge>
                      <Link to={`/tasks/${task._id}`} className="min-w-0 flex-1 truncate hover:underline">{task.title}</Link>
                      {task.dueDate && !Number.isNaN(new Date(task.dueDate).getTime()) && (
                        <span className="num shrink-0 text-muted-foreground">{format(new Date(task.dueDate), 'd MMM')}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {assignedTasks.length > 3 && (
                  <p className="text-xs text-muted-foreground">+{assignedTasks.length - 3} more tasks</p>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle className="h-4 w-4" />
                No assigned tasks
              </div>
            )}
          </div>
        </Panel>

        {/* Jobs this person handles or has tasks on */}
        <Panel title="My jobs" icon={Briefcase} count={myJobs ? myJobs.length : undefined} description="Jobs you handle or have tasks on">
          {myJobs === null ? (
            <div className="p-4 sm:p-5">{loadingRow}</div>
          ) : myJobs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground sm:p-5">No open jobs assigned to you.</div>
          ) : (
            <ul className="max-h-60 divide-y overflow-y-auto">
              {myJobs.slice(0, 8).map((job) => {
                const late = job.dueDate && differenceInCalendarDays(new Date(job.dueDate), new Date()) < 0;
                return (
                  <li key={job._id} className="px-4 py-2.5 sm:px-5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{job.title}</span>
                      {job.dueDate && (
                        <span className={late ? "shrink-0 text-xs font-semibold text-destructive-strong" : "shrink-0 text-xs text-muted-foreground"}>
                          {format(new Date(job.dueDate), "d MMM")}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <JobStatusBadge status={job.status} />
                      <span className="truncate text-xs text-muted-foreground">{job.customerId?.name || ""}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </section>

      {/* Calendar & Reminders Section */}
      <CalendarReminders onTaskUpdate={fetchAssignedTasks} />

      {/* Dialogs */}
      <CreateJobDialog
        open={showCreateJob}
        onOpenChange={setShowCreateJob}
        onJobCreated={handleJobCreated}
        customers={customers}
        onCustomersUpdate={() => { }}
      />
    </PageShell>
  );
}
