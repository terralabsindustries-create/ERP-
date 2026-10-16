import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { Activity, Download, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, type Column, type PillTone } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtRelative, humanize, plural } from "@/lib/format";

interface ActivityEntry {
  _id: string;
  action: string;
  description: string;
  entityType: string;
  entityId?: string;
  entityName?: string;
  performedBy?: { _id: string; fullName?: string; email?: string } | null;
  performedByName: string;
  actionType: string;
  changes?: { before?: unknown; after?: unknown; fields?: string[] };
  severity: "low" | "medium" | "high" | "critical";
  ipAddress?: string;
  tags?: string[];
  createdAt: string;
}

interface ActivityStats {
  totalActivities: number;
  activitiesByType: { _id: string; count: number }[];
  activitiesByUser: { _id: string; userName: string; count: number }[];
  criticalActivities: number;
}

const PAGE_SIZE = 25;
const ENTITY_TYPES = ["customer", "job", "invoice", "payment", "inventory", "vendor", "staff", "task", "delivery", "emergency_order", "walk_in_job", "proof", "time_entry", "event", "hsn_code", "account_transaction", "cost", "user", "access_role", "team", "system"];
const ACTION_TYPES = ["create", "update", "delete", "login", "logout", "export", "import", "approve", "reject", "assign", "complete", "cancel", "start", "pause", "stop", "upload", "download", "send", "receive"];
const SEVERITY: Record<ActivityEntry["severity"], { label: string; tone: PillTone }> = {
  low: { label: "Low", tone: "neutral" },
  medium: { label: "Medium", tone: "info" },
  high: { label: "High", tone: "warning" },
  critical: { label: "Critical", tone: "danger" }
};
const ENTITY_LABEL: Record<string, string> = { emergency_order: "Rush order", walk_in_job: "Counter job", time_entry: "Time entry", hsn_code: "HSN code", account_transaction: "Account entry", access_role: "Role", inventory: "Stock item", vendor: "Supplier", event: "Calendar event" };
const entityLabel = (t: string) => ENTITY_LABEL[t] || humanize(t);

/** Shows a changed value readably: strings as-is, objects as indented JSON. */
const show = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));

