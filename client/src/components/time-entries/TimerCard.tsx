import { useState } from "react";
import { ArrowLeftRight, Pause, Pencil, Play, Square, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/data";
import { refId, type JobOption, type TaskOption, type TimeEntry, type WorkInput } from "@/lib/api/timeEntries";
import { cn } from "@/lib/utils";
import { JobPicker, TaskSelect } from "./WorkPicker";
import { STATUS_META, fmtClock, fmtMinutes, fmtTime, pausedMinutes, workLine, workedMs } from "./timeMeta";

const EMPTY = { jobId: "", taskId: "", description: "", billable: true };
const LONG_RUN_MS = 10 * 3600e3;

interface TimerCardProps {
  /** The login's own running or paused timer. */
  active: TimeEntry | null;
  /** The current time (corrected to the server's clock), ticking every second. */
  now: number;
  jobs: JobOption[];
  tasks: TaskOption[];
  pickersLoading: boolean;
  onStart: (input: WorkInput) => Promise<boolean>;
  onPause: (e: TimeEntry) => Promise<unknown>;
  onResume: (e: TimeEntry) => Promise<unknown>;
  onStop: (e: TimeEntry) => Promise<unknown>;
  onEdit: (e: TimeEntry) => void;
}

/**
 * The person's timer: what is running and for how long, with pause, resume and
 * stop; or a short form to start one. Starting while a timer runs stops it.
 */
export function TimerCard({ active, now, jobs, tasks, pickersLoading, onStart, onPause, onResume, onStop, onEdit }: TimerCardProps) {
  const [form, setForm] = useState(EMPTY);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "start" | "pause" | "stop">("");

  const run = async (kind: "pause" | "stop", fn: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await fn();
    } catch {
      /* the page reports the error */
    } finally {
      setBusy("");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.jobId) {
      setError("Choose the job you're working on");
      return;
    }
    setError("");
    setBusy("start");
    try {
      const started = await onStart({ jobId: form.jobId, taskId: form.taskId || null, description: form.description.trim(), billable: form.billable });
      if (started) {
        setForm({ ...EMPTY, billable: form.billable });
        setSwitching(false);
      }
    } finally {
      setBusy("");
    }
  };

  const showForm = !active || switching;
  const ms = active ? workedMs(active, now) : 0;
  const paused = active ? pausedMinutes(active, now) : 0;
  const running = active?.status === "running";

  return (
    <section aria-label="Timer" className="overflow-hidden rounded-xl border bg-card shadow-card">
      {active && (
        <div className="flex flex-col gap-4 p-4 sm:p-5 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusPill tone={STATUS_META[active.status].tone}>{STATUS_META[active.status].label}</StatusPill>
              <span className="text-xs text-muted-foreground">
                Started {fmtTime(active.startTime)}
                {paused > 0 && ` · paused ${fmtMinutes(paused)}`}
                {!active.billable && " · Non-billable"}
              </span>
            </div>
            <div className={cn("num text-4xl font-semibold leading-tight tracking-tight", !running && "text-muted-foreground")} role="timer" aria-label={`${fmtMinutes(ms / 60000)} worked`}>
              {fmtClock(ms)}
            </div>
            <div className="truncate font-medium">{active.taskName}</div>
            <div className="truncate text-sm text-muted-foreground">{workLine(active)}</div>
            {running && ms > LONG_RUN_MS && (
              <p className="text-xs text-warning-strong">Running for over 10 hours. Stop it, or edit the start time if it was left on.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center md:justify-end">
            {running ? (
              <Button variant="outline" onClick={() => run("pause", () => onPause(active))} loading={busy === "pause"} disabled={!!busy}>
                <Pause />
                Pause
              </Button>
            ) : (
              <Button variant="outline" onClick={() => run("pause", () => onResume(active))} loading={busy === "pause"} disabled={!!busy}>
                <Play />
                Resume
              </Button>
            )}
            <Button onClick={() => run("stop", () => onStop(active))} loading={busy === "stop"} disabled={!!busy}>
              <Square />
              Stop
            </Button>
            <Button variant="ghost" onClick={() => onEdit(active)} disabled={!!busy}>
              <Pencil />
              Edit
            </Button>
            {!switching && (
              <Button variant="ghost" onClick={() => setSwitching(true)} disabled={!!busy}>
                <ArrowLeftRight />
                Switch work
              </Button>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className={cn("space-y-3 p-4 sm:p-5", active && "border-t bg-muted/20")}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Timer className="h-4 w-4 text-muted-foreground" />
                {active ? "Switch to other work" : "Start a timer"}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {active ? `The current timer stops and its ${fmtMinutes(ms / 60000)} is saved, then a new one starts.` : "Pick the job, then start. The timer keeps running if you close this page."}
              </p>
            </div>
            {active && (
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel switching" onClick={() => setSwitching(false)}>
                <X />
              </Button>
            )}
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] lg:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="timer-job">Job</Label>
              <JobPicker
                id="timer-job"
                jobs={jobs}
                loading={pickersLoading}
                value={form.jobId}
                onChange={(jobId) => {
                  const task = tasks.find((t) => t._id === form.taskId);
                  const keepTask = task && (!refId(task.jobId) || refId(task.jobId) === jobId);
                  setForm({ ...form, jobId, taskId: keepTask ? form.taskId : "" });
                  setError("");
                }}
                className={error ? "border-destructive" : undefined}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timer-task">Task</Label>
              <TaskSelect
                id="timer-task"
                tasks={tasks}
                jobId={form.jobId}
                value={form.taskId}
                onChange={(taskId, task) => {
                  const taskJob = refId(task?.jobId);
                  setForm({ ...form, taskId, jobId: taskJob && jobs.some((j) => j._id === taskJob) ? taskJob : form.jobId });
                  if (taskJob) setError("");
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timer-desc">What are you working on?</Label>
              <Input
                id="timer-desc"
                value={form.description}
                maxLength={500}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="e.g. Cover layout, second proof"
              />
            </div>
            <div className="flex h-9 items-center gap-2">
              <Switch id="timer-billable" checked={form.billable} onCheckedChange={(billable) => setForm({ ...form, billable })} />
              <Label htmlFor="timer-billable" className="cursor-pointer">
                Billable
              </Label>
            </div>
            <Button type="submit" loading={busy === "start"} disabled={!!busy} className="w-full lg:w-auto">
              <Play />
              {active ? "Stop current & start" : "Start timer"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive-strong">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
