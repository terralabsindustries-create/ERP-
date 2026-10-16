import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format, formatDistanceToNow } from "date-fns";
import { AlertTriangle, PauseCircle, CalendarClock, Users, Info, Activity, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { JobStatusBadge } from "@/components/jobs/JobStatusBadge";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { TASK_STATUS, type TaskStatus } from "@/lib/taskMeta";

interface MemberSummary {
  user: { _id: string; fullName: string; role: string; department?: string; isActive: boolean };
  tasks: {
    open: number;
    inProgress: number;
    onHold: number;
    overdue: number;
    dueSoon: number;
    completed: number;
    onTime: number;
    late: number;
    noDueDate: number;
    avgDaysLate: number | null;
  };
  jobs: { handling: number; stageUpdates: number };
  activity: { count: number; lastAt: string | null };
  timeLoggedMinutes: number;
}

interface TaskLine {
  _id: string;
  title: string;
  status: TaskStatus;
  dueDate?: string;
  notes?: string;
  jobTitle?: string;
  updatedAt: string;
  assignee: { fullName: string } | null;
  assigner: { fullName: string } | null;
}

/** GET /api/team/members/:id — the records behind one person's numbers. */
interface MemberDetailData {
  tasks: {
    _id: string;
    title: string;
    status: TaskStatus;
    dueDate?: string;
    completedAt?: string;
    commentCount?: number;
    assigner: { fullName: string } | null;
    timeliness?: { result: "on_time" | "late" | "no_due_date"; daysLate?: number };
  }[];
  jobs: { _id: string; title: string; status: string; dueDate?: string; customerId?: { name?: string } }[];
  activity: { _id: string; description: string; createdAt: string }[];
  timeEntries: { _id: string; taskName: string; jobTitle: string; startTime: string; duration: number }[];
}

interface Overview {
  periodDays: number;
  generatedAt: string;
  members: MemberSummary[];
  blocked: TaskLine[];
  overdue: TaskLine[];
  upcoming: TaskLine[];
  recentUpdates: { _id: string; action: string; description: string; performedByName: string; createdAt: string; entityType: string; entityId: string }[];
}

const hours = (minutes: number) => (minutes ? `${Math.round((minutes / 60) * 10) / 10} h` : "—");

const DEFINITIONS: [string, string][] = [
  ["Open", "Tasks assigned to the person that are not completed or cancelled."],
  ["Overdue", "Open tasks whose due date is before today. A task due today only becomes overdue once that day ends."],
  ["On hold", "Open tasks marked on hold — usually blocked by a customer, material or decision."],
  ["Due ≤ 3d", "Open tasks due today or in the next 3 days."],
  ["Completed", "Tasks completed in the period. On time = finished by the end of the due date; late = after it. Tasks without a due date have no timeliness."],
  ["Jobs handling", "Open job tickets where the person is the assigned handler."],
  ["Job updates", "Job stage changes the person recorded in the period."],
  ["Activity", "Entries the person created in the activity log in the period."],
  ["Time logged", "Minutes on Designer Timer entries for the person in the period."]
];

function TaskList({ tasks, empty, showNotes }: { tasks: TaskLine[]; empty: string; showNotes?: boolean }) {
  if (tasks.length === 0) return <EmptyState compact tone="success" icon={Info} title={empty} />;
  return (
    <ul className="max-h-[22rem] divide-y overflow-y-auto">
      {tasks.map((t) => (
        <li key={t._id}>
          <Link to={`/tasks/${t._id}`} className="block px-4 py-2.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{t.title}</span>
              {t.dueDate && <span className="shrink-0 text-xs text-muted-foreground">{format(new Date(t.dueDate), "d MMM")}</span>}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {t.assignee?.fullName || "Unassigned"}
              {t.assigner ? ` · from ${t.assigner.fullName}` : ""}
              {t.jobTitle ? ` · ${t.jobTitle}` : ""} · updated {formatDistanceToNow(new Date(t.updatedAt), { addSuffix: true })}
            </div>
            {showNotes && t.notes && <div className="mt-1 truncate text-xs italic text-warning-strong">“{t.notes}”</div>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function MemberDetail({ member, days, onClose }: { member: MemberSummary | null; days: number; onClose: () => void }) {
  const [detail, setDetail] = useState<MemberDetailData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!member) return;
    setLoading(true);
    setDetail(null);
    apiClient
      .getTeamMember(member.user._id, days)
      .then((d) => setDetail(d as MemberDetailData))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [member, days]);

  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{member?.user.fullName}</DialogTitle>
          <DialogDescription>
            The records behind the numbers for the last {days} days. Read them together with the kind of work this person does.
          </DialogDescription>
        </DialogHeader>
        {loading || !detail ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}</div>
        ) : (
          <Tabs defaultValue="tasks">
            <TabsList>
              <TabsTrigger value="tasks">Tasks ({detail.tasks.length})</TabsTrigger>
              <TabsTrigger value="jobs">Jobs ({detail.jobs.length})</TabsTrigger>
              <TabsTrigger value="activity">Activity ({detail.activity.length})</TabsTrigger>
              <TabsTrigger value="time">Time ({detail.timeEntries.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="tasks">
              {detail.tasks.length === 0 ? (
                <EmptyState compact icon={Info} title="No open or recently completed tasks" />
              ) : (
                <ul className="divide-y rounded-lg border">
                  {detail.tasks.map((t) => {
                    const s = TASK_STATUS[t.status] || TASK_STATUS.pending;
                    return (
                      <li key={t._id} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <Link to={`/tasks/${t._id}`} className="truncate text-sm font-medium hover:underline">{t.title}</Link>
                          <div className="text-xs text-muted-foreground">
                            {t.dueDate ? `Due ${format(new Date(t.dueDate), "d MMM")}` : "No due date"}
                            {t.completedAt ? ` · done ${format(new Date(t.completedAt), "d MMM")}` : ""}
                            {t.assigner ? ` · from ${t.assigner.fullName}` : ""}
                            {t.commentCount ? ` · ${t.commentCount} comment${t.commentCount === 1 ? "" : "s"}` : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {t.timeliness?.result === "on_time" && <Badge variant="success">On time</Badge>}
                          {t.timeliness?.result === "late" && <Badge variant="destructive">{t.timeliness.daysLate}d late</Badge>}
                          {t.timeliness?.result === "no_due_date" && <Badge variant="secondary">No due date</Badge>}
                          <Badge variant={s.variant}>{s.label}</Badge>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="jobs">
              {detail.jobs.length === 0 ? (
                <EmptyState compact icon={Info} title="Not the handler on any job" />
              ) : (
                <ul className="divide-y rounded-lg border">
                  {detail.jobs.map((j) => (
                    <li key={j._id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{j.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {j.customerId?.name || "—"}
                          {j.dueDate ? ` · due ${format(new Date(j.dueDate), "d MMM")}` : ""}
                        </div>
                      </div>
                      <JobStatusBadge status={j.status} />
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="activity">
              {detail.activity.length === 0 ? (
                <EmptyState compact icon={Activity} title="No recorded activity in this period" />
              ) : (
                <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
                  {detail.activity.map((a) => (
                    <li key={a._id} className="px-3 py-2 text-sm">
                      <div>{a.description}</div>
                      <div className="text-xs text-muted-foreground">{format(new Date(a.createdAt), "d MMM yyyy, HH:mm")}</div>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="time">
              {detail.timeEntries.length === 0 ? (
                <EmptyState compact icon={Info} title="No time logged in this period" />
              ) : (
                <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
                  {detail.timeEntries.map((t) => (
                    <li key={t._id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate">{t.taskName} · {t.jobTitle}</div>
                        <div className="text-xs text-muted-foreground">{format(new Date(t.startTime), "d MMM, HH:mm")}</div>
                      </div>
                      <span className="num shrink-0">{hours(t.duration)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Workload, deadlines and completed work across the team, with the records behind every number. */
export default function TeamOverview() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const team = params.get("team") || "all";
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [teams, setTeams] = useState<{ _id: string; name: string }[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [selected, setSelected] = useState<MemberSummary | null>(null);

  // Teams from User Management, to narrow the overview to one of them.
  useEffect(() => {
    apiClient
      .getTeams()
      .then((r) => setTeams((r?.teams || []) as { _id: string; name: string }[]))
      .catch(() => setTeams([]));
  }, []);

  const load = useCallback(async () => {
    try {
      setData((await apiClient.getTeamOverview(days, team === "all" ? undefined : team)) as Overview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/permission/i.test(message)) setForbidden(true);
      else toast({ title: "The team overview could not be loaded", description: message, variant: "destructive" });
    }
  }, [days, team, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (forbidden) {
    return (
      <PageShell width="default">
        <div className="rounded-xl border bg-card shadow-card">
          <EmptyState icon={Users} title="Team overview is for the admin and managers" description="It needs Staff & Tasks and “Can view all staff data” on your login." />
        </div>
      </PageShell>
    );
  }

  const members = (data?.members || []).filter((m) => m.user.role !== "admin" || m.tasks.open || m.tasks.completed);

  return (
    <PageShell>
      <PageHeader
        eyebrow="People"
        title="Team overview"
        description={
          team === "all"
            ? "Workload, deadlines and completed work for everyone in the business"
            : `Workload, deadlines and completed work for the ${teams.find((t) => t._id === team)?.name || ""} team`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {teams.length > 0 && (
              <Select
                value={team}
                onValueChange={(v) => {
                  setData(null);
                  setParams(v === "all" ? {} : { team: v }, { replace: true });
                }}
              >
                <SelectTrigger className="w-[170px]" aria-label="Team">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  {teams.map((t) => (
                    <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[150px]" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-sm text-info-strong">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          These are counts of records, not a score. Task size, blockers and role differ from person to person — open someone to see the tasks, jobs and
          activity behind their numbers before drawing conclusions.
        </span>
      </div>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Overdue" icon={AlertTriangle} count={data?.overdue.length} countTone={data?.overdue.length ? "danger" : "default"} description="Open tasks past their due date">
          {data ? <TaskList tasks={data.overdue} empty="Nothing overdue" /> : <div className="h-24 animate-pulse bg-muted/40" />}
        </Panel>
        <Panel title="On hold" icon={PauseCircle} count={data?.blocked.length} countTone={data?.blocked.length ? "warning" : "default"} description="Blocked work and what it is waiting on">
          {data ? <TaskList tasks={data.blocked} empty="Nothing on hold" showNotes /> : <div className="h-24 animate-pulse bg-muted/40" />}
        </Panel>
        <Panel title="Due in the next 7 days" icon={CalendarClock} count={data?.upcoming.length}>
          {data ? <TaskList tasks={data.upcoming} empty="Nothing due this week" /> : <div className="h-24 animate-pulse bg-muted/40" />}
        </Panel>
      </section>

      <Panel title="Workload and completed work" icon={Users} description={`Last ${days} days · select a person to see their records`}>
        {!data ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}</div>
        ) : members.length === 0 ? (
          <EmptyState compact icon={Users} title="No team members yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/60 text-left">
                  <th className="px-4 py-2.5 sm:px-5">Person</th>
                  <th className="px-3 py-2.5 text-right">Open</th>
                  <th className="px-3 py-2.5 text-right">Overdue</th>
                  <th className="px-3 py-2.5 text-right">On hold</th>
                  <th className="px-3 py-2.5 text-right">Due ≤ 3d</th>
                  <th className="px-3 py-2.5 text-right">Completed</th>
                  <th className="px-3 py-2.5">On time / late</th>
                  <th className="px-3 py-2.5 text-right">Jobs</th>
                  <th className="px-3 py-2.5 text-right">Time</th>
                  <th className="px-4 py-2.5 sm:px-5">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr
                    key={m.user._id}
                    tabIndex={0}
                    onClick={() => setSelected(m)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(m))}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  >
                    <td className="px-4 py-3 sm:px-5">
                      <div className="font-medium">{m.user.fullName}</div>
                      <div className="text-xs capitalize text-muted-foreground">
                        {m.user.role}
                        {m.user.department ? ` · ${m.user.department}` : ""}
                        {!m.user.isActive ? " · inactive" : ""}
                      </div>
                    </td>
                    <td className="num px-3 py-3 text-right">{m.tasks.open}</td>
                    <td className={cn("num px-3 py-3 text-right", m.tasks.overdue && "font-semibold text-destructive-strong")}>{m.tasks.overdue}</td>
                    <td className={cn("num px-3 py-3 text-right", m.tasks.onHold && "text-warning-strong")}>{m.tasks.onHold}</td>
                    <td className="num px-3 py-3 text-right">{m.tasks.dueSoon}</td>
                    <td className="num px-3 py-3 text-right">{m.tasks.completed}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs">
                      {m.tasks.completed === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span>
                          <span className="text-success-strong">{m.tasks.onTime} on time</span>
                          {" · "}
                          <span className={m.tasks.late ? "text-destructive-strong" : "text-muted-foreground"}>
                            {m.tasks.late} late{m.tasks.avgDaysLate ? ` (avg ${m.tasks.avgDaysLate}d)` : ""}
                          </span>
                          {m.tasks.noDueDate ? <span className="text-muted-foreground"> · {m.tasks.noDueDate} no date</span> : null}
                        </span>
                      )}
                    </td>
                    <td className="num px-3 py-3 text-right" title={`${m.jobs.handling} open jobs handled, ${m.jobs.stageUpdates} stage updates`}>
                      {m.jobs.handling}
                      {m.jobs.stageUpdates ? <span className="text-xs text-muted-foreground"> / {m.jobs.stageUpdates} upd.</span> : null}
                    </td>
                    <td className="num px-3 py-3 text-right">{hours(m.timeLoggedMinutes)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground sm:px-5">
                      {m.activity.lastAt ? formatDistanceToNow(new Date(m.activity.lastAt), { addSuffix: true }) : "None recorded"}
                      {m.activity.count ? ` · ${m.activity.count} ${m.activity.count === 1 ? "entry" : "entries"}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Recent task and job updates" icon={Activity} action={<Button variant="ghost" size="xs" asChild><Link to="/activity-log">Activity log <ArrowRight /></Link></Button>}>
          {!data ? (
            <div className="h-24 animate-pulse bg-muted/40" />
          ) : data.recentUpdates.length === 0 ? (
            <EmptyState compact icon={Activity} title="No updates recorded yet" />
          ) : (
            <ul className="max-h-[26rem] divide-y overflow-y-auto">
              {data.recentUpdates.map((u) => (
                <li key={u._id} className="px-4 py-2.5 text-sm sm:px-5">
                  <div>
                    {u.entityType === "task" ? (
                      <Link to={`/tasks/${u.entityId}`} className="hover:underline">{u.description}</Link>
                    ) : (
                      u.description
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.performedByName} · {formatDistanceToNow(new Date(u.createdAt), { addSuffix: true })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="How these numbers are counted" icon={Info}>
          <dl className="space-y-2.5 p-4 text-sm sm:p-5">
            {DEFINITIONS.map(([term, def]) => (
              <div key={term}>
                <dt className="font-medium">{term}</dt>
                <dd className="text-xs text-muted-foreground">{def}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </section>

      <MemberDetail member={selected} days={days} onClose={() => setSelected(null)} />
    </PageShell>
  );
}