export default function ActivityLog() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const canExport = hasPermission("Activity Log: Export");
  const canDelete = user?.role === "admin";

  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [entity, setEntity] = useState("all");
  const [action, setAction] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<ActivityEntry | null>(null);
  const [deleting, setDeleting] = useState<ActivityEntry | null>(null);
  const [exporting, setExporting] = useState(false);

  const filters = useCallback(
    () => ({
      search: q || undefined,
      entityType: entity !== "all" ? entity : undefined,
      actionType: action !== "all" ? action : undefined,
      severity: severity !== "all" ? severity : undefined,
      dateFrom: from || undefined,
      dateTo: to || undefined
    }),
    [q, entity, action, severity, from, to]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await apiClient.get("/activity-log", { ...filters(), page, limit: PAGE_SIZE })) as { activities?: ActivityEntry[]; pagination?: { totalActivities?: number } };
      setRows(res?.activities || []);
      setTotal(res?.pagination?.totalActivities ?? 0);
    } catch (error) {
      toast({ title: "The activity log could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [filters, page, toast]);

  const loadStats = useCallback(async () => {
    try {
      const res = (await apiClient.getActivityStats(30)) as { stats?: ActivityStats };
      setStats(res?.stats || null);
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => setPage(1), [q, entity, action, severity, from, to]);

  const filtered = !!(q || entity !== "all" || action !== "all" || severity !== "all" || from || to);
  const clear = () => {
    setSearch("");
    setEntity("all");
    setAction("all");
    setSeverity("all");
    setFrom("");
    setTo("");
  };

  const exportLog = async () => {
    setExporting(true);
    try {
      await apiClient.downloadActivityLog(filters());
      toast({ title: "Activity log exported" });
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteActivityLogEntry(deleting._id);
      toast({ title: "Entry deleted" });
      setDeleting(null);
      setDetail(null);
      load();
      loadStats();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const who = (a: ActivityEntry) => a.performedBy?.fullName || a.performedByName || "System";
  const topUser = stats?.activitiesByUser?.[0];
  const topAction = stats?.activitiesByType?.[0];

  const columns: Column<ActivityEntry>[] = [
    {
      id: "when",
      header: "When",
      cell: (a) => <Stack top={<span className="whitespace-nowrap">{fmtRelative(a.createdAt)}</span>} bottom={format(new Date(a.createdAt), "d MMM yyyy, h:mm a")} />,
      className: "w-[170px]"
    },
    { id: "who", header: "Who", cell: (a) => <EntityCell avatar={who(a)} title={<span className="font-normal">{who(a)}</span>} />, hideBelow: "md", className: "w-[200px]" },
    {
      id: "what",
      header: "What happened",
      cell: (a) => <Stack top={<span className="font-medium">{a.action}</span>} bottom={a.description} />,
      className: "min-w-[260px]"
    },
    {
      id: "record",
      header: "Record",
      cell: (a) => (
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          <Tag>{entityLabel(a.entityType)}</Tag>
          {a.entityName && <span className="max-w-[200px] truncate text-xs text-muted-foreground">{a.entityName}</span>}
        </div>
      ),
      hideBelow: "lg"
    },
    { id: "severity", header: "Severity", cell: (a) => <StatusPill tone={SEVERITY[a.severity]?.tone}>{SEVERITY[a.severity]?.label || a.severity}</StatusPill>, hideBelow: "xl", className: "w-[110px]" }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Account"
        title="Activity log"
        description="Who did what, and when, across your business."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                load();
                loadStats();
              }}
            >
              <RefreshCw />
              Refresh
            </Button>
            {canExport && (
              <Button variant="outline" onClick={exportLog} disabled={exporting}>
                {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                Export
              </Button>
            )}
          </>
        }
      />

      <MetricBar
        loading={!stats}
        metrics={[
          { label: "Actions in 30 days", value: (stats?.totalActivities ?? 0).toLocaleString("en-IN") },
          {
            label: "Critical",
            value: stats?.criticalActivities ?? 0,
            hint: "In the last 30 days",
            tone: stats?.criticalActivities ? "danger" : "default",
            onClick: () => setSeverity(severity === "critical" ? "all" : "critical"),
            active: severity === "critical"
          },
          { label: "Most active", value: topUser?.userName || "—", hint: topUser ? plural(topUser.count, "action") : undefined },
          { label: "Most common", value: topAction ? humanize(topAction._id) : "—", hint: topAction ? `${topAction.count.toLocaleString("en-IN")} times` : undefined }
        ]}
      />

      <DataCard
        toolbar={
          <div className="space-y-2">
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search action, record or person" />}>
              <FilterSelect label="Record" value={entity} onChange={setEntity} options={ENTITY_TYPES.map((t) => ({ value: t, label: entityLabel(t) }))} />
              <FilterSelect label="Action" value={action} onChange={setAction} options={ACTION_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
              <FilterSelect label="Severity" value={severity} onChange={setSeverity} options={Object.entries(SEVERITY).map(([value, s]) => ({ value, label: s.label }))} />
            </Toolbar>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">From</span>
              <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[150px]" aria-label="From date" />
              <span className="text-muted-foreground">to</span>
              <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 w-[150px]" aria-label="To date" />
              {filtered && (
                <Button variant="ghost" size="sm" onClick={clear}>
                  <X />
                  Clear filters
                </Button>
              )}
            </div>
          </div>
        }
        footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="entries" />}
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(a) => a._id}
          loading={loading}
          onRowClick={(a) => setDetail(a)}
          actions={(a) => [{ label: "Delete entry", icon: Trash2, destructive: true, onClick: () => setDeleting(a), hidden: !canDelete }]}
          actionsLabel={(a) => `Actions for ${a.action}`}
          mobile={(a) => (
            <div className="space-y-1">
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium">{a.action}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtRelative(a.createdAt)}</span>
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">{a.description}</div>
              <div className="text-xs text-muted-foreground">
                {who(a)} · {entityLabel(a.entityType)}
              </div>
            </div>
          )}
          empty={
            <EmptyState
              compact={filtered}
              icon={Activity}
              title={filtered ? "Nothing matches these filters" : "No activity yet"}
              description={filtered ? "Try a wider date range or fewer filters." : "Changes people make — new jobs, invoices, payments, logins — are recorded here."}
            />
          }
        />
      </DataCard>

      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
          {detail && (
            <>
              <SheetHeader className="border-b px-5 py-4">
                <SheetTitle>{detail.action}</SheetTitle>
                <SheetDescription>{format(new Date(detail.createdAt), "EEEE d MMMM yyyy, h:mm:ss a")}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 text-sm">
                <p>{detail.description}</p>
                <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2">
                  <dt className="text-muted-foreground">By</dt>
                  <dd>
                    {who(detail)}
                    {detail.performedBy?.email ? <span className="text-muted-foreground"> · {detail.performedBy.email}</span> : null}
                  </dd>
                  <dt className="text-muted-foreground">Record</dt>
                  <dd>
                    {entityLabel(detail.entityType)}
                    {detail.entityName ? ` · ${detail.entityName}` : ""}
                  </dd>
                  <dt className="text-muted-foreground">Action</dt>
                  <dd>{humanize(detail.actionType)}</dd>
                  <dt className="text-muted-foreground">Severity</dt>
                  <dd>
                    <StatusPill tone={SEVERITY[detail.severity]?.tone}>{SEVERITY[detail.severity]?.label}</StatusPill>
                  </dd>
                  {detail.ipAddress && (
                    <>
                      <dt className="text-muted-foreground">IP address</dt>
                      <dd className="font-mono text-xs">{detail.ipAddress}</dd>
                    </>
                  )}
                  {!!detail.tags?.length && (
                    <>
                      <dt className="text-muted-foreground">Tags</dt>
                      <dd className="flex flex-wrap gap-1">
                        {detail.tags.map((t) => (
                          <Tag key={t}>{t}</Tag>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>
                {detail.changes && (detail.changes.before !== undefined || detail.changes.after !== undefined) && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Changes{detail.changes.fields?.length ? ` · ${detail.changes.fields.join(", ")}` : ""}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-md border bg-muted/30 p-3">
                        <div className="mb-1 text-xs font-medium text-muted-foreground">Before</div>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{show(detail.changes.before)}</pre>
                      </div>
                      <div className="rounded-md border bg-muted/30 p-3">
                        <div className="mb-1 text-xs font-medium text-muted-foreground">After</div>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{show(detail.changes.after)}</pre>
                      </div>
                    </div>
                  </section>
                )}
              </div>
              {canDelete && (
                <div className="flex justify-end border-t px-5 py-3">
                  <Button variant="outline" className="text-destructive-strong" onClick={() => setDeleting(detail)}>
                    <Trash2 />
                    Delete entry
                  </Button>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this log entry?" description="The record of this action is removed for everyone. This can't be undone." onConfirm={remove} />
    </PageShell>
  );
}
