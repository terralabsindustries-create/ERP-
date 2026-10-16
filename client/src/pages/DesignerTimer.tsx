import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, format } from "date-fns";
import { Clock, Pause, Pencil, Play, Plus, RotateCcw, Square, Timer, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type Metric } from "@/components/data";
import { TimeEntrySheet } from "@/components/time-entries/TimeEntrySheet";
import { TimerCard } from "@/components/time-entries/TimerCard";
import { MINUTE, STATUS_META, combine, fmtMinutes, minutesOf, timeSpan, todayRange, weekRange, workLine, workedMs } from "@/components/time-entries/timeMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import { customerOf, loadJobs, loadMyTasks, timeEntriesApi, type JobOption, type ListParams, type Person, type TaskOption, type TimeEntry, type TimeEntryList, type TimeStats, type WorkInput } from "@/lib/api/timeEntries";
import { fmtDate, fmtDateShort, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

type View = "today" | "week" | "all" | "open";

const PAGE_SIZE = 50;
const POLL_MS = 60000;

const errText = (e: unknown) => (e instanceof Error ? e.message : undefined);
const entryNoun = (n: number) => plural(n, "entry", "entries");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const dayLabel = (d: string) => `${format(new Date(d), "EEE")}, ${fmtDate(d)}`;
const minutesAt = (e: TimeEntry, at: number) => Math.round(workedMs(e, at) / MINUTE);

export default function DesignerTimer() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const canTrack = hasPermission("Designer Timer: Track Time");
  const myId = user?.id || "";

  // Pickers and the person filter.
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [pickersLoading, setPickersLoading] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);
  const [canSeeTeam, setCanSeeTeam] = useState(false);

  // The clock: `offset` corrects this device's time to the server's.
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const serverNow = now + offset;

  const [active, setActive] = useState<TimeEntry | null>(null);
  const [stats, setStats] = useState<TimeStats | null>(null);
  const [statsAt, setStatsAt] = useState(0);
  const [list, setList] = useState<TimeEntryList | null>(null);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<View>("today");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [jobFilter, setJobFilter] = useState("all");
  const [person, setPerson] = useState("all");
  const [billable, setBillable] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [deleting, setDeleting] = useState<TimeEntry | null>(null);
  const [restarting, setRestarting] = useState<TimeEntry | null>(null);

  const syncClock = useCallback((serverTime?: string) => {
    if (!serverTime) return;
    setOffset(Date.parse(serverTime) - Date.now());
    setNow(Date.now());
  }, []);

  // ---- loading

  const loadActive = useCallback(
    async (silent = false) => {
      try {
        const res = await timeEntriesApi.active();
        setActive(res.activeTimer);
        syncClock(res.serverTime);
      } catch (error) {
        if (!silent) toast({ title: "Your timer could not be loaded", description: errText(error), variant: "destructive" });
      }
    },
    [toast, syncClock]
  );

  const loadStats = useCallback(
    async (silent = false) => {
      try {
        const res = await timeEntriesApi.stats(todayRange().from, weekRange().from);
        setStats(res.stats);
        setStatsAt(Date.parse(res.serverTime));
      } catch (error) {
        if (!silent) toast({ title: "Totals could not be loaded", description: errText(error), variant: "destructive" });
      }
    },
    [toast]
  );

  const listSeq = useRef(0);
  const loadList = useCallback(
    async (silent = false) => {
      const seq = ++listSeq.current;
      if (!silent) setLoading(true);
      try {
        const params: ListParams = { page, limit: PAGE_SIZE };
        const range = view === "today" ? todayRange() : view === "week" ? weekRange() : null;
        if (range) {
          params.from = range.from.toISOString();
          params.to = range.to.toISOString();
        } else if (view === "all") {
          if (from) params.from = combine(from, "00:00").toISOString();
          if (to) params.to = addDays(combine(to, "00:00"), 1).toISOString();
        } else {
          params.status = "open";
        }
        if (q) params.search = q;
        if (jobFilter !== "all") params.jobId = jobFilter;
        if (person !== "all") params.staffId = person;
        if (billable !== "all") params.billable = billable as "true" | "false";
        const res = await timeEntriesApi.list(params);
        if (seq !== listSeq.current) return;
        setList(res);
        syncClock(res.serverTime);
      } catch (error) {
        if (seq === listSeq.current && !silent) toast({ title: "Time entries could not be loaded", description: errText(error), variant: "destructive" });
      } finally {
        if (seq === listSeq.current) setLoading(false);
      }
    },
    [page, view, from, to, q, jobFilter, person, billable, toast, syncClock]
  );

  const refresh = useCallback((silent = true) => Promise.all([loadActive(silent), loadStats(silent), loadList(silent)]), [loadActive, loadStats, loadList]);

  useEffect(() => {
    loadActive();
    loadStats();
    timeEntriesApi
      .people()
      .then((res) => {
        setPeople(res.people);
        setCanSeeTeam(res.canSeeTeam);
      })
      .catch(() => setPeople([]));
  }, [loadActive, loadStats]);

  useEffect(() => {
    loadList();
  }, [loadList]);
  useEffect(() => setPage(1), [q, view, jobFilter, person, billable, from, to]);

  useEffect(() => {
    if (!myId) return;
    let cancelled = false;
    setPickersLoading(true);
    Promise.all([loadJobs(), canTrack ? loadMyTasks(myId) : Promise.resolve([] as TaskOption[])])
      .then(([j, t]) => {
        if (cancelled) return;
        setJobs(j);
        setTasks(t);
      })
      .catch((error) => !cancelled && toast({ title: "Jobs could not be loaded", description: errText(error), variant: "destructive" }))
      .finally(() => !cancelled && setPickersLoading(false));
    return () => {
      cancelled = true;
    };
  }, [myId, canTrack, toast]);

  // Tick every second while a timer on screen is running; refresh the totals
  // every minute, and everything when the tab comes back into view.
  const onClock = stats?.team?.onClock || [];
  const ticking = active?.status === "running" || (list?.timeEntries || []).some((e) => e.status === "running") || onClock.some((o) => o.status === "running");
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => loadStats(true), POLL_MS);
    return () => {
      clearInterval(t);
      clearInterval(poll);
    };
  }, [ticking, loadStats]);

  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && refresh(true);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // ---- actions

  const start = async (input: WorkInput) => {
    try {
      const res = await timeEntriesApi.start(input);
      setActive(res.timeEntry);
      syncClock(res.serverTime);
      toast({
        title: "Timer started",
        description: res.stopped
          ? `Stopped “${res.stopped.taskName}” and saved ${fmtMinutes(res.stopped.duration)}. Now on ${res.timeEntry.jobTitle}.`
          : `${res.timeEntry.taskName} · ${res.timeEntry.jobTitle}`
      });
      refresh();
      return true;
    } catch (error) {
      toast({ title: "Timer not started", description: errText(error), variant: "destructive" });
      return false;
    }
  };

  const act = async (e: TimeEntry, kind: "pause" | "resume" | "stop") => {
    try {
      const res = await timeEntriesApi[kind](e._id);
      syncClock(res.serverTime);
      const t = res.timeEntry;
      if (t.staffId === myId) setActive(t.status === "completed" ? null : t);
      if (kind === "stop") {
        toast({ title: "Timer stopped", description: `${fmtMinutes(t.duration)} saved${t.staffId !== myId ? ` for ${t.staffName}` : ""} on ${t.jobTitle}.` });
      } else {
        toast({ title: kind === "pause" ? "Timer paused" : "Timer running again" });
      }
      refresh();
    } catch (error) {
      toast({ title: kind === "stop" ? "Timer not stopped" : kind === "pause" ? "Timer not paused" : "Timer not resumed", description: errText(error), variant: "destructive" });
      refresh();
    }
  };

  const startAgain = (e: TimeEntry) => {
    const input = { jobId: e.jobId, taskId: e.taskId, description: e.description, billable: e.billable };
    if (active) setRestarting(e);
    else start(input);
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await timeEntriesApi.remove(deleting._id);
      toast({ title: deleting.status === "completed" ? "Entry deleted" : "Timer discarded" });
      if (deleting._id === active?._id) setActive(null);
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: errText(error), variant: "destructive" });
      throw error;
    }
  };

  const openAdd = () => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (e: TimeEntry) => {
    setEditing(e);
    setSheetOpen(true);
  };

  // ---- figures

  const mine = (e: TimeEntry) => e.staffId === myId;
  const canChange = (e: TimeEntry) => canTrack && (mine(e) || canSeeTeam);
  const showPerson = canSeeTeam && person === "all";
  const rows = list?.timeEntries || [];
  const totals = list?.totals;
  const total = list?.pagination.total || 0;
  // Server totals were taken when the list loaded; running rows keep growing.
  const liveExtra = rows.filter((e) => e.status === "running").reduce((s, e) => s + minutesOf(e, serverNow) - e.minutesSoFar, 0);
  const liveBillableExtra = rows.filter((e) => e.status === "running" && e.billable).reduce((s, e) => s + minutesOf(e, serverNow) - e.minutesSoFar, 0);

  /** Minutes my running timer has added since the totals were fetched. */
  const myDelta = (since: Date, billableOnly = false) =>
    active?.status === "running" && statsAt && Date.parse(active.startTime) >= since.getTime() && (!billableOnly || active.billable)
      ? Math.max(0, minutesAt(active, serverNow) - minutesAt(active, statsAt))
      : 0;
  const teamDelta = (since: Date) =>
    statsAt ? onClock.filter((o) => o.status === "running" && Date.parse(o.startTime) >= since.getTime()).length * Math.floor(Math.max(0, serverNow - statsAt) / MINUTE) : 0;
  const dayStart = todayRange().from;
  const weekStart = weekRange().from;

  const me = stats?.me;
  const team = stats?.team;
  const myToday = (me?.todayMinutes || 0) + myDelta(dayStart);
  const myWeek = (me?.weekMinutes || 0) + myDelta(weekStart);
  const myBillable = (me?.billableWeekMinutes || 0) + myDelta(weekStart, true);

  const pick = (v: View, b = "all") => {
    setView(v);
    setBillable(b);
  };

  const metrics: Metric[] =
    canSeeTeam && team
      ? [
          { label: "Today", value: fmtMinutes(team.todayMinutes + teamDelta(dayStart)), hint: `You: ${fmtMinutes(myToday)}`, onClick: () => pick("today"), active: view === "today" && billable === "all" },
          { label: "This week", value: fmtMinutes(team.weekMinutes + teamDelta(weekStart)), hint: `You: ${fmtMinutes(myWeek)}`, onClick: () => pick("week"), active: view === "week" && billable === "all" },
          {
            label: "Billable this week",
            value: fmtMinutes(team.billableWeekMinutes),
            hint: team.weekMinutes ? `${pct(team.billableWeekMinutes, team.weekMinutes)}% of the team's week` : "No time this week",
            tone: "success",
            onClick: () => pick("week", "true"),
            active: view === "week" && billable === "true"
          },
          {
            label: "On the clock",
            value: onClock.length,
            hint: onClock.length ? onClock.map((o) => o.staffName.split(" ")[0] + (o.status === "paused" ? " (paused)" : "")).join(", ") : "Nobody right now",
            tone: onClock.length ? "info" : "default",
            onClick: () => pick("open"),
            active: view === "open"
          }
        ]
      : [
          { label: "Today", value: fmtMinutes(myToday), hint: entryNoun(me?.todayEntries || 0), onClick: () => pick("today"), active: view === "today" && billable === "all" },
          { label: "This week", value: fmtMinutes(myWeek), hint: entryNoun(me?.weekEntries || 0), onClick: () => pick("week"), active: view === "week" && billable === "all" },
          {
            label: "Billable this week",
            value: fmtMinutes(myBillable),
            hint: myWeek ? `${pct(myBillable, myWeek)}% of your week` : "No time this week",
            tone: "success",
            onClick: () => pick("week", "true"),
            active: view === "week" && billable === "true"
          },
          {
            label: "Top job this week",
            value: <span className="text-base sm:text-lg">{me?.topJob?.jobTitle || "—"}</span>,
            hint: me?.topJob ? fmtMinutes(me.topJob.minutes) : "No time this week",
            onClick: me?.topJob
              ? () => {
                  pick("week");
                  setJobFilter(me.topJob!.jobId);
                }
              : undefined
          }
        ];

  const jobOptions = useMemo(() => jobs.map((j) => ({ value: j._id, label: customerOf(j) ? `${j.title} · ${customerOf(j)}` : j.title })), [jobs]);
  const personOptions = useMemo(() => people.map((p) => ({ value: p._id, label: p._id === myId ? `${p.fullName} (you)` : p.fullName })), [people, myId]);
  const filtered = !!q || jobFilter !== "all" || person !== "all" || billable !== "all" || (view === "all" && (!!from || !!to));

  const columns: Column<TimeEntry>[] = [
    {
      id: "when",
      header: "When",
      cell: (e) => <Stack top={<span className="whitespace-nowrap">{dayLabel(e.startTime)}</span>} bottom={timeSpan(e)} />,
      sortValue: (e) => e.startTime,
      className: "w-[190px]"
    },
    ...(showPerson
      ? [
          {
            id: "person",
            header: "Person",
            cell: (e: TimeEntry) => <EntityCell avatar={e.staffName} title={e.staffName} />,
            sortValue: (e: TimeEntry) => e.staffName.toLowerCase(),
            hideBelow: "lg" as const,
            className: "w-[200px]"
          }
        ]
      : []),
    {
      id: "work",
      header: "Work",
      cell: (e) => <Stack top={<span className="font-medium">{e.taskName}</span>} bottom={<span title={workLine(e)}>{workLine(e)}</span>} />,
      sortValue: (e) => e.jobTitle.toLowerCase(),
      className: "min-w-[240px] max-w-[420px]"
    },
    {
      id: "billable",
      header: "Billable",
      cell: (e) => (e.billable ? <Tag>Billable</Tag> : <span className="text-xs text-muted-foreground">Non-billable</span>),
      sortValue: (e) => (e.billable ? 1 : 0),
      hideBelow: "md",
      className: "w-[120px]"
    },
    {
      id: "status",
      header: "Status",
      cell: (e) =>
        e.status === "completed" ? (
          <span className="text-xs text-muted-foreground">{e.source === "manual" ? "Added by hand" : "Timer"}</span>
        ) : (
          <StatusPill tone={STATUS_META[e.status].tone}>{STATUS_META[e.status].label}</StatusPill>
        ),
      hideBelow: "lg",
      className: "w-[130px]"
    },
    {
      id: "time",
      header: "Time",
      align: "right",
      cell: (e) => <span className={cn("font-semibold", e.status === "running" && "text-success-strong")}>{fmtMinutes(minutesOf(e, serverNow))}</span>,
      sortValue: (e) => minutesOf(e, serverNow),
      className: "w-[100px]"
    }
  ];

  const emptyTitle = view === "today" ? "No time logged today" : view === "week" ? "No time logged this week" : "No time logged yet";

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="Production"
        title="Design time"
        description="Time spent on each job, from the timer or added by hand."
        actions={
          canTrack && (
            <Button onClick={openAdd}>
              <Plus />
              Add time
            </Button>
          )
        }
      />

      <MetricBar loading={!stats} metrics={metrics} />

      {canTrack && (
        <TimerCard
          active={active}
          now={serverNow}
          jobs={jobs}
          tasks={tasks}
          pickersLoading={pickersLoading}
          onStart={start}
          onPause={(e) => act(e, "pause")}
          onResume={(e) => act(e, "resume")}
          onStop={(e) => act(e, "stop")}
          onEdit={openEdit}
        />
      )}

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={(v) => setView(v)}
          tabs={[
            { value: "today", label: "Today" },
            { value: "week", label: "This week" },
            { value: "all", label: "All entries" },
            ...(canSeeTeam ? [{ value: "open" as const, label: "On the clock", count: onClock.length }] : [])
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder={canSeeTeam ? "Search work, job or person" : "Search work or job"} />}>
              {view === "all" && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[9.5rem] text-[13px]" />
                  <span className="text-muted-foreground">–</span>
                  <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 w-[9.5rem] text-[13px]" />
                </div>
              )}
              <FilterSelect label="Job" value={jobFilter} onChange={setJobFilter} options={jobOptions} allLabel="All jobs" className="max-w-[16rem]" />
              {canSeeTeam && <FilterSelect label="Person" value={person} onChange={setPerson} options={personOptions} allLabel="Everyone" />}
              <FilterSelect
                label="Billable"
                value={billable}
                onChange={setBillable}
                options={[
                  { value: "true", label: "Billable" },
                  { value: "false", label: "Non-billable" }
                ]}
              />
            </Toolbar>
          }
          footer={
            !loading &&
            total > 0 &&
            totals && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="num text-foreground">
                  {entryNoun(totals.count)} · <span className="font-semibold">{fmtMinutes(totals.minutes + liveExtra)}</span>
                  <span className="text-muted-foreground"> · {fmtMinutes(totals.billableMinutes + liveBillableExtra)} billable</span>
                </span>
                {total > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="entries" />}
              </div>
            )
          }
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(e) => e._id}
            loading={loading}
            onRowClick={(e) => canChange(e) && openEdit(e)}
            actions={(e) => [
              { label: "Pause", icon: Pause, onClick: () => act(e, "pause"), hidden: !canTrack || !mine(e) || e.status !== "running" },
              { label: "Resume", icon: Play, onClick: () => act(e, "resume"), hidden: !canTrack || !mine(e) || e.status !== "paused" },
              { label: mine(e) ? "Stop" : `Stop ${e.staffName.split(" ")[0]}'s timer`, icon: Square, onClick: () => act(e, "stop"), hidden: !canChange(e) || e.status === "completed" },
              { label: "Start again", icon: RotateCcw, onClick: () => startAgain(e), hidden: !canTrack || !mine(e) || e.status !== "completed" },
              { label: "Edit", icon: Pencil, onClick: () => openEdit(e), hidden: !canChange(e) },
              { label: e.status === "completed" ? "Delete entry" : "Discard timer", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(e), hidden: !canChange(e) }
            ]}
            actionsLabel={(e) => `Actions for ${e.taskName}`}
            mobile={(e) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{e.taskName}</span>
                  <span className={cn("num shrink-0 font-semibold", e.status === "running" && "text-success-strong")}>{fmtMinutes(minutesOf(e, serverNow))}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{workLine(e)}</div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">
                    {fmtDateShort(e.startTime)} · {timeSpan(e)}
                    {showPerson ? ` · ${e.staffName}` : ""}
                  </span>
                  {e.status !== "completed" ? (
                    <StatusPill tone={STATUS_META[e.status].tone}>{STATUS_META[e.status].label}</StatusPill>
                  ) : !e.billable ? (
                    <span className="shrink-0">Non-billable</span>
                  ) : null}
                </div>
              </div>
            )}
            empty={
              filtered ? (
                <EmptyState compact icon={Clock} title="No entries in this view" description="Try another date, job or search." />
              ) : view === "open" ? (
                <EmptyState compact icon={Timer} title="Nobody is on the clock" description="Timers your team starts show here while they run." />
              ) : (
                <EmptyState
                  icon={Clock}
                  title={emptyTitle}
                  description={canTrack ? "Start the timer above, or add time you have already spent." : "Time your team tracks shows here."}
                  action={
                    canTrack && (
                      <Button variant="outline" onClick={openAdd}>
                        <Plus />
                        Add time
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <TimeEntrySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        entry={editing}
        ownerName={editing && !mine(editing) ? editing.staffName : undefined}
        jobs={jobs}
        tasks={tasks}
        pickersLoading={pickersLoading}
        onSaved={(t, added) => {
          toast({ title: added ? "Time added" : "Entry updated", description: added ? `${fmtMinutes(t.duration)} on ${t.jobTitle}` : undefined });
          if (t.staffId === myId && t.status !== "completed") setActive(t);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting?.status === "completed" ? "Delete this time entry?" : "Discard this timer?"}
        description={
          deleting
            ? `${deleting.taskName} · ${deleting.jobTitle}, ${fmtMinutes(minutesOf(deleting, serverNow))}${mine(deleting) ? "" : ` by ${deleting.staffName}`}. This can't be undone.`
            : undefined
        }
        confirmLabel={deleting?.status === "completed" ? "Delete" : "Discard"}
        onConfirm={remove}
      />

      <ConfirmDialog
        open={!!restarting}
        onOpenChange={(o) => !o && setRestarting(null)}
        title="Stop the current timer?"
        description={
          active && restarting
            ? `“${active.taskName}” on ${active.jobTitle} stops and its ${fmtMinutes(minutesOf(active, serverNow))} is saved. Then a new timer starts on “${restarting.taskName}”.`
            : undefined
        }
        confirmLabel="Stop and start"
        cancelLabel="Keep it running"
        destructive={false}
        onConfirm={async () => {
          if (!restarting) return;
          const ok = await start({ jobId: restarting.jobId, taskId: restarting.taskId, description: restarting.description, billable: restarting.billable });
          if (!ok) throw new Error("not started");
          setRestarting(null);
        }}
      />
    </PageShell>
  );
}
