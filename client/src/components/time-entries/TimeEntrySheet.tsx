import { useEffect, useMemo, useState } from "react";
import { addDays } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EditorSection, EditorSheet } from "@/components/users/EditorSheet";
import { useToast } from "@/hooks/use-toast";
import { refId, timeEntriesApi, type EntryUpdate, type JobOption, type TaskOption, type TimeEntry } from "@/lib/api/timeEntries";
import { cn } from "@/lib/utils";
import { JobPicker, TaskSelect } from "./WorkPicker";
import { MINUTE, combine, dateInput, fmtMinutes, fmtTime, timeInput, workedMs } from "./timeMeta";

type Mode = "times" | "duration";

interface Form {
  jobId: string;
  taskId: string;
  description: string;
  billable: boolean;
  date: string;
  mode: Mode;
  start: string;
  end: string;
  hours: string;
  minutes: string;
}

const DAY_MIN = 24 * 60;

function formFor(entry: TimeEntry | null): Form {
  if (!entry) {
    return { jobId: "", taskId: "", description: "", billable: true, date: dateInput(new Date()), mode: "times", start: "", end: "", hours: "", minutes: "" };
  }
  const start = new Date(entry.startTime);
  return {
    jobId: refId(entry.jobId),
    taskId: entry.taskId || "",
    description: entry.description || "",
    billable: entry.billable,
    date: dateInput(start),
    mode: entry.status === "completed" && !entry.endTime ? "duration" : "times",
    start: timeInput(start),
    end: entry.endTime ? timeInput(new Date(entry.endTime)) : "",
    hours: entry.endTime ? "" : String(Math.floor(entry.duration / 60)),
    minutes: entry.endTime ? "" : String(entry.duration % 60)
  };
}

/** Start and end from the form; an end at or before the start means the next day. */
function spanOf(f: Form) {
  if (!f.date || !f.start) return null;
  const start = combine(f.date, f.start);
  if (!f.end) return { start, end: null as Date | null, nextDay: false };
  let end = combine(f.date, f.end);
  const nextDay = end <= start;
  if (nextDay) end = addDays(end, 1);
  return { start, end, nextDay };
}

const durationOf = (f: Form) => (parseInt(f.hours || "0", 10) || 0) * 60 + (parseInt(f.minutes || "0", 10) || 0);

/**
 * Add time already spent (start–end, or a date and a duration), or edit an
 * entry. A running timer can have its work and start time changed; its end is
 * set by stopping it.
 */
