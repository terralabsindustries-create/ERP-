import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, format, isToday } from "date-fns";
import { CalendarCheck, ChevronDown, ChevronLeft, ChevronRight, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, MetricBar, SearchField, Toolbar, type Column } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { cn } from "@/lib/utils";

interface Employee {
  _id: string;
  name: string;
  employeeCode?: string;
  department?: string;
  designation?: string;
}

type Status = "present" | "half-day" | "absent" | "leave" | "holiday" | "week-off";

const STATUSES: { value: Status; short: string; label: string; on: string }[] = [
  { value: "present", short: "P", label: "Present", on: "bg-success text-white border-success" },
  { value: "half-day", short: "½", label: "Half day", on: "bg-info text-white border-info" },
  { value: "absent", short: "A", label: "Absent", on: "bg-destructive text-white border-destructive" },
  { value: "leave", short: "L", label: "On leave", on: "bg-warning text-white border-warning" },
  { value: "holiday", short: "H", label: "Holiday", on: "bg-secondary text-secondary-foreground border-border" },
  { value: "week-off", short: "W", label: "Week off", on: "bg-secondary text-secondary-foreground border-border" }
];

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

/** One row's status as a row of small buttons: P · ½ · A · L · H · W. */
function StatusPicker({ value, onChange, label, readOnly }: { value: Status; onChange: (s: Status) => void; label: string; readOnly?: boolean }) {
  return (
    <div role="radiogroup" aria-label={`Attendance for ${label}`} className="inline-flex overflow-hidden rounded-md border">
      {STATUSES.map((s, i) => {
        const on = value === s.value;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={s.label}
            disabled={readOnly && !on}
            onClick={() => !readOnly && onChange(s.value)}
            className={cn(
              "h-8 min-w-9 px-2 text-xs font-semibold transition-colors disabled:cursor-default disabled:opacity-60 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              i > 0 && "border-l",
              on ? s.on : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {s.short}
            <span className="sr-only"> {s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function Attendance() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("Human Resources: Create & Edit");
  const [date, setDate] = useState(() => ymd(new Date()));
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [saved, setSaved] = useState<Record<string, Status>>({});
  const [marked, setMarked] = useState(false);
  const [statusMap, setStatusMap] = useState<Record<string, Status>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, attRes] = (await Promise.all([apiClient.getEmployees({ status: "active" }), apiClient.getAttendance({ date })])) as [
        { employees?: Employee[] },
        { attendance?: { employeeId: { _id: string } | string; status: Status }[] }
      ];
      const emps = empRes?.employees || [];
      const records = attRes?.attendance || [];
      const map: Record<string, Status> = {};
      emps.forEach((e) => (map[e._id] = "present"));
      records.forEach((a) => {
        const id = typeof a.employeeId === "object" ? a.employeeId?._id : a.employeeId;
        if (id) map[id] = a.status;
      });
      setEmployees(emps);
      setSaved(map);
      setStatusMap(map);
      setMarked(records.length > 0);
    } catch (error) {
      toast({ title: "Attendance could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [date, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const changed = employees.filter((e) => statusMap[e._id] !== saved[e._id]).length;
  const dirty = changed > 0 || (!marked && employees.length > 0);

  const save = async () => {
    setSaving(true);
    try {
      const records = employees.map((e) => ({ employeeId: e._id, status: statusMap[e._id] || "present" }));
      await apiClient.markAttendanceBulk(date, records);
      toast({ title: "Attendance saved", description: `${records.length} people for ${format(new Date(date), "d MMM yyyy")}` });
      setSaved(statusMap);
      setMarked(true);
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const setAll = (s: Status) => setStatusMap(Object.fromEntries(employees.map((e) => [e._id, s])));
  const shift = (days: number) => setDate(ymd(addDays(new Date(date), days)));

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => !q || [e.name, e.employeeCode, e.department, e.designation].some((f) => (f || "").toLowerCase().includes(q)));
  }, [employees, search]);

  const count = (s: Status) => employees.filter((e) => statusMap[e._id] === s).length;
  const pct = (n: number) => (employees.length ? `${Math.round((n / employees.length) * 100)}% of the team` : "—");

  const columns: Column<Employee>[] = [
    {
      id: "name",
      header: "Employee",
      cell: (e) => <EntityCell avatar={e.name} title={e.name} subtitle={[e.employeeCode, e.designation].filter(Boolean).join(" · ")} />,
      sortValue: (e) => e.name.toLowerCase(),
      className: "min-w-[220px]"
    },
    { id: "dept", header: "Department", cell: (e) => e.department || "—", sortValue: (e) => e.department || "", hideBelow: "lg" },
    {
      id: "status",
      header: "Status",
      align: "right",
      cell: (e) => (
        <div className="flex items-center justify-end gap-2">
          {statusMap[e._id] !== saved[e._id] && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Not saved yet" />}
          <StatusPicker value={statusMap[e._id] || "present"} onChange={(s) => setStatusMap((m) => ({ ...m, [e._id]: s }))} label={e.name} readOnly={!canEdit} />
        </div>
      ),
      className: "w-[300px]"
    }
  ];

  const day = new Date(date);

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="People"
        title="Attendance"
        description={canEdit ? "Mark who's in each day. Changes you haven't saved are marked with a dot." : "Who was in each day. You can view attendance but not change it."}
        actions={
          <>
            <div className="flex items-center rounded-md border bg-card">
              <Button variant="ghost" size="icon-sm" onClick={() => shift(-1)} aria-label="Previous day">
                <ChevronLeft />
              </Button>
              <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-8 w-[150px] border-0 px-1 text-center shadow-none focus-visible:ring-0" aria-label="Date" />
              <Button variant="ghost" size="icon-sm" onClick={() => shift(1)} aria-label="Next day">
                <ChevronRight />
              </Button>
            </div>
            {!isToday(day) && (
              <Button variant="outline" onClick={() => setDate(ymd(new Date()))}>
                Today
              </Button>
            )}
            {canEdit && (
              <Button onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                {saving ? "Saving…" : changed ? `Save ${changed} change${changed === 1 ? "" : "s"}` : marked ? "Saved" : "Save day"}
              </Button>
            )}
          </>
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Present", value: count("present"), hint: pct(count("present")), tone: "success" },
          { label: "Half day", value: count("half-day"), hint: pct(count("half-day")), tone: "info" },
          { label: "On leave", value: count("leave"), hint: pct(count("leave")), tone: "warning" },
          { label: "Absent", value: count("absent"), hint: pct(count("absent")), tone: count("absent") ? "danger" : "default" }
        ]}
      />

      <DataCard
        toolbar={
          <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search name, code or department" />}>
            <span className="hidden text-xs text-muted-foreground lg:inline">{format(day, "EEEE, d MMMM yyyy")}</span>
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    Mark everyone
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {STATUSES.map((s) => (
                    <DropdownMenuItem key={s.value} onClick={() => setAll(s.value)}>
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Toolbar>
        }
        footer={
          !loading &&
          employees.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span>{STATUSES.map((s) => `${s.short} ${s.label}`).join(" · ")}</span>
              <span className={cn(dirty && "font-medium text-warning-strong")}>
                {changed ? `${changed} not saved` : marked ? "Saved for this day" : canEdit ? "Not marked yet — everyone starts as present" : "Not marked yet"}
              </span>
            </div>
          )
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(e) => e._id}
          loading={loading}
          minWidth={560}
          defaultSort={{ id: "name", dir: "asc" }}
          mobile={(e) => (
            <div className="space-y-2">
              <EntityCell avatar={e.name} title={e.name} subtitle={e.department} />
              <StatusPicker value={statusMap[e._id] || "present"} onChange={(s) => setStatusMap((m) => ({ ...m, [e._id]: s }))} label={e.name} readOnly={!canEdit} />
            </div>
          )}
          empty={<EmptyState icon={CalendarCheck} title={search ? "No one matches" : "No active employees"} description={search ? undefined : "Add employees on the Employees page to mark their attendance."} />}
        />
      </DataCard>
    </PageShell>
  );
}
