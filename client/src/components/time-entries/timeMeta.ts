import { addDays, format, startOfDay, startOfWeek } from "date-fns";
import type { PillTone } from "@/components/data";
import type { TimeEntry, TimeEntryStatus } from "@/lib/api/timeEntries";

export const MINUTE = 60000;
export const OPEN_TASK = ["pending", "in_progress", "on_hold"];
export const FINISHED_JOB = ["completed", "delivered", "cancelled"];

export const STATUS_META: Record<TimeEntryStatus, { label: string; tone: PillTone }> = {
  running: { label: "Running", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  completed: { label: "Stopped", tone: "neutral" }
};

/** "45m", "1h 05m", "12h" — minutes as hours and minutes. */
export function fmtMinutes(min: number) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${String(r).padStart(2, "0")}m` : `${h}h`;
}

/** "1:05:09" for the running clock. */
export function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** "2:05 pm". */
export const fmtTime = (d: string | number | Date) => format(new Date(d), "h:mm a").toLowerCase();

/**
 * Milliseconds worked by `at` (or the entry's end), less the pauses — the same
 * rule the server uses, so the live clock matches what is saved on stop.
 */
export function workedMs(e: Pick<TimeEntry, "startTime" | "endTime" | "breaks">, at: number) {
  const start = Date.parse(e.startTime);
  const end = e.endTime ? Date.parse(e.endTime) : at;
  if (!(end > start)) return 0;
  const paused = (e.breaks || []).reduce((sum, b) => {
    const from = Math.max(start, Date.parse(b.startTime));
    const to = Math.min(end, b.endTime ? Date.parse(b.endTime) : end);
    return sum + Math.max(0, to - from);
  }, 0);
  return Math.max(0, end - start - paused);
}

/** Minutes of an entry: saved for stopped ones, live for timers. */
export const minutesOf = (e: TimeEntry, at: number) => (e.status === "completed" ? e.duration : Math.round(workedMs(e, at) / MINUTE));

/** Minutes the entry spent paused (within its span). */
export function pausedMinutes(e: TimeEntry, at: number) {
  const start = Date.parse(e.startTime);
  const end = e.endTime ? Date.parse(e.endTime) : at;
  if (!(end > start)) return 0;
  return Math.round((end - start - workedMs(e, at)) / MINUTE);
}

/** "2:05 pm – 3:10 pm", "Since 2:05 pm", or "Duration only" for the time column. */
export function timeSpan(e: TimeEntry) {
  if (e.status !== "completed") return `Since ${fmtTime(e.startTime)}`;
  if (!e.endTime) return "Duration only";
  const sameDay = startOfDay(new Date(e.startTime)).getTime() === startOfDay(new Date(e.endTime)).getTime();
  return `${fmtTime(e.startTime)} – ${fmtTime(e.endTime)}${sameDay ? "" : " (next day)"}`;
}

/** What the entry is for, on one line: "Job · what was done". */
export function workLine(e: TimeEntry) {
  const extra = e.description && e.description !== e.taskName ? e.description : "";
  return [e.jobTitle, extra].filter(Boolean).join(" · ");
}

export const todayRange = (now = new Date()) => {
  const from = startOfDay(now);
  return { from, to: addDays(from, 1) };
};

/** Monday to Sunday. */
export const weekRange = (now = new Date()) => {
  const from = startOfWeek(now, { weekStartsOn: 1 });
  return { from, to: addDays(from, 7) };
};

/** "2026-10-13" and "14:05" for date and time inputs, in local time. */
export const dateInput = (d: Date) => format(d, "yyyy-MM-dd");
export const timeInput = (d: Date) => format(d, "HH:mm");

/** A local date ("2026-10-13") and time ("14:05") as a Date. */
export function combine(date: string, time: string) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = (time || "00:00").split(":").map(Number);
  return new Date(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0, 0);
}