export function TimeEntrySheet({
  open,
  onOpenChange,
  entry,
  ownerName,
  jobs,
  tasks,
  pickersLoading,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The entry to edit; null to add time. */
  entry: TimeEntry | null;
  /** Set when editing someone else's entry. */
  ownerName?: string;
  jobs: JobOption[];
  tasks: TaskOption[];
  pickersLoading: boolean;
  onSaved: (entry: TimeEntry, added: boolean) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(() => formFor(entry));
  const [initial, setInitial] = useState<Form>(() => formFor(entry));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const f = formFor(entry);
    setForm(f);
    setInitial(f);
    setError("");
  }, [open, entry]);

  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError("");
  };

  const isTimer = !!entry && entry.status !== "completed";
  const timesChanged = form.date !== initial.date || form.mode !== initial.mode || form.start !== initial.start || form.end !== initial.end || form.hours !== initial.hours || form.minutes !== initial.minutes;

  // What the entry will add up to, for the line under the times.
  const summary = useMemo(() => {
    if (isTimer) return null;
    if (form.mode === "duration") {
      const m = durationOf(form);
      return m > 0 ? { minutes: m, paused: 0, nextDay: false } : null;
    }
    const span = spanOf(form);
    if (!span?.end) return null;
    // A stopped timer's pauses inside the new span still don't count.
    const worked = workedMs({ startTime: span.start.toISOString(), endTime: span.end.toISOString(), breaks: entry?.breaks || [] }, Date.now());
    const total = (span.end.getTime() - span.start.getTime()) / MINUTE;
    return { minutes: Math.round(worked / MINUTE), paused: Math.round(total - worked / MINUTE), nextDay: span.nextDay };
  }, [form, entry, isTimer]);

  /** The message for the first problem, or "". */
  function problem(): string {
    if (!form.jobId) return "Choose the job";
    if (!form.date) return "Choose the date";
    const now = Date.now() + MINUTE;
    if (isTimer) {
      if (!form.start) return "Enter when you started";
      const start = combine(form.date, form.start);
      if (start.getTime() > now) return "The start time is in the future";
      const firstPause = entry?.breaks[0]?.startTime;
      if (firstPause && start.getTime() > Date.parse(firstPause)) return `The start must be before the first pause (${fmtTime(firstPause)})`;
      return "";
    }
    if (form.mode === "duration") {
      const m = durationOf(form);
      if (m < 1) return "Enter how long it took";
      if (m > DAY_MIN) return "One entry can cover at most 24 hours";
      if (combine(form.date, "00:00").getTime() > now) return "The date is in the future";
      return "";
    }
    if (!form.start || !form.end) return "Enter the start and end times";
    const span = spanOf(form);
    if (!span?.end) return "Enter the start and end times";
    if (span.end.getTime() > now) return "The end time hasn't happened yet";
    if (span.end.getTime() - span.start.getTime() > DAY_MIN * MINUTE) return "One entry can cover at most 24 hours";
    return "";
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = problem();
    if (p) {
      setError(p);
      return;
    }
    const work = { jobId: form.jobId, taskId: form.taskId || null, description: form.description.trim(), billable: form.billable };
    const times = (): EntryUpdate => {
      if (isTimer) return { startTime: combine(form.date, form.start).toISOString() };
      if (form.mode === "duration") {
        // Kept on the day, at the time it had (midnight for a new one).
        return { startTime: combine(form.date, initial.mode === "duration" && entry ? initial.start : "00:00").toISOString(), endTime: null, duration: durationOf(form) };
      }
      const span = spanOf(form)!;
      return { startTime: span.start.toISOString(), endTime: span.end!.toISOString() };
    };

    setSaving(true);
    try {
      if (!entry) {
        const t = times();
        const res = await timeEntriesApi.create({ ...work, startTime: t.startTime!, endTime: t.endTime || undefined, duration: t.duration ?? undefined });
        onSaved(res.timeEntry, true);
      } else {
        const patch: EntryUpdate = {};
        if (work.jobId !== initial.jobId) patch.jobId = work.jobId;
        if ((work.taskId || "") !== initial.taskId) patch.taskId = work.taskId;
        if (work.description !== initial.description.trim()) patch.description = work.description;
        if (work.billable !== initial.billable) patch.billable = work.billable;
        if (timesChanged) Object.assign(patch, times());
        if (Object.keys(patch).length === 0) {
          onOpenChange(false);
          return;
        }
        const res = await timeEntriesApi.update(entry._id, patch);
        onSaved(res.timeEntry, false);
      }
      onOpenChange(false);
    } catch (err) {
      toast({ title: entry ? "Not saved" : "Time not added", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const title = !entry ? "Add time" : isTimer ? "Edit running timer" : "Edit time entry";
  const description = !entry
    ? "Time you have already spent, with the start and end, or just how long it took."
    : ownerName
      ? `${ownerName}'s ${isTimer ? "timer" : "entry"}.`
      : isTimer
        ? "Change what the timer is for, or when you started if you forgot to start it."
        : "Correct the job, what was done or the times.";

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={title}
      description={description}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {entry ? "Save changes" : "Add time"}
          </Button>
        </>
      }
    >
      <EditorSection title="Work">
        <div className="space-y-1.5">
          <Label htmlFor="entry-job">Job</Label>
          <JobPicker
            id="entry-job"
            jobs={jobs}
            loading={pickersLoading}
            value={form.jobId}
            fallbackTitle={entry?.jobTitle}
            onChange={(jobId) => {
              const task = tasks.find((t) => t._id === form.taskId);
              const keepTask = !form.taskId || (task && (!refId(task.jobId) || refId(task.jobId) === jobId)) || (!task && jobId === initial.jobId);
              set({ jobId, taskId: keepTask ? form.taskId : "" });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="entry-task">Task</Label>
          <TaskSelect
            id="entry-task"
            tasks={tasks}
            jobId={form.jobId}
            value={form.taskId}
            fallbackTitle={entry?.taskId ? entry.taskName : undefined}
            onChange={(taskId, task) => {
              const taskJob = refId(task?.jobId);
              set({ taskId, jobId: taskJob && jobs.some((j) => j._id === taskJob) ? taskJob : form.jobId });
            }}
          />
          <p className="text-xs text-muted-foreground">Optional. Your open tasks; pick one to log the time against it.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="entry-desc">{isTimer ? "What are you working on?" : "What was done"}</Label>
          <Textarea id="entry-desc" rows={2} maxLength={500} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Business card layout, 3 options" />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <div>
            <Label htmlFor="entry-billable" className="cursor-pointer">
              Billable
            </Label>
            <p className="text-xs text-muted-foreground">Design time the customer pays for.</p>
          </div>
          <Switch id="entry-billable" checked={form.billable} onCheckedChange={(billable) => set({ billable })} />
        </div>
      </EditorSection>

      <EditorSection title="When">
        {!isTimer && (
          <div role="radiogroup" aria-label="How to enter the time" className="inline-flex rounded-lg border bg-muted/40 p-0.5">
            {(
              [
                ["times", "Start and end"],
                ["duration", "Duration only"]
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.mode === value}
                onClick={() => set({ mode: value })}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  form.mode === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className={cn("grid gap-3", isTimer || form.mode === "duration" ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}>
          <div className="col-span-2 space-y-1.5 sm:col-span-1">
            <Label htmlFor="entry-date">Date</Label>
            <Input id="entry-date" type="date" max={dateInput(new Date())} value={form.date} onChange={(e) => set({ date: e.target.value })} />
          </div>
          {isTimer ? (
            <div className="col-span-2 space-y-1.5 sm:col-span-1">
              <Label htmlFor="entry-start">Started at</Label>
              <Input id="entry-start" type="time" value={form.start} onChange={(e) => set({ start: e.target.value })} />
            </div>
          ) : form.mode === "times" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="entry-start">Start</Label>
                <Input id="entry-start" type="time" value={form.start} onChange={(e) => set({ start: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="entry-end">End</Label>
                <Input id="entry-end" type="time" value={form.end} onChange={(e) => set({ end: e.target.value })} />
              </div>
            </>
          ) : (
            <div className="col-span-2 grid grid-cols-2 gap-3 sm:col-span-1">
              <div className="space-y-1.5">
                <Label htmlFor="entry-hours">Hours</Label>
                <Input id="entry-hours" type="number" inputMode="numeric" min={0} max={24} value={form.hours} onChange={(e) => set({ hours: e.target.value })} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="entry-minutes">Minutes</Label>
                <Input id="entry-minutes" type="number" inputMode="numeric" min={0} max={59} value={form.minutes} onChange={(e) => set({ minutes: e.target.value })} placeholder="0" />
              </div>
            </div>
          )}
        </div>
        {summary && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="num font-semibold">{fmtMinutes(summary.minutes)}</span>
            <span className="text-muted-foreground">
              {summary.paused > 0 ? ` worked, not counting ${fmtMinutes(summary.paused)} paused` : " worked"}
              {summary.nextDay ? " · ends the next day" : ""}
            </span>
          </p>
        )}
        {isTimer && <p className="text-xs text-muted-foreground">Stop the timer to set when it ended.</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive-strong">
            {error}
          </p>
        )}
      </EditorSection>
    </EditorSheet>
  );
}
