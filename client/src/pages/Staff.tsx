import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { addDays, differenceInCalendarDays } from "date-fns";
import { BarChart3, Calendar, CheckCircle, ClipboardList, ExternalLink, KeyRound, Mail, MessageSquare, Pencil, Play, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { StatusIndicator } from "@/components/users/parts";
import { CreateTaskDialog } from "@/components/staff/CreateTaskDialog";
import { EditTaskDialog } from "@/components/staff/EditTaskDialog";
import { CommentDialog } from "@/components/staff/CommentDialog";
import { ScheduleDialog } from "@/components/staff/ScheduleDialog";
import { EditStaffDialog } from "@/components/staff/EditStaffDialog";
import { StaffCredentialsDialog } from "@/components/staff/StaffCredentialsDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { dueLabel, fmtDate, humanize, plural } from "@/lib/format";
import { userState, type ManagedUser } from "@/lib/userAdmin";
import { cn } from "@/lib/utils";

type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled" | "on_hold";
type Priority = "low" | "medium" | "high" | "urgent";

interface Task {
  _id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  dueDate?: string;
  assignedTo?: { _id: string; fullName: string; role?: string } | string | null;
  jobId?: { _id: string; title?: string } | string | null;
  jobTitle?: string;
  comments?: unknown[];
  progress?: number;
}

interface Shift {
  _id: string;
  staffId: { _id: string } | string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  shiftType?: string;
}

interface Stats {
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  activeTasks: number;
}

type Section = "tasks" | "team";
type TaskView = "open" | "overdue" | "week" | "completed" | "all";

const TASK_LIMIT = 200;
const STATUS: Record<TaskStatus, { label: string; tone: PillTone }> = {
  pending: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  on_hold: { label: "On hold", tone: "warning" },
  completed: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" }
};
const PRIORITY: Record<Priority, { label: string; className: string }> = {
  urgent: { label: "Urgent", className: "border-destructive/30 bg-destructive-soft text-destructive-strong" },
  high: { label: "High", className: "border-warning/30 bg-warning-soft text-warning-strong" },
  medium: { label: "Medium", className: "" },
  low: { label: "Low", className: "text-muted-foreground" }
};
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const ROLE_LABEL: Record<string, string> = { admin: "Owner", manager: "Manager", accountant: "Accountant", staff: "Staff" };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const isOpen = (t: Task) => t.status !== "completed" && t.status !== "cancelled";
const dueIn = (t: Task) => (t.dueDate ? differenceInCalendarDays(new Date(t.dueDate), new Date()) : null);
// Overdue once the due day has ended, the rule the team overview uses.
const isOverdue = (t: Task) => isOpen(t) && (dueIn(t) ?? 0) < 0;
const assigneeOf = (t: Task) => (t.assignedTo && typeof t.assignedTo === "object" ? t.assignedTo : null);
const assigneeId = (t: Task) => (typeof t.assignedTo === "string" ? t.assignedTo : t.assignedTo?._id);
const jobOf = (t: Task) => (t.jobId && typeof t.jobId === "object" ? t.jobId.title : undefined) || t.jobTitle;

/** The next shift on or after today: "Today 09:00–17:00", "Tue 10:00–18:00". */
function nextShift(shifts: Shift[]) {
  if (!shifts.length) return null;
  const today = new Date().getDay();
  for (let i = 0; i < 7; i++) {
    const day = DAYS[(today + i) % 7];
    const s = shifts.filter((x) => x.dayOfWeek.toLowerCase() === day).sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
    if (s) {
      const when = i === 0 ? "Today" : i === 1 ? "Tomorrow" : addDays(new Date(), i).toLocaleDateString("en-GB", { weekday: "short" });
      return { when, time: `${s.startTime}–${s.endTime}`, type: s.shiftType, perWeek: shifts.length };
    }
  }
  return null;
}

export default function Staff() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";
  const canSeeTeam = isAdmin || user?.role === "manager" || hasPermission("User Management");

  const [section, setSection] = useState<Section>("tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [people, setPeople] = useState<ManagedUser[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingTeam, setLoadingTeam] = useState(true);

  const [view, setView] = useState<TaskView>("open");
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("all");
  const [priority, setPriority] = useState("all");
  const [teamSearch, setTeamSearch] = useState("");
  const [teamRole, setTeamRole] = useState("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [commenting, setCommenting] = useState<Task | null>(null);
  const [scheduling, setScheduling] = useState<ManagedUser | null>(null);
  const [editingPerson, setEditingPerson] = useState<ManagedUser | null>(null);
  const [credentials, setCredentials] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState<ManagedUser | null>(null);

  const loadTasks = useCallback(async () => {
    setLoadingTasks(true);
    try {
      const [list, s] = (await Promise.all([apiClient.getTasks({ limit: TASK_LIMIT, sortBy: "dueDate", sortOrder: "asc" }), apiClient.getTaskStats()])) as [
        { data?: Task[]; pagination?: { total?: number } } | Task[],
        Stats
      ];
      const rows = Array.isArray(list) ? list : list?.data || [];
      setTasks(rows);
      setTaskTotal(Array.isArray(list) ? rows.length : list?.pagination?.total ?? rows.length);
      setStats(s || null);
    } catch (error) {
      toast({ title: "Tasks could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoadingTasks(false);
    }
  }, [toast]);

  const loadTeam = useCallback(async () => {
    if (!canSeeTeam) return setLoadingTeam(false);
    setLoadingTeam(true);
    try {
      const [res, overview] = await Promise.all([
        apiClient.getUsers({ limit: 100, sortBy: "fullName", sortOrder: "asc" }) as Promise<{ users?: ManagedUser[] }>,
        (apiClient.getScheduleOverview() as Promise<{ data?: Shift[] } | Shift[]>).catch(() => [] as Shift[])
      ]);
      setPeople(res?.users || []);
      setShifts(Array.isArray(overview) ? overview : overview?.data || []);
    } catch (error) {
      toast({ title: "The team could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoadingTeam(false);
    }
  }, [canSeeTeam, toast]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);
  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  const setTaskStatus = async (t: Task, status: TaskStatus) => {
    try {
      await apiClient.updateTaskStatus(t._id, status);
      toast({ title: status === "completed" ? "Task done" : `Task ${STATUS[status].label.toLowerCase()}`, description: t.title });
      loadTasks();
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const removePerson = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteUser(deleting._id);
      toast({ title: "Login deleted", description: deleting.fullName });
      setDeleting(null);
      loadTeam();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const resendInvite = async (p: ManagedUser) => {
    try {
      await apiClient.resendInvitation(p._id);
      toast({ title: "Invitation sent", description: `A new link was emailed to ${p.email}.` });
      loadTeam();
    } catch (error) {
      toast({ title: "Invitation not sent", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  // --- Tasks ---------------------------------------------------------------
  const open = tasks.filter(isOpen);
  const dueThisWeek = open.filter((t) => {
    const n = dueIn(t);
    return n !== null && n >= 0 && n <= 7;
  });
  const overdueCount = stats?.overdueTasks ?? tasks.filter(isOverdue).length;

  const taskRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => {
        if (view === "open" && !isOpen(t)) return false;
        if (view === "overdue" && !isOverdue(t)) return false;
        if (view === "week" && !dueThisWeek.includes(t)) return false;
        if (view === "completed" && t.status !== "completed") return false;
        if (assignee !== "all" && (assignee === "none" ? !!assigneeId(t) : assigneeId(t) !== assignee)) return false;
        if (priority !== "all" && t.priority !== priority) return false;
        return !q || [t.title, jobOf(t), assigneeOf(t)?.fullName].some((f) => (f || "").toLowerCase().includes(q));
      })
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  }, [tasks, view, assignee, priority, search, dueThisWeek]);

  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    people.forEach((p) => seen.set(p._id, p.fullName));
    tasks.forEach((t) => {
      const a = assigneeOf(t);
      if (a) seen.set(a._id, a.fullName);
    });
    return [...[...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)), { value: "none", label: "Not assigned" }];
  }, [people, tasks]);

  const taskColumns: Column<Task>[] = [
    {
      id: "title",
      header: "Task",
      cell: (t) => (
        <Stack
          top={
            <Link to={`/tasks/${t._id}`} onClick={(e) => e.stopPropagation()} className={cn("font-medium hover:underline", t.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
              {t.title}
            </Link>
          }
          bottom={jobOf(t) ? `Job · ${jobOf(t)}` : undefined}
        />
      ),
      sortValue: (t) => t.title.toLowerCase(),
      className: "min-w-[240px]"
    },
    {
      id: "assignee",
      header: "Assigned to",
      cell: (t) => {
        const a = assigneeOf(t);
        return a ? <EntityCell avatar={a.fullName} title={<span className="font-normal">{a.fullName}</span>} /> : <span className="text-muted-foreground">Not assigned</span>;
      },
      sortValue: (t) => assigneeOf(t)?.fullName || "~",
      hideBelow: "md"
    },
    {
      id: "priority",
      header: "Priority",
      cell: (t) => <Tag className={PRIORITY[t.priority]?.className}>{PRIORITY[t.priority]?.label || t.priority}</Tag>,
      sortValue: (t) => PRIORITY_RANK[t.priority],
      hideBelow: "lg"
    },
    {
      id: "due",
      header: "Due",
      cell: (t) =>
        t.dueDate ? (
          <Stack
            top={<span className="whitespace-nowrap">{fmtDate(t.dueDate)}</span>}
            bottom={isOpen(t) ? <span className={cn(isOverdue(t) && "font-medium text-destructive-strong", dueIn(t) === 0 && "font-medium text-warning-strong")}>{dueLabel(t.dueDate)}</span> : undefined}
          />
        ) : (
          <span className="text-muted-foreground">No date</span>
        ),
      sortValue: (t) => t.dueDate || "9999"
    },
    {
      id: "status",
      header: "Status",
      cell: (t) => (
        <div className="flex items-center gap-2">
          <StatusPill tone={STATUS[t.status]?.tone}>{STATUS[t.status]?.label || humanize(t.status)}</StatusPill>
          {!!t.comments?.length && (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title={plural(t.comments.length, "comment")}>
              <MessageSquare className="h-3 w-3" />
              {t.comments.length}
            </span>
          )}
        </div>
      ),
      sortValue: (t) => t.status,
      className: "w-[150px]"
    }
  ];

  // --- Team ----------------------------------------------------------------
  const workload = useMemo(() => {
    const m = new Map<string, { open: number; overdue: number; done: number }>();
    tasks.forEach((t) => {
      const id = assigneeId(t);
      if (!id) return;
      const w = m.get(id) || { open: 0, overdue: 0, done: 0 };
      if (isOpen(t)) w.open++;
      if (isOverdue(t)) w.overdue++;
      if (t.status === "completed") w.done++;
      m.set(id, w);
    });
    return m;
  }, [tasks]);

  const shiftsOf = (id: string) => shifts.filter((s) => (typeof s.staffId === "object" ? s.staffId?._id : s.staffId) === id);

  const teamRows = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    return people.filter((p) => (teamRole === "all" || p.role === teamRole) && (!q || [p.fullName, p.email, p.accessRoleName, p.department].some((f) => (f || "").toLowerCase().includes(q))));
  }, [people, teamSearch, teamRole]);

  const teamColumns: Column<ManagedUser>[] = [
    {
      id: "name",
      header: "Person",
      cell: (p) => <EntityCell avatar={p.fullName} title={p.fullName} subtitle={p.email} />,
      sortValue: (p) => p.fullName.toLowerCase(),
      className: "min-w-[240px]"
    },
    {
      id: "role",
      header: "Role",
      cell: (p) => <Stack top={p.accessRoleName || ROLE_LABEL[p.role] || humanize(p.role)} bottom={p.accessRoleName ? ROLE_LABEL[p.role] : p.department} />,
      sortValue: (p) => p.accessRoleName || p.role,
      hideBelow: "md"
    },
    {
      id: "workload",
      header: "Open tasks",
      align: "right",
      cell: (p) => {
        const w = workload.get(p._id);
        if (!w?.open) return <span className="text-muted-foreground">—</span>;
        return (
          <Stack
            className="text-right"
            top={<span className="font-medium">{w.open}</span>}
            bottom={w.overdue ? <span className="font-medium text-destructive-strong">{w.overdue} overdue</span> : undefined}
          />
        );
      },
      sortValue: (p) => workload.get(p._id)?.open || 0
    },
    { id: "done", header: "Done", align: "right", cell: (p) => workload.get(p._id)?.done || <span className="text-muted-foreground">—</span>, sortValue: (p) => workload.get(p._id)?.done || 0, hideBelow: "lg" },
    {
      id: "shift",
      header: "Next shift",
      cell: (p) => {
        if (p.role !== "staff") return <span className="text-muted-foreground">—</span>;
        const s = nextShift(shiftsOf(p._id));
        return s ? <Stack top={`${s.when} · ${s.time}`} bottom={`${s.type ? `${humanize(s.type)} · ` : ""}${plural(s.perWeek, "shift")} a week`} /> : <span className="text-muted-foreground">Not scheduled</span>;
      },
      hideBelow: "xl"
    },
    { id: "status", header: "Status", cell: (p) => <StatusIndicator state={userState(p)} expiresAt={p.invitation?.expiresAt} />, sortValue: (p) => userState(p), className: "w-[200px]" }
  ];

  // The last person a dialog was opened for, so a closing dialog keeps its content.
  const lastPerson = useMemo<ManagedUser>(() => editingPerson || credentials || ({ _id: "", fullName: "", email: "", role: "staff", permissions: [], teams: [] } as ManagedUser), [editingPerson, credentials]);

  const staffForDialogs = (p: ManagedUser) => ({
    id: p._id,
    name: p.fullName,
    fullName: p.fullName,
    email: p.email,
    role: p.role,
    department: p.department || "General",
    status: p.isActive === false ? "inactive" : "active",
    isActive: p.isActive,
    createdAt: p.createdAt
  });

  // Stable objects, so the dialogs only refill their forms when the person changes.
  const editStaff = useMemo(() => staffForDialogs(editingPerson || lastPerson), [editingPerson, lastPerson]);
  const credentialsStaff = useMemo(() => staffForDialogs(credentials || lastPerson), [credentials, lastPerson]);

  const activePeople = people.filter((p) => userState(p) === "active" || userState(p) === "owner").length;

  return (
    <PageShell>
      <PageHeader
        eyebrow="People"
        title="Staff & tasks"
        description="What everyone is working on, what's due and who's on shift."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/team">
                <BarChart3 />
                Team overview
              </Link>
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              New task
            </Button>
          </>
        }
      />

      <MetricBar
        loading={!stats}
        metrics={[
          {
            label: "Open tasks",
            value: open.length,
            hint: stats ? `${stats.activeTasks} in progress` : undefined,
            onClick: () => {
              setSection("tasks");
              setView("open");
            },
            active: section === "tasks" && view === "open"
          },
          {
            label: "Overdue",
            value: overdueCount,
            hint: overdueCount ? "Past their due day" : "Nothing late",
            tone: overdueCount ? "danger" : "default",
            onClick: () => {
              setSection("tasks");
              setView(view === "overdue" ? "open" : "overdue");
            },
            active: section === "tasks" && view === "overdue"
          },
          {
            label: "Due in 7 days",
            value: dueThisWeek.length,
            hint: dueThisWeek.filter((t) => dueIn(t) === 0).length ? `${dueThisWeek.filter((t) => dueIn(t) === 0).length} due today` : "None due today",
            tone: dueThisWeek.length ? "warning" : "default",
            onClick: () => {
              setSection("tasks");
              setView(view === "week" ? "open" : "week");
            },
            active: section === "tasks" && view === "week"
          },
          canSeeTeam
            ? {
                label: "Team",
                value: activePeople,
                hint: `${plural(people.filter((p) => userState(p) === "invited").length, "invite")} waiting`,
                onClick: () => setSection("team"),
                active: section === "team"
              }
            : { label: "Completed", value: stats?.completedTasks ?? 0, hint: "All time", tone: "success" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<Section>
          value={section}
          onChange={setSection}
          tabs={[{ value: "tasks", label: "Tasks", icon: ClipboardList, count: open.length }, ...(canSeeTeam ? [{ value: "team" as const, label: "Team", icon: Users, count: people.length }] : [])]}
        />

        {section === "tasks" ? (
          <DataCard
            toolbar={
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Task view">
                  {(
                    [
                      ["open", "Open", open.length],
                      ["overdue", "Overdue", tasks.filter(isOverdue).length],
                      ["week", "Due in 7 days", dueThisWeek.length],
                      ["completed", "Done", tasks.filter((t) => t.status === "completed").length],
                      ["all", "All", tasks.length]
                    ] as [TaskView, string, number][]
                  ).map(([v, label, n]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                        view === v ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {label}
                      <span className={cn("num", view === v ? "text-primary-foreground/80" : v === "overdue" && n ? "text-destructive-strong" : "")}>{n}</span>
                    </button>
                  ))}
                </div>
                <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search task, job or person" />}>
                  <FilterSelect label="Assigned to" value={assignee} onChange={setAssignee} allLabel="Anyone" options={assigneeOptions} />
                  <FilterSelect label="Priority" value={priority} onChange={setPriority} allLabel="Any" options={(Object.keys(PRIORITY) as Priority[]).map((p) => ({ value: p, label: PRIORITY[p].label }))} />
                </Toolbar>
              </div>
            }
            footer={
              !loadingTasks &&
              taskRows.length > 0 && (
                <span>
                  {plural(taskRows.length, "task")}
                  {taskTotal > tasks.length ? ` · showing the ${TASK_LIMIT} with the earliest due dates of ${taskTotal}` : ""}
                </span>
              )
            }
          >
            <DataTable
              columns={taskColumns}
              rows={taskRows}
              rowKey={(t) => t._id}
              loading={loadingTasks}
              onRowClick={(t) => navigate(`/tasks/${t._id}`)}
              rowClassName={(t) => (isOverdue(t) ? "bg-destructive-soft/30" : undefined)}
              actions={(t) => [
                { label: "Open task", icon: ExternalLink, onClick: () => navigate(`/tasks/${t._id}`) },
                { label: "Start", icon: Play, onClick: () => setTaskStatus(t, "in_progress"), hidden: t.status !== "pending" && t.status !== "on_hold" },
                { label: "Mark done", icon: CheckCircle, onClick: () => setTaskStatus(t, "completed"), hidden: !isOpen(t) },
                { label: "Add a comment", icon: MessageSquare, onClick: () => setCommenting(t) },
                { label: "Edit task", icon: Pencil, onClick: () => setEditing(t), separated: true }
              ]}
              actionsLabel={(t) => `Actions for ${t.title}`}
              mobile={(t) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{t.title}</span>
                    <StatusPill tone={STATUS[t.status]?.tone}>{STATUS[t.status]?.label}</StatusPill>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <Tag className={PRIORITY[t.priority]?.className}>{PRIORITY[t.priority]?.label}</Tag>
                    <span>{assigneeOf(t)?.fullName || "Not assigned"}</span>
                    {t.dueDate && <span className={cn(isOverdue(t) && "font-medium text-destructive-strong")}>· {isOpen(t) ? dueLabel(t.dueDate) : fmtDate(t.dueDate)}</span>}
                  </div>
                </div>
              )}
              empty={
                tasks.length === 0 ? (
                  <EmptyState
                    icon={ClipboardList}
                    title="No tasks yet"
                    description="Create a task, assign it to someone and set a due date. They're notified and can comment on it."
                    action={
                      <Button onClick={() => setCreateOpen(true)}>
                        <Plus />
                        New task
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState compact icon={CheckCircle} title={view === "overdue" ? "Nothing overdue" : "No tasks in this view"} description={view === "overdue" ? "Every open task is on time." : "Try another view, person or priority."} />
                )
              }
            />
          </DataCard>
        ) : (
          <DataCard
            toolbar={
              <Toolbar search={<SearchField value={teamSearch} onChange={setTeamSearch} placeholder="Search name, email or role" />}>
                <FilterSelect
                  label="Role"
                  value={teamRole}
                  onChange={setTeamRole}
                  options={Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))}
                />
                <Button variant="outline" size="sm" asChild>
                  <Link to="/users">
                    <ShieldCheck />
                    Logins & access
                  </Link>
                </Button>
              </Toolbar>
            }
            footer={!loadingTeam && teamRows.length > 0 && <span>{plural(teamRows.length, "person", "people")}</span>}
          >
            <DataTable
              columns={teamColumns}
              rows={teamRows}
              rowKey={(p) => p._id}
              loading={loadingTeam}
              defaultSort={{ id: "name", dir: "asc" }}
              actions={(p) => {
                const owner = p.role === "admin";
                const self = p._id === user?.id;
                return [
                  {
                    label: "See their tasks",
                    icon: ClipboardList,
                    onClick: () => {
                      setAssignee(p._id);
                      setView("open");
                      setSection("tasks");
                    }
                  },
                  { label: "Work schedule", icon: Calendar, onClick: () => setScheduling(p), hidden: p.role !== "staff" },
                  { label: "Edit details", icon: Pencil, onClick: () => setEditingPerson(p), hidden: owner },
                  { label: "Resend invitation", icon: Mail, onClick: () => resendInvite(p), hidden: userState(p) !== "invited" },
                  { label: "Email & password", icon: KeyRound, onClick: () => setCredentials(p), hidden: owner || userState(p) === "invited" || p.role !== "staff" },
                  { label: "Access & role", icon: ShieldCheck, onClick: () => navigate("/users"), hidden: owner },
                  { label: "Delete login", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(p), hidden: !isAdmin || owner || self }
                ];
              }}
              actionsLabel={(p) => `Actions for ${p.fullName}`}
              mobile={(p) => {
                const w = workload.get(p._id);
                return (
                  <div className="flex items-center justify-between gap-3">
                    <EntityCell avatar={p.fullName} title={p.fullName} subtitle={`${p.accessRoleName || ROLE_LABEL[p.role] || p.role}${w?.open ? ` · ${plural(w.open, "open task")}` : ""}`} />
                    <StatusIndicator state={userState(p)} expiresAt={p.invitation?.expiresAt} />
                  </div>
                );
              }}
              empty={<EmptyState compact icon={Users} title={teamSearch || teamRole !== "all" ? "No one matches" : "No one on the team yet"} description={teamSearch || teamRole !== "all" ? undefined : "Invite people from Users & roles."} />}
            />
          </DataCard>
        )}
      </div>

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} onTaskCreated={loadTasks} />
      <EditTaskDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} task={editing} onTaskUpdated={loadTasks} />
      <CommentDialog open={!!commenting} onOpenChange={(o) => !o && setCommenting(null)} task={commenting} onCommentAdded={loadTasks} />
      <ScheduleDialog
        open={!!scheduling}
        onOpenChange={(o) => !o && setScheduling(null)}
        staff={scheduling ? { id: scheduling._id, name: scheduling.fullName, role: scheduling.role, department: scheduling.department || "General" } : { id: "", name: "", role: "", department: "" }}
        onScheduleSaved={loadTeam}
      />
      {/* Kept mounted (only `open` changes) so closing never leaves the page blocked. */}
      <EditStaffDialog
        open={!!editingPerson}
        onOpenChange={(o) => !o && setEditingPerson(null)}
        staff={editStaff}
        onStaffUpdated={() => {
          setEditingPerson(null);
          loadTeam();
        }}
      />
      <StaffCredentialsDialog
        open={!!credentials}
        onOpenChange={(o) => !o && setCredentials(null)}
        staff={credentialsStaff}
        onStaffUpdated={() => {
          setCredentials(null);
          loadTeam();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.fullName || "this login"}?`}
        description="They can no longer sign in. Their tasks and records stay. This can't be undone."
        onConfirm={removePerson}
      />
    </PageShell>
  );
}
