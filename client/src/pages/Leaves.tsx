import { useCallback, useEffect, useMemo, useState } from "react";
import { differenceInCalendarDays, endOfDay, endOfMonth, format, isWithinInterval, startOfDay, startOfMonth } from "date-fns";
import { Ban, Check, CalendarOff, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { EditorSheet } from "@/components/users/EditorSheet";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, fmtDateShort, plural } from "@/lib/format";

type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
type LeaveType = "casual" | "sick" | "earned" | "unpaid" | "maternity" | "other";

interface Leave {
  _id: string;
  employeeId?: { _id: string; name: string; employeeCode?: string; designation?: string; department?: string } | null;
  leaveType: LeaveType;
  fromDate: string;
  toDate: string;
  days: number;
  reason?: string;
  status: LeaveStatus;
  approvedByName?: string;
  approvedAt?: string;
  rejectionReason?: string;
  createdAt: string;
}

interface Employee {
  _id: string;
  name: string;
  employeeCode?: string;
}

const TYPE_LABEL: Record<LeaveType, string> = { casual: "Casual", sick: "Sick", earned: "Earned", unpaid: "Unpaid", maternity: "Maternity", other: "Other" };
const STATUS: Record<LeaveStatus, { label: string; tone: PillTone }> = {
  pending: { label: "Waiting", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" }
};
type View = LeaveStatus | "all";

const EMPTY_FORM = { employeeId: "", leaveType: "casual" as LeaveType, fromDate: "", toDate: "", reason: "" };

const range = (l: Leave) => (l.fromDate.slice(0, 10) === l.toDate.slice(0, 10) ? fmtDate(l.fromDate) : `${fmtDateShort(l.fromDate)} – ${fmtDate(l.toDate)}`);
const isOutToday = (l: Leave) => l.status === "approved" && isWithinInterval(new Date(), { start: startOfDay(new Date(l.fromDate)), end: endOfDay(new Date(l.toDate)) });

/** "Starts in 3 days", "Back on 16 Oct", "Ended 2 days ago" for the date column. */
function when(l: Leave) {
  const start = differenceInCalendarDays(new Date(l.fromDate), new Date());
  const end = differenceInCalendarDays(new Date(l.toDate), new Date());
  if (start > 1) return `Starts in ${start} days`;
  if (start === 1) return "Starts tomorrow";
  if (end >= 0) return start === 0 ? "Starts today" : "On leave now";
  return end === -1 ? "Ended yesterday" : `Ended ${-end} days ago`;
}

export default function Leaves() {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("Human Resources: Create & Edit");
  const canDecide = hasPermission("Human Resources: Manage Leaves");
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("all");
  const [type, setType] = useState("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [rejecting, setRejecting] = useState<Leave | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deleting, setDeleting] = useState<Leave | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await apiClient.getLeaves()) as { leaves?: Leave[] };
      setLeaves(res?.leaves || []);
    } catch (error) {
      toast({ title: "Leave requests could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    apiClient
      .getEmployees({ status: "active" })
      .then((res) => setEmployees((res as { employees?: Employee[] })?.employees || []))
      .catch(() => setEmployees([]));
  }, [load]);

  const setStatus = async (l: Leave, status: LeaveStatus, rejectionReason?: string) => {
    try {
      await apiClient.updateLeaveStatus(l._id, status, rejectionReason);
      toast({ title: `${l.employeeId?.name || "Leave"}: ${STATUS[status].label.toLowerCase()}` });
      load();
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.employeeId || !form.fromDate || !form.toDate) {
      toast({ title: "Choose the employee and the dates", variant: "destructive" });
      return;
    }
    if (form.toDate < form.fromDate) {
      toast({ title: "The last day is before the first day", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiClient.createLeave(form);
      toast({ title: "Leave request added", description: "It's waiting for approval." });
      setOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (error) {
      toast({ title: "Not added", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteLeave(deleting._id);
      toast({ title: "Leave request deleted" });
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const count = (s: LeaveStatus) => leaves.filter((l) => l.status === s).length;
  const pending = leaves.filter((l) => l.status === "pending");
  const outToday = leaves.filter(isOutToday);
  const monthStart = startOfMonth(new Date());
  const monthEnd = endOfMonth(new Date());
  const approvedThisMonth = leaves.filter((l) => l.status === "approved" && new Date(l.fromDate) <= monthEnd && new Date(l.toDate) >= monthStart);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leaves.filter(
      (l) =>
        (view === "all" || l.status === view) &&
        (type === "all" || l.leaveType === type) &&
        (!q || [l.employeeId?.name, l.employeeId?.employeeCode, l.reason].some((f) => (f || "").toLowerCase().includes(q)))
    );
  }, [leaves, view, type, search]);

  const formDays = form.fromDate && form.toDate && form.toDate >= form.fromDate ? differenceInCalendarDays(new Date(form.toDate), new Date(form.fromDate)) + 1 : 0;

  const columns: Column<Leave>[] = [
    {
      id: "employee",
      header: "Employee",
      cell: (l) => <EntityCell avatar={l.employeeId?.name || "?"} title={l.employeeId?.name || "Removed employee"} subtitle={[l.employeeId?.employeeCode, l.employeeId?.designation].filter(Boolean).join(" · ")} />,
      sortValue: (l) => (l.employeeId?.name || "").toLowerCase(),
      className: "min-w-[220px]"
    },
    { id: "type", header: "Type", cell: (l) => <Tag>{TYPE_LABEL[l.leaveType] || l.leaveType}</Tag>, sortValue: (l) => l.leaveType, hideBelow: "md" },
    {
      id: "dates",
      header: "Dates",
      cell: (l) => <Stack top={<span className="whitespace-nowrap">{range(l)}</span>} bottom={l.status === "approved" || l.status === "pending" ? when(l) : undefined} />,
      sortValue: (l) => l.fromDate
    },
    { id: "days", header: "Days", align: "right", cell: (l) => <span className="font-medium">{l.days}</span>, sortValue: (l) => l.days, className: "w-[70px]" },
    {
      id: "reason",
      header: "Reason",
      cell: (l) => <span className="block max-w-[240px] truncate text-muted-foreground" title={l.reason}>{l.reason || "—"}</span>,
      hideBelow: "xl"
    },
    {
      id: "status",
      header: "Status",
      cell: (l) =>
        l.status === "pending" && canDecide ? (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-success/40 px-2 text-success-strong hover:bg-success-soft hover:text-success-strong"
              onClick={(e) => {
                e.stopPropagation();
                setStatus(l, "approved").catch(() => undefined);
              }}
            >
              <Check />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-destructive-strong hover:bg-destructive-soft hover:text-destructive-strong"
              onClick={(e) => {
                e.stopPropagation();
                setRejectReason("");
                setRejecting(l);
              }}
            >
              <X />
              Reject
            </Button>
          </div>
        ) : (
          <Stack
            top={<StatusPill tone={STATUS[l.status].tone}>{STATUS[l.status].label}</StatusPill>}
            bottom={l.status === "rejected" && l.rejectionReason ? <span title={l.rejectionReason}>{l.rejectionReason}</span> : l.approvedByName ? `by ${l.approvedByName}` : undefined}
          />
        ),
      sortValue: (l) => l.status,
      className: "w-[190px]"
    }
  ];

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="People"
        title="Leave requests"
        description="Time off asked for by your team, waiting for a decision or already approved."
        actions={
          canEdit && (
            <Button onClick={() => setOpen(true)}>
              <Plus />
              New request
            </Button>
          )
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          {
            label: "To approve",
            value: pending.length,
            hint: pending.length ? `${plural(pending.reduce((s, l) => s + l.days, 0), "day")} asked for` : "All caught up",
            tone: pending.length ? "warning" : "default",
            onClick: () => setView(view === "pending" ? "all" : "pending"),
            active: view === "pending"
          },
          {
            label: "Out today",
            value: outToday.length,
            hint: outToday.length ? outToday.map((l) => l.employeeId?.name?.split(" ")[0]).filter(Boolean).join(", ") : "Everyone's in",
            tone: outToday.length ? "info" : "default"
          },
          { label: `Approved in ${format(new Date(), "MMM")}`, value: plural(approvedThisMonth.reduce((s, l) => s + l.days, 0), "day"), hint: plural(approvedThisMonth.length, "request") },
          { label: "Rejected", value: count("rejected"), hint: "All time", onClick: () => setView(view === "rejected" ? "all" : "rejected"), active: view === "rejected" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All", count: leaves.length },
            { value: "pending", label: "Waiting", count: count("pending"), tone: "warning" },
            { value: "approved", label: "Approved", count: count("approved") },
            { value: "rejected", label: "Rejected", count: count("rejected") },
            { value: "cancelled", label: "Cancelled", count: count("cancelled") }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search employee or reason" />}>
              <FilterSelect label="Type" value={type} onChange={setType} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
            </Toolbar>
          }
          footer={!loading && rows.length > 0 && <span>{plural(rows.length, "request")} · {plural(rows.reduce((s, l) => s + l.days, 0), "day")}</span>}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(l) => l._id}
            loading={loading}
            defaultSort={{ id: "dates", dir: "desc" }}
            actions={(l) => [
              { label: "Approve", icon: Check, onClick: () => setStatus(l, "approved").catch(() => undefined), hidden: !canDecide || l.status === "approved" },
              {
                label: "Reject",
                icon: X,
                onClick: () => {
                  setRejectReason("");
                  setRejecting(l);
                },
                hidden: !canDecide || l.status === "rejected" || l.status === "cancelled"
              },
              { label: "Cancel leave", icon: Ban, onClick: () => setStatus(l, "cancelled").catch(() => undefined), hidden: !canDecide || l.status !== "approved" },
              { label: "Move back to waiting", icon: RotateCcw, onClick: () => setStatus(l, "pending").catch(() => undefined), hidden: !canDecide || l.status === "pending" },
              { label: "Delete request", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(l), hidden: !canEdit }
            ]}
            actionsLabel={(l) => `Actions for ${l.employeeId?.name || "leave request"}`}
            mobile={(l) => (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{l.employeeId?.name || "Removed employee"}</span>
                  <StatusPill tone={STATUS[l.status].tone}>{STATUS[l.status].label}</StatusPill>
                </div>
                <div className="text-xs text-muted-foreground">
                  {TYPE_LABEL[l.leaveType]} · {range(l)} · {plural(l.days, "day")}
                </div>
                {l.reason && <div className="truncate text-xs text-muted-foreground">{l.reason}</div>}
              </div>
            )}
            empty={
              search || view !== "all" || type !== "all" ? (
                <EmptyState compact icon={CalendarOff} title="No requests in this view" description="Try another status, type or search." />
              ) : (
                <EmptyState
                  icon={CalendarOff}
                  title="No leave requests yet"
                  description="Add a request when someone asks for time off. Approved days show on Attendance and Payroll."
                  action={
                    canEdit && (
                      <Button onClick={() => setOpen(true)}>
                        <Plus />
                        New request
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <EditorSheet
        open={open}
        onOpenChange={setOpen}
        title="New leave request"
        description="It's added as waiting. Approve it here once it's agreed."
        onSubmit={submit}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Adding…" : "Add request"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="leave-employee">Employee</Label>
            <Select value={form.employeeId} onValueChange={(v) => setForm({ ...form, employeeId: v })}>
              <SelectTrigger id="leave-employee">
                <SelectValue placeholder={employees.length ? "Choose an employee" : "No active employees"} />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e._id} value={e._id}>
                    {e.name}
                    {e.employeeCode ? ` · ${e.employeeCode}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="leave-type">Type of leave</Label>
            <Select value={form.leaveType} onValueChange={(v) => setForm({ ...form, leaveType: v as LeaveType })}>
              <SelectTrigger id="leave-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TYPE_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="leave-from">First day</Label>
              <Input id="leave-from" type="date" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value, toDate: form.toDate || e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-to">Last day</Label>
              <Input id="leave-to" type="date" min={form.fromDate || undefined} value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
            </div>
          </div>
          {formDays > 0 && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              <span className="font-semibold">{plural(formDays, "day")}</span>
              <span className="text-muted-foreground"> including both dates</span>
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea id="leave-reason" rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Optional" />
          </div>
        </div>
      </EditorSheet>

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this request?</DialogTitle>
            <DialogDescription>
              {rejecting ? `${rejecting.employeeId?.name || "Employee"} · ${TYPE_LABEL[rejecting.leaveType]} · ${range(rejecting)} (${plural(rejecting.days, "day")})` : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea id="reject-reason" rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Optional — shown next to the request" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Keep waiting
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!rejecting) return;
                setStatus(rejecting, "rejected", rejectReason.trim())
                  .then(() => setRejecting(null))
                  .catch(() => undefined);
              }}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this leave request?"
        description={deleting ? `${deleting.employeeId?.name || "Employee"} · ${range(deleting)}. This can't be undone.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
