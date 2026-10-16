/**
 * Tasks (by due date) and calendar events, brought into one shape so the
 * month grid and the agenda can show them side by side.
 */
import { differenceInCalendarDays, endOfDay, endOfMonth, endOfWeek, startOfDay, startOfMonth, startOfWeek } from "date-fns";

export type CalKind = "task" | "meeting" | "deadline" | "delivery" | "reminder" | "other";

export interface RawTask {
  _id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  dueDate?: string;
  assignedTo?: { _id: string; fullName: string } | string | null;
}

export interface RawEvent {
  _id: string;
  title: string;
  description?: string;
  startDate: string;
  endDate?: string;
  allDay?: boolean;
  eventType?: string;
  priority?: string;
  status?: string;
  location?: string;
}

export interface CalItem {
  id: string;
  source: "task" | "event";
  kind: CalKind;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  /** Tasks only have a due day; events may have a time. */
  allDay: boolean;
  priority?: string;
  status?: string;
  done: boolean;
  overdue: boolean;
  assignee?: string;
  location?: string;
  event?: RawEvent;
}

export const KIND_META: Record<CalKind, { label: string; chip: string; dot: string }> = {
  task: { label: "Task", chip: "bg-primary-soft text-primary-strong", dot: "bg-primary" },
  meeting: { label: "Meeting", chip: "bg-info-soft text-info-strong", dot: "bg-info" },
  deadline: { label: "Deadline", chip: "bg-destructive-soft text-destructive-strong", dot: "bg-destructive" },
  delivery: { label: "Delivery", chip: "bg-warning-soft text-warning-strong", dot: "bg-warning" },
  reminder: { label: "Reminder", chip: "bg-success-soft text-success-strong", dot: "bg-success" },
  other: { label: "Other", chip: "bg-muted text-foreground", dot: "bg-muted-foreground/60" }
};

const CLOSED = ["completed", "cancelled"];

export function taskItem(t: RawTask): CalItem | null {
  if (!t.dueDate) return null;
  const due = new Date(t.dueDate);
  const done = CLOSED.includes(t.status);
  return {
    id: t._id,
    source: "task",
    kind: "task",
    title: t.title,
    description: t.description,
    start: startOfDay(due),
    end: endOfDay(due),
    allDay: true,
    priority: t.priority,
    status: t.status,
    done,
    // Overdue once the due day has ended.
    overdue: !done && differenceInCalendarDays(due, new Date()) < 0,
    assignee: t.assignedTo && typeof t.assignedTo === "object" ? t.assignedTo.fullName : undefined
  };
}

export function eventItem(e: RawEvent): CalItem {
  const start = new Date(e.startDate);
  const end = e.endDate ? new Date(e.endDate) : start;
  const kind = (e.eventType && e.eventType in KIND_META ? e.eventType : "other") as CalKind;
  const done = CLOSED.includes(e.status || "");
  return {
    id: e._id,
    source: "event",
    kind,
    title: e.title,
    description: e.description,
    start,
    end: end < start ? start : end,
    allDay: !!e.allDay,
    priority: e.priority,
    status: e.status,
    done,
    overdue: false,
    location: e.location,
    event: e
  };
}

/** Whether an item falls on (or spans) a day. */
export const onDay = (i: CalItem, day: Date) => i.start <= endOfDay(day) && i.end >= startOfDay(day);

/** All-day items first, then by time; done items last. */
export const byTime = (a: CalItem, b: CalItem) => Number(a.done) - Number(b.done) || Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime();

/** The five or six weeks that show a month, Sunday first. */
export const monthWindow = (month: Date) => ({ start: startOfWeek(startOfMonth(month)), end: endOfWeek(endOfMonth(month)) });
