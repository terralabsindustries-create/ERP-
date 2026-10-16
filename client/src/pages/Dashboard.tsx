import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { differenceInCalendarDays, format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import {
  Factory,
  CalendarClock,
  IndianRupee,
  Target,
  FileWarning,
  Landmark,
  Truck,
  Layers,
  Users,
  Wallet,
  Pencil,
  Check,
  X,
  CircleAlert,
  CircleCheck,
  Loader2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { NotificationCenter } from "@/components/dashboard/NotificationCenter";
import { TaskWidget } from "@/components/dashboard/TaskWidget";
import { PaymentDuesWidget } from "@/components/dashboard/PaymentDuesWidget";
import { QuickReminderDialog } from "@/components/dashboard/QuickReminderDialog";
import { DashboardShortcuts } from "@/components/dashboard/DashboardShortcuts";
import { StaffDashboard } from "@/components/dashboard/StaffDashboard";
import { KpiTile } from "@/components/common/StatTile";
import { Panel, PanelLink } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { PipelineStrip } from "@/components/production/PipelineStrip";
import { TeamWorkloadPanel } from "@/components/dashboard/TeamWorkloadPanel";
import { JobStatusBadge } from "@/components/jobs/JobStatusBadge";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { dueState, formatINR, SHOP_FLOOR_STATUSES } from "@/lib/printWorkflow";
import { cn } from "@/lib/utils";

const greeting = (d: Date) => {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

/** GET /api/dashboard/stats — null means the login's permissions don't cover that figure. */
interface DashboardStats {
  monthlyTarget: number;
  todaysJobs: number | null;
  urgentJobs: number | null;
  openJobs: number | null;
  totalCustomers: number | null;
  unpaidInvoices: number | null;
  overdueInvoices: number | null;
  receivables: number | null;
  invoicedThisMonth: number | null;
  collectedToday: number | null;
  cashBalance: number | null;
  bankBalance: number | null;
  lowStockItems: number | null;
  pendingDeliveries: number | null;
}

const has = (n: number | null | undefined): n is number => typeof n === "number";

export default function Dashboard() {
  const { user, loading: authLoading, hasPermission } = useAuth();
  // The monthly target is the business's; the owner and managers set it.
  const canSetTarget = user?.role === "admin" || user?.role === "manager" || hasPermission("Settings: Edit");
  const canSeeJobs = hasPermission("Jobs");
  const seesWholeTeam = !!user && (user.role === "admin" || (user.canViewAllData === true && hasPermission("Staff & Tasks")));
  const navigate = useNavigate();
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const [jobsError, setJobsError] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const [isEditingRevenue, setIsEditingRevenue] = useState(false);
  const [tempMonthlyTarget, setTempMonthlyTarget] = useState(0);

  const fetchDashboardStats = useCallback(async () => {
    try {
      const response = (await apiClient.getDashboardStats()) as { stats: DashboardStats; sources?: Record<string, string> };
      setStats(response.stats);
      setSources(response.sources || {});
      setStatsError(false);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Error fetching dashboard stats:', error);
      setStatsError(true);
    }
  }, []);

  // The pipeline and due-list are built from the job list itself.
  const fetchJobs = useCallback(async () => {
    if (!canSeeJobs) {
      setJobsLoading(false);
      return;
    }
    try {
      const response: any = await apiClient.getJobs({ limit: 500 });
      setJobs(response?.jobs || (Array.isArray(response) ? response : []));
      setJobsError(false);
    } catch (error) {
      console.error('Error fetching jobs for dashboard:', error);
      setJobsError(true);
    } finally {
      setJobsLoading(false);
    }
  }, [canSeeJobs]);

  const refresh = useCallback(() => {
    fetchDashboardStats();
    fetchJobs();
  }, [fetchDashboardStats, fetchJobs]);

  useEffect(() => {
    if (user && !authLoading && user.role !== 'staff') {
      refresh();
      // Auto-refresh every 30 seconds for real-time updates
      const interval = setInterval(refresh, 30000);
      return () => clearInterval(interval);
    }
  }, [user, authLoading, refresh]);

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    return counts;
  }, [jobs]);

  const inProduction = useMemo(
    () => jobs.filter((j) => SHOP_FLOOR_STATUSES.includes(j.status) && j.status !== "completed").length,
    [jobs]
  );

  const dueJobs = useMemo(() => {
    return jobs
      .map((j) => ({ ...j, due: dueState(j.dueDate, j.status) }))
      .filter((j) => j.due)
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  }, [jobs]);
  const overdueCount = dueJobs.filter((j) => j.due === "overdue").length;
  const dueTodayCount = dueJobs.filter((j) => j.due === "today").length;

  const handleSaveRevenue = async () => {
    try {
      const response = (await apiClient.put('/dashboard/monthly-target', { monthlyTarget: tempMonthlyTarget })) as { monthlyTarget?: number };
      setStats((prev) => (prev ? { ...prev, monthlyTarget: response?.monthlyTarget ?? tempMonthlyTarget } : prev));
      setIsEditingRevenue(false);
      toast({ title: "Monthly target updated" });
    } catch (error) {
      toast({ title: "Target not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          Loading dashboard…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <EmptyState
        className="h-64"
        title="Welcome to Terralabs ERP"
        description="Please sign in to access your dashboard"
        action={<Button onClick={() => navigate('/auth')}>Go to Sign In</Button>}
      />
    );
  }

  if (user.role === 'staff') {
    return <StaffDashboard />;
  }

  const loadingStats = !stats && !statsError;
  const s = stats;
  const target = isEditingRevenue ? tempMonthlyTarget : s?.monthlyTarget || 0;
  const invoiced = s?.invoicedThisMonth ?? 0;
  const targetPct = target > 0 ? Math.round((invoiced / target) * 100) : 0;
  const firstName = (user.fullName || "").split(" ")[0];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const scrollToDeadlines = () =>
    document.getElementById("deadlines")?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Exceptions that need someone's attention today, most urgent first.
  const attention: AttentionItem[] = [
    overdueCount > 0 && { tone: "danger", icon: CircleAlert, label: `${plural(overdueCount, "job")} overdue`, onClick: scrollToDeadlines },
    dueTodayCount > 0 && { tone: "warning", icon: CalendarClock, label: `${plural(dueTodayCount, "job")} due today`, onClick: scrollToDeadlines },
    has(s?.urgentJobs) && s.urgentJobs > 0 && { tone: "warning", icon: Zap, label: plural(s.urgentJobs, "rush job"), href: "/production" },
    has(s?.lowStockItems) && s.lowStockItems > 0 && { tone: "warning", icon: Layers, label: `${plural(s.lowStockItems, "material")} low on stock`, href: "/inventory" },
    has(s?.overdueInvoices) && s.overdueInvoices > 0 && { tone: "info", icon: FileWarning, label: `${plural(s.overdueInvoices, "invoice")} overdue for payment`, href: hasPermission("Payment Reminders") ? "/payment-reminders" : "/invoices" },
  ].filter(Boolean) as AttentionItem[];

  const shopRows = [
    has(s?.pendingDeliveries) && { label: "Awaiting dispatch", value: String(s.pendingDeliveries), icon: Truck, href: "/delivery", warn: false, source: sources.pendingDeliveries },
    has(s?.lowStockItems) && { label: "Low-stock materials", value: String(s.lowStockItems), icon: Layers, href: "/inventory", warn: s.lowStockItems > 0, source: sources.lowStockItems },
    has(s?.totalCustomers) && { label: "Customers", value: String(s.totalCustomers), icon: Users, href: "/customers", warn: false, source: undefined },
    has(s?.cashBalance) && { label: "Cash balance", value: formatINR(s.cashBalance, { compact: true }), icon: Wallet, href: "/accounts", warn: false, source: sources.cashBalance },
    has(s?.bankBalance) && { label: "Bank balance", value: formatINR(s.bankBalance, { compact: true }), icon: Landmark, href: "/accounts", warn: false, source: sources.bankBalance },
  ].filter(Boolean) as { label: string; value: string; icon: LucideIcon; href: string; warn: boolean; source?: string }[];

  const tiles: React.ReactNode[] = [];
  if (canSeeJobs) {
    tiles.push(
      <KpiTile
        key="production"
        label="In production"
        icon={Factory}
        value={inProduction}
        loading={jobsLoading}
        hint={has(s?.urgentJobs) && s.urgentJobs > 0 ? plural(s.urgentJobs, "rush job") : has(s?.todaysJobs) ? `${s.todaysJobs} new today` : undefined}
        tone={has(s?.urgentJobs) && s.urgentJobs > 0 ? "warning" : "default"}
        href="/production"
      />,
      <KpiTile
        key="due"
        label="Due today"
        icon={CalendarClock}
        value={dueTodayCount}
        loading={jobsLoading}
        hint={overdueCount > 0 ? `${overdueCount} overdue` : "Nothing overdue"}
        tone={overdueCount > 0 ? "danger" : dueTodayCount > 0 ? "warning" : "success"}
        href="/production"
      />
    );
  }
  if (loadingStats || has(s?.collectedToday)) {
    tiles.push(
      <KpiTile key="collected" label="Collected today" icon={IndianRupee} value={formatINR(s?.collectedToday ?? 0, { compact: true })} loading={loadingStats} hint="Payments recorded today" href={hasPermission("Payments") ? "/payments" : undefined} />
    );
  }
  if (loadingStats || has(s?.invoicedThisMonth)) {
    tiles.push(
      <KpiTile
        key="invoiced"
        label="Invoiced this month"
        icon={Target}
        value={formatINR(invoiced, { compact: true })}
        loading={loadingStats}
        progress={targetPct}
        hint={target ? `${targetPct}% of your ${formatINR(target, { compact: true })} target` : "Issued invoices"}
        tone={targetPct >= 100 ? "success" : "default"}
        href="/invoices"
      />
    );
  }
  if (loadingStats || has(s?.receivables)) {
    tiles.push(
      <KpiTile
        key="receivables"
        label="Receivables"
        icon={FileWarning}
        value={formatINR(s?.receivables ?? 0, { compact: true })}
        loading={loadingStats}
        hint={has(s?.unpaidInvoices) ? `${plural(s.unpaidInvoices, "unpaid invoice")}${s.overdueInvoices ? ` · ${s.overdueInvoices} overdue` : ""}` : undefined}
        tone={has(s?.overdueInvoices) && s.overdueInvoices > 0 ? "warning" : "default"}
        href={hasPermission("Payment Reminders") ? "/payment-reminders" : "/invoices?view=overdue"}
      />
    );
  }
  const tileCols = tiles.length >= 6 ? "xl:grid-cols-6" : tiles.length === 5 ? "xl:grid-cols-5" : tiles.length === 4 ? "xl:grid-cols-4" : "xl:grid-cols-3";

  return (
    <PageShell>
      <PageHeader
        eyebrow={format(new Date(), "EEEE, d MMMM yyyy")}
        title={`${greeting(new Date())}${firstName ? `, ${firstName}` : ""}`}
        description={
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
            Live shop-floor view · updated {format(lastUpdated, "HH:mm")}
          </span>
        }
        actions={
          <>
            <DashboardShortcuts
              onJobCreated={refresh}
              onQuotationCreated={refresh}
              onOrderCreated={refresh}
              onCustomerCreated={refresh}
            />
            {hasPermission("Staff & Tasks: Assign Tasks") && <QuickReminderDialog onReminderCreated={refresh} />}
          </>
        }
      />

      {/* What needs attention right now */}
      {(statsError || jobsError) && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/35 bg-warning-soft px-3 py-2 text-sm text-warning-strong">
          <span className="inline-flex items-center gap-2 font-medium">
            <CircleAlert className="h-4 w-4 shrink-0" />
            Some live figures are unavailable. Retry to refresh the dashboard.
          </span>
          <Button size="xs" variant="outline" onClick={refresh}>Retry</Button>
        </div>
      )}
      {!loadingStats && !jobsLoading && !statsError && !jobsError && <AttentionBar items={attention} />}

      {/* Headline numbers: only the ones this login's permissions cover */}
      {tiles.length > 0 && (
        <section aria-label="Key figures" className={cn("grid grid-cols-2 gap-3 md:grid-cols-3", tileCols)}>
          {tiles}
        </section>
      )}

      {canSeeJobs && <PipelineStrip counts={stageCounts} loading={jobsLoading} />}

      {/* Deadlines, shop status and the monthly target */}
      <section className={cn("grid grid-cols-1 gap-4", canSeeJobs && "xl:grid-cols-3")}>
        {canSeeJobs && (
        <Panel
          id="deadlines"
          className="scroll-mt-4 xl:col-span-2"
          title="Deadlines"
          description="Open jobs overdue or due in the next two days"
          count={jobsLoading ? undefined : dueJobs.length}
          countTone={overdueCount > 0 ? "danger" : dueTodayCount > 0 ? "warning" : "default"}
          action={<PanelLink to="/jobs">All job tickets</PanelLink>}
        >
          {jobsLoading ? (
            <div className="space-y-2 p-4 sm:p-5">
              {[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />)}
            </div>
          ) : dueJobs.length === 0 ? (
            <EmptyState
              compact
              tone="success"
              icon={Check}
              title="No deadlines at risk"
              description="Every open job is due later than two days from now."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/60 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5 sm:px-5">Job</th>
                    <th className="hidden px-3 py-2.5 md:table-cell">Customer</th>
                    <th className="hidden px-3 py-2.5 sm:table-cell">Stage</th>
                    <th className="px-4 py-2.5 text-right sm:px-5">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {dueJobs.slice(0, 8).map((job) => (
                    <tr
                      key={job._id || job.id}
                      className={cn(
                        "border-b last:border-0 hover:bg-muted/50",
                        job.due === "overdue" && "bg-destructive-soft/40"
                      )}
                    >
                      <td className="w-full max-w-0 px-4 py-2.5 sm:px-5">
                        <div className="truncate font-medium">{job.title}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          <span className="md:hidden">{job.customerId?.name || job.customerName || "—"}</span>
                          {job.printSpecs?.quantity > 1 && (
                            <span className="hidden md:inline">
                              {job.printSpecs.quantity.toLocaleString("en-IN")} pcs
                              {job.printSpecs.paperType ? ` · ${job.printSpecs.paperType}` : ""}
                            </span>
                          )}
                        </div>
                        <JobStatusBadge status={job.status} className="mt-1.5 sm:hidden" />
                      </td>
                      <td className="hidden max-w-[200px] truncate whitespace-nowrap px-3 py-2.5 text-muted-foreground md:table-cell">
                        {job.customerId?.name || job.customerName || "—"}
                      </td>
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        <JobStatusBadge status={job.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right sm:px-5">
                        <DuePill due={job.due} dueDate={job.dueDate} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {dueJobs.length > 8 && (
                <div className="border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
                  Showing 8 of {dueJobs.length}.{" "}
                  <Link to="/production" className="font-medium text-primary hover:underline">
                    See them all on the board
                  </Link>
                </div>
              )}
            </div>
          )}
        </Panel>
        )}

        <div className={cn("flex flex-col gap-4", !canSeeJobs && "md:grid md:grid-cols-2")}>
          {shopRows.length > 0 && (
          <Panel title="Shop status" description="Dispatch, materials and account balances">
            <ul className="divide-y">
              {shopRows.map((row) => (
                <li key={row.label}>
                  <Link
                    to={row.href}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-5"
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
                        row.warn && "bg-warning-soft text-warning-strong"
                      )}
                    >
                      <row.icon className="h-4 w-4" />
                    </span>
                    <span className={cn("flex-1 text-sm", row.warn ? "font-medium text-foreground" : "text-muted-foreground")}>
                      {row.label}
                    </span>
                    <span className={cn("num text-sm font-semibold", row.warn && "text-warning-strong")} title={row.source}>
                      {loadingStats ? "—" : row.value}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          )}

          {has(s?.invoicedThisMonth) && (
          <Panel
            title="Invoiced vs target"
            description="Issued invoices this month"
            action={
              !canSetTarget ? undefined : !isEditingRevenue ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setIsEditingRevenue(true);
                    setTempMonthlyTarget(s?.monthlyTarget || 0);
                  }}
                >
                  <Pencil /> Edit target
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="icon-xs" onClick={handleSaveRevenue} className="text-success-strong" aria-label="Save target">
                    <Check />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      setIsEditingRevenue(false);
                      setTempMonthlyTarget(s?.monthlyTarget || 0);
                    }}
                    className="text-destructive-strong"
                    aria-label="Cancel editing target"
                  >
                    <X />
                  </Button>
                </>
              )
            }
          >
            <div className="space-y-3 p-4 sm:p-5">
              <div className="grid grid-cols-3 gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">This month</div>
                  <div className="num mt-1 truncate text-base font-semibold">{formatINR(invoiced, { compact: true })}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Target</div>
                  {isEditingRevenue ? (
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-sm text-muted-foreground">₹</span>
                      <Input
                        type="number"
                        value={tempMonthlyTarget / 1000}
                        onChange={(e) => setTempMonthlyTarget(Number(e.target.value) * 1000)}
                        className="h-7 w-20 px-2 text-right font-semibold"
                        min="0"
                        step="10"
                        aria-label="Monthly target in thousands of rupees"
                      />
                      <span className="text-sm text-muted-foreground">K</span>
                    </div>
                  ) : (
                    <div className="num mt-1 truncate text-base font-semibold">{formatINR(s?.monthlyTarget || 0, { compact: true })}</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Achieved</div>
                  <div className={cn("num mt-1 text-base font-semibold", targetPct >= 100 ? "text-success-strong" : "text-foreground")}>
                    {targetPct}%
                  </div>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(targetPct, 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly target achieved">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", targetPct >= 100 ? "bg-success" : "bg-primary")}
                  style={{ width: `${Math.min(targetPct, 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {targetPct >= 100
                  ? "Target achieved for this month."
                  : `${formatINR(Math.max(target - invoiced, 0), { compact: true })} to go this month.`}
              </p>
            </div>
          </Panel>
          )}
        </div>
      </section>

      {/* Team workload, for the admin and managers who see all staff data */}
      {seesWholeTeam && <TeamWorkloadPanel />}

      {/* Follow-ups */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {hasPermission("Invoicing") && <PaymentDuesWidget onRefresh={refresh} />}
        <TaskWidget onRefresh={refresh} />
        <NotificationCenter className={hasPermission("Invoicing") ? "lg:col-span-2 xl:col-span-1" : undefined} />
      </section>
    </PageShell>
  );
}

interface AttentionItem {
  tone: "danger" | "warning" | "info";
  icon: LucideIcon;
  label: string;
  href?: string;
  onClick?: () => void;
}

const ATTENTION_TONES: Record<AttentionItem["tone"], string> = {
  danger: "border-destructive/30 bg-destructive-soft text-destructive-strong hover:border-destructive/50",
  warning: "border-warning/35 bg-warning-soft text-warning-strong hover:border-warning/60",
  info: "border-info/25 bg-info-soft text-info-strong hover:border-info/50",
};

/** A single row of the exceptions that need action, or an all-clear. */
function AttentionBar({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success-soft px-3 py-2 text-sm text-success-strong">
        <CircleCheck className="h-4 w-4 shrink-0" />
        <span className="font-medium">All clear</span>
        <span className="hidden text-success-strong/80 sm:inline">— no overdue or rush jobs flagged.</span>
      </div>
    );
  }

  const chip = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0";
  return (
    <section aria-label="Needs attention" className="flex flex-wrap items-center gap-2">
      <span className="section-label mr-1">Needs attention</span>
      {items.map((item) =>
        item.href ? (
          <Link key={item.label} to={item.href} className={cn(chip, ATTENTION_TONES[item.tone])}>
            <item.icon />
            {item.label}
          </Link>
        ) : (
          <button key={item.label} type="button" onClick={item.onClick} className={cn(chip, ATTENTION_TONES[item.tone])}>
            <item.icon />
            {item.label}
          </button>
        )
      )}
    </section>
  );
}

/** How soon a job is due: late jobs show how late, the rest show the day. */
function DuePill({ due, dueDate }: { due: "overdue" | "today" | "soon"; dueDate: string }) {
  const date = new Date(dueDate);
  const days = differenceInCalendarDays(date, new Date());
  const label =
    due === "overdue" ? `${-days}d late` : due === "today" ? "Today" : days === 1 ? "Tomorrow" : format(date, "d MMM");
  return (
    <span
      title={format(date, "EEE, d MMM yyyy")}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold",
        due === "overdue" && "bg-destructive-soft text-destructive-strong",
        due === "today" && "bg-warning-soft text-warning-strong",
        due === "soon" && "bg-muted font-medium text-muted-foreground"
      )}
    >
      {due === "overdue" && <CircleAlert className="h-3 w-3" />}
      {label}
    </span>
  );
}
