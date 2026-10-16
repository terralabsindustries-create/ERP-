import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, addMonths, endOfDay, format, isSameDay, isSameMonth, isToday, startOfDay, startOfMonth, subMonths } from "date-fns";
import { CalendarCheck, CalendarDays, CheckCircle, ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, MetricBar } from "@/components/data";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import { AgendaList } from "@/components/calendar/AgendaList";
import { CreateEventDialog } from "@/components/calendar/CreateEventDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { KIND_META, byTime, eventItem, monthWindow, onDay, taskItem, type CalItem, type RawEvent, type RawTask } from "@/lib/calendarItems";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

type Show = "all" | "tasks" | "events";
type Panel = "day" | "upcoming" | "overdue";

interface Shift {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  shiftType?: string;
}

const taskList = (r: unknown) => ((Array.isArray(r) ? r : (r as { data?: RawTask[] })?.data) || []) as RawTask[];
const eventList = (r: unknown) => ((r as { events?: RawEvent[] })?.events || []) as RawEvent[];
const toItems = (tasks: RawTask[], events: RawEvent[]) => [...tasks.map(taskItem).filter((x): x is CalItem => !!x), ...events.map(eventItem)];

export default function CalendarPage() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Calendar: Create & Edit");
  const canDelete = hasPermission("Calendar: Delete");

  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState(() => new Date());
  const [items, setItems] = useState<CalItem[]>([]);
  const [upcoming, setUpcoming] = useState<CalItem[]>([]);
  const [overdue, setOverdue] = useState<CalItem[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusLoaded, setFocusLoaded] = useState(false);
  const [show, setShow] = useState<Show>("all");
  const [panel, setPanel] = useState<Panel>("day");
  const [editor, setEditor] = useState<{ open: boolean; event: RawEvent | null }>({ open: false, event: null });
  const [deleting, setDeleting] = useState<CalItem | null>(null);

  // Everything due or happening in the weeks the grid shows.
  const loadMonth = useCallback(async () => {
    setLoading(true);
    const { start, end } = monthWindow(month);
    const [t, e] = await Promise.allSettled([
      apiClient.getTasks({ dueFrom: start.toISOString(), dueTo: end.toISOString(), limit: 200, sortBy: "dueDate", sortOrder: "asc" }),
      apiClient.getEvents({ startDate: start.toISOString(), endDate: end.toISOString(), limit: 100 })
    ]);
    if (t.status === "rejected" && e.status === "rejected") toast({ title: "The calendar could not be loaded", variant: "destructive" });
    setItems(toItems(t.status === "fulfilled" ? taskList(t.value) : [], e.status === "fulfilled" ? eventList(e.value) : []));
    setLoading(false);
  }, [month, toast]);

  // The next seven days and anything overdue, whichever month is showing.
  const loadFocus = useCallback(async () => {
    const from = startOfDay(new Date());
    const to = endOfDay(addDays(from, 6));
    const [t, e, o] = await Promise.allSettled([
      apiClient.getTasks({ dueFrom: from.toISOString(), dueTo: to.toISOString(), limit: 200, sortBy: "dueDate", sortOrder: "asc" }),
      apiClient.getEvents({ startDate: from.toISOString(), endDate: to.toISOString(), limit: 100 }),
      apiClient.getTasks({ overdue: "true", limit: 200, sortBy: "dueDate", sortOrder: "asc" })
    ]);
    setUpcoming(toItems(t.status === "fulfilled" ? taskList(t.value) : [], e.status === "fulfilled" ? eventList(e.value) : []).filter((i) => !i.done));
    setOverdue(o.status === "fulfilled" ? toItems(taskList(o.value), []) : []);
    setFocusLoaded(true);
  }, []);

  useEffect(() => {
    loadMonth();
  }, [loadMonth]);
  useEffect(() => {
    loadFocus();
  }, [loadFocus]);
  useEffect(() => {
    if (!user?.id) return;
    apiClient
      .getStaffSchedule(user.id)
      .then((r) => setShifts(((Array.isArray(r) ? r : (r as { data?: Shift[] })?.data) || []) as Shift[]))
      .catch(() => setShifts([]));
  }, [user?.id]);

  const refresh = () => {
    loadMonth();
    loadFocus();
  };

  const markDone = async (i: CalItem) => {
    try {
      if (i.source === "task") await apiClient.updateTaskStatus(i.id, "completed");
      else await apiClient.updateEventStatus(i.id, "completed");
      toast({ title: i.source === "task" ? "Task done" : "Marked done", description: i.title });
      refresh();
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteEvent(deleting.id);
      toast({ title: "Event deleted", description: deleting.title });
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const select = (d: Date) => {
    setSelected(d);
    setPanel("day");
    if (!isSameMonth(d, month)) setMonth(startOfMonth(d));
  };
  const goToday = () => select(new Date());

  const shown = useMemo(() => items.filter((i) => show === "all" || (show === "tasks" ? i.source === "task" : i.source === "event")), [items, show]);
  const dayItems = shown.filter((i) => onDay(i, selected)).sort(byTime);
  const todayItems = upcoming.filter((i) => onDay(i, new Date()));
  const monthItems = items.filter((i) => isSameMonth(i.start, month));
  const shift = shifts.find((s) => s.dayOfWeek?.toLowerCase() === format(selected, "EEEE").toLowerCase());

  const listProps = {
    canEdit,
    canDelete,
    onDone: markDone,
    onEdit: (i: CalItem) => setEditor({ open: true, event: i.event || null }),
    onDelete: setDeleting
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Overview"
        title="Calendar & reminders"
        description="Task due dates, reminders, meetings and deliveries in one place."
        actions={
          canEdit && (
            <Button onClick={() => setEditor({ open: true, event: null })}>
              <Plus />
              New event
            </Button>
          )
        }
      />

      <MetricBar
        loading={!focusLoaded}
        metrics={[
          {
            label: "Today",
            value: todayItems.length,
            hint: todayItems.length ? `${plural(todayItems.filter((i) => i.source === "task").length, "task")} · ${plural(todayItems.filter((i) => i.source === "event").length, "event")}` : "Nothing due today",
            onClick: goToday,
            active: panel === "day" && isToday(selected)
          },
          {
            label: "Overdue tasks",
            value: overdue.length,
            hint: overdue.length ? "Past their due day" : "Nothing late",
            tone: overdue.length ? "danger" : "default",
            onClick: () => setPanel("overdue"),
            active: panel === "overdue"
          },
          { label: "Next 7 days", value: upcoming.length, hint: "Open tasks and events", tone: upcoming.length ? "info" : "default", onClick: () => setPanel("upcoming"), active: panel === "upcoming" },
          { label: format(month, "MMMM"), value: monthItems.length, hint: `${monthItems.filter((i) => i.done).length} done` }
        ]}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_330px]">
        <DataCard
          toolbar={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="min-w-[9.5rem] text-base font-semibold tracking-tight">{format(month, "MMMM yyyy")}</h2>
                <div className="flex items-center rounded-md border">
                  <Button variant="ghost" size="icon-sm" onClick={() => setMonth((m) => subMonths(m, 1))} aria-label="Previous month">
                    <ChevronLeft />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month">
                    <ChevronRight />
                  </Button>
                </div>
                <Button variant="outline" size="sm" onClick={goToday} disabled={isSameMonth(month, new Date()) && isToday(selected)}>
                  Today
                </Button>
              </div>
              <div className="inline-flex rounded-md border bg-muted/40 p-0.5" role="group" aria-label="Show">
                {(
                  [
                    ["all", "Everything"],
                    ["tasks", "Tasks"],
                    ["events", "Events"]
                  ] as [Show, string][]
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={show === v}
                    onClick={() => setShow(v)}
                    className={cn("h-7 rounded px-3 text-xs font-medium transition-colors", show === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          }
          footer={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {(Object.keys(KIND_META) as (keyof typeof KIND_META)[]).map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <span className={cn("h-2 w-2 rounded-full", KIND_META[k].dot)} aria-hidden />
                  {KIND_META[k].label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden />
                Overdue
              </span>
            </div>
          }
        >
          <MonthGrid month={month} items={shown} selected={selected} onSelect={select} loading={loading} />
        </DataCard>

        <aside className="overflow-hidden rounded-xl border bg-card shadow-card lg:sticky lg:top-4">
          <div className="border-b px-4 py-3">
            <div className="grid grid-cols-3 rounded-md border bg-muted/40 p-0.5 text-xs font-medium" role="tablist" aria-label="Agenda">
              {(
                [
                  ["day", isToday(selected) ? "Today" : format(selected, "d MMM")],
                  ["upcoming", "Next 7 days"],
                  ["overdue", `Overdue${overdue.length ? ` · ${overdue.length}` : ""}`]
                ] as [Panel, string][]
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={panel === v}
                  onClick={() => setPanel(v)}
                  className={cn(
                    "h-7 truncate rounded px-2 transition-colors",
                    panel === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    v === "overdue" && overdue.length && panel !== v && "text-destructive-strong"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-4">
            {panel === "day" && (
              <div className="space-y-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{format(selected, "EEEE")}</div>
                    <div className="text-xs text-muted-foreground">{format(selected, "d MMMM yyyy")}</div>
                  </div>
                  {canEdit && (
                    <Button variant="ghost" size="sm" onClick={() => setEditor({ open: true, event: null })}>
                      <Plus />
                      Add
                    </Button>
                  )}
                </div>
                {shift && (
                  <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>
                      Your shift · <span className="font-medium">{shift.startTime}–{shift.endTime}</span>
                      {shift.shiftType ? <span className="text-muted-foreground"> ({shift.shiftType})</span> : null}
                    </span>
                  </div>
                )}
                <AgendaList
                  {...listProps}
                  items={dayItems}
                  empty={<EmptyState compact icon={CalendarDays} title={isToday(selected) ? "Nothing on today" : "Nothing on this day"} description={canEdit ? "Add a reminder or meeting for this day." : undefined} />}
                />
              </div>
            )}
            {panel === "upcoming" && (
              <AgendaList
                {...listProps}
                showDate
                items={[...upcoming].sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay))}
                empty={<EmptyState compact icon={CalendarCheck} title="A clear week" description="No open tasks or events in the next 7 days." />}
              />
            )}
            {panel === "overdue" && (
              <AgendaList
                {...listProps}
                showDate
                items={overdue}
                empty={<EmptyState compact icon={CheckCircle} title="Nothing overdue" description="Every open task is on time." />}
              />
            )}
          </div>
          {panel === "day" && !isSameDay(selected, new Date()) && (
            <div className="border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
              <button type="button" className="font-medium text-primary hover:underline" onClick={goToday}>
                Back to today
              </button>
            </div>
          )}
        </aside>
      </div>

      <CreateEventDialog open={editor.open} onOpenChange={(o) => setEditor((s) => ({ ...s, open: o }))} defaultDate={selected} event={editor.event} onEventCreated={refresh} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this event?"
        description={deleting ? `${deleting.title} · ${format(deleting.start, "d MMM yyyy")}` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
