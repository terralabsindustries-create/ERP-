import { useCallback, useEffect, useState } from "react";
import { startOfWeek } from "date-fns";
import { Link, useNavigate } from "react-router-dom";
import { Ban, CheckCircle2, ExternalLink, Pencil, Play, Plus, Ticket, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type RowAction } from "@/components/data";
import { fmtPhone } from "@/components/delivery/deliveryMeta";
import { ConvertToJobDialog } from "@/components/emergency-orders/ConvertToJobDialog";
import { RushOrderEditor } from "@/components/emergency-orders/RushOrderEditor";
import { PRIORITY_LABEL, STATUS_META, dueNote, isOpen, jobOf, neededBy } from "@/components/emergency-orders/rushMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import { rushOrdersApi, type RushList, type RushOrder, type RushView } from "@/lib/api/rushOrders";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;
const jobLink = (title: string) => `/jobs?q=${encodeURIComponent(title)}`;

function Due({ o }: { o: RushOrder }) {
  const n = dueNote(o);
  if (!n.text) return null;
  return <span className={cn(n.overdue ? "font-medium text-destructive-strong" : n.soon ? "text-warning-strong" : undefined)}>{n.text}</span>;
}

export default function EmergencyOrders() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const canEdit = hasPermission("Emergency Orders: Create & Edit");
  const canConvert = canEdit && hasPermission("Jobs: Create & Edit");
  const [data, setData] = useState<RushList | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<RushView>("open");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [priority, setPriority] = useState("all");
  const [page, setPage] = useState(1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<RushOrder | null>(null);
  const [converting, setConverting] = useState<RushOrder | null>(null);
  const [cancelling, setCancelling] = useState<RushOrder | null>(null);
  const [deleting, setDeleting] = useState<RushOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await rushOrdersApi.list({
          view,
          search: q || undefined,
          priority: priority === "all" ? undefined : priority,
          weekStart: startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString(),
          page,
          limit: PAGE_SIZE
        })
      );
    } catch (error) {
      toast({ title: "Rush orders could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [view, q, priority, page, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [view, q, priority]);

  const openEditor = (o: RushOrder | null) => {
    setEditing(o);
    setEditorOpen(true);
  };

  const setStatus = async (o: RushOrder, status: "in_progress" | "completed" | "cancelled") => {
    try {
      const saved = await rushOrdersApi.setStatus(o._id, status);
      toast({ title: status === "in_progress" ? `${o.orderId} started` : status === "completed" ? `${o.orderId} completed` : `${o.orderId} cancelled` });
      load();
      return saved;
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await rushOrdersApi.remove(deleting._id);
      toast({ title: `${deleting.orderId} deleted`, description: jobOf(deleting) ? "The job it became is kept." : undefined });
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const s = data?.summary;
  const rows = data?.emergencyOrders || [];
  const total = data?.pagination.totalEmergencyOrders || 0;
  const toggle = (v: RushView) => setView(view === v ? "all" : v);

  const actions = (o: RushOrder): RowAction[] => {
    const job = jobOf(o);
    return [
      { label: "Start work", icon: Play, onClick: () => setStatus(o, "in_progress").catch(() => undefined), hidden: !canEdit || o.status !== "pending" },
      { label: "Mark complete", icon: CheckCircle2, onClick: () => setStatus(o, "completed").catch(() => undefined), hidden: !canEdit || !isOpen(o) },
      { label: "Convert to job", icon: Ticket, onClick: () => setConverting(o), hidden: !canConvert || !!job || !(isOpen(o) || o.status === "completed") },
      { label: "Open job", icon: ExternalLink, onClick: () => job && navigate(jobLink(job.title)), hidden: !job },
      { label: "Edit", icon: Pencil, onClick: () => openEditor(o), hidden: !canEdit || o.status === "converted" || o.status === "cancelled", separated: true },
      { label: "Cancel order", icon: Ban, onClick: () => setCancelling(o), hidden: !canEdit || !isOpen(o) },
      { label: "Delete", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(o), hidden: !canEdit }
    ];
  };

  const columns: Column<RushOrder>[] = [
    {
      id: "customer",
      header: "Order",
      cell: (o) => (
        <EntityCell
          className="max-w-[300px]"
          avatar={o.customerName}
          title={o.customerName}
          subtitle={
            <>
              <span className="font-mono">{o.orderId}</span> · {fmtPhone(o.customerPhone)}
            </>
          }
        />
      ),
      sortValue: (o) => o.customerName.toLowerCase(),
      className: "min-w-[230px]"
    },
    {
      id: "details",
      header: "Details",
      cell: (o) => (
        <span className="block max-w-[240px] truncate text-muted-foreground" title={o.orderDetails}>
          {o.orderDetails}
        </span>
      ),
      hideBelow: "md"
    },
    {
      id: "needed",
      header: "Needed by",
      cell: (o) => <Stack top={<span className="whitespace-nowrap">{neededBy(o)}</span>} bottom={<Due o={o} />} />,
      sortValue: (o) => o.expectedCompletion || "",
      className: "w-[160px]"
    },
    {
      id: "amount",
      header: "Estimate",
      align: "right",
      cell: (o) => <Stack top={<span className="font-semibold">{formatINR(o.estimatedAmount)}</span>} bottom={o.advancePaid ? `${formatINR(o.advancePaid)} advance` : undefined} />,
      sortValue: (o) => o.estimatedAmount,
      hideBelow: "sm"
    },
    {
      id: "status",
      header: "Status",
      cell: (o) => {
        const job = jobOf(o);
        return (
          <Stack
            className="max-w-[220px]"
            top={
              <span className="inline-flex items-center gap-1.5">
                <StatusPill tone={STATUS_META[o.status].tone}>{STATUS_META[o.status].label}</StatusPill>
                {o.priority === "urgent" && isOpen(o) && <Tag className="border-destructive/30 text-destructive-strong">Urgent</Tag>}
              </span>
            }
            bottom={
              job ? (
                <Link to={jobLink(job.title)} onClick={(e) => e.stopPropagation()} className="text-primary underline-offset-4 hover:underline">
                  {job.title}
                </Link>
              ) : o.status === "cancelled" && o.cancelReason ? (
                o.cancelReason
              ) : undefined
            }
          />
        );
      },
      sortValue: (o) => o.status,
      className: "w-[220px]"
    }
  ];

  const filtered = !!q || priority !== "all";

  return (
    <PageShell>
      <PageHeader
        eyebrow="Sales & estimating"
        title="Rush orders"
        description="Same-day and urgent work that jumps the queue. Convert one to a job when it needs the full workflow."
        actions={
          canEdit && (
            <Button onClick={() => openEditor(null)}>
              <Plus />
              New rush order
            </Button>
          )
        }
      />

      <MetricBar
        loading={!data}
        metrics={[
          { label: "Open", value: s?.open ?? 0, hint: `${formatINR(s?.openEstimated || 0)} estimated`, onClick: () => toggle("open"), active: view === "open" },
          {
            label: "Due within 24 h",
            value: s?.due ?? 0,
            hint: s?.overdue ? `${s.overdue} overdue` : "Nothing overdue",
            tone: s?.overdue ? "danger" : s?.due ? "warning" : "default",
            onClick: () => toggle("due"),
            active: view === "due"
          },
          {
            label: "Completed",
            value: s?.completedThisWeek ?? 0,
            hint: `This week · ${(s?.converted || 0).toLocaleString("en-IN")} became jobs`,
            tone: "success",
            onClick: () => toggle("completed"),
            active: view === "completed"
          },
          { label: "To collect", value: formatINR(Math.max(0, (s?.openEstimated || 0) - (s?.openAdvance || 0))), hint: `${formatINR(s?.openAdvance || 0)} advance received` }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<RushView>
          value={view}
          onChange={setView}
          tabs={[
            { value: "open", label: "Open", count: s?.open },
            { value: "due", label: "Due within 24 h", count: s?.due, tone: s?.overdue ? "danger" : "warning" },
            { value: "completed", label: "Completed", count: s?.completed },
            { value: "cancelled", label: "Cancelled", count: s?.cancelled },
            { value: "all", label: "All", count: s?.all }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search customer, phone, order no. or details" />}>
              <FilterSelect label="Priority" value={priority} onChange={setPriority} options={(Object.keys(PRIORITY_LABEL) as (keyof typeof PRIORITY_LABEL)[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
            </Toolbar>
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="orders" />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(o) => o._id}
            loading={loading && !data}
            onRowClick={canEdit ? (o) => o.status !== "converted" && o.status !== "cancelled" && openEditor(o) : undefined}
            actions={actions}
            actionsLabel={(o) => `Actions for ${o.orderId}`}
            mobile={(o) => {
              const job = jobOf(o);
              return (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{o.customerName}</span>
                    <span className="num shrink-0 font-semibold">{formatINR(o.estimatedAmount)}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{o.orderDetails}</div>
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="truncate">
                      {neededBy(o)}
                      {dueNote(o).text && (
                        <>
                          {" · "}
                          <Due o={o} />
                        </>
                      )}
                    </span>
                    <StatusPill tone={STATUS_META[o.status].tone}>{job ? "Job created" : STATUS_META[o.status].label}</StatusPill>
                  </div>
                </div>
              );
            }}
            empty={
              filtered || view !== "all" ? (
                <EmptyState
                  compact
                  icon={Zap}
                  title={view === "open" && !filtered ? "No open rush orders" : view === "due" && !filtered ? "Nothing due in the next 24 hours" : "No rush orders in this view"}
                  description={filtered ? "Try another search or priority." : "Try another view."}
                  tone={(view === "open" || view === "due") && !filtered ? "success" : "default"}
                  action={
                    canEdit && view === "open" && !filtered && (
                      <Button variant="outline" onClick={() => openEditor(null)}>
                        <Plus />
                        New rush order
                      </Button>
                    )
                  }
                />
              ) : (
                <EmptyState
                  icon={Zap}
                  title="No rush orders yet"
                  description="Take down urgent work in seconds — who, what and by when. Convert it to a job when it needs the full workflow."
                  action={
                    canEdit && (
                      <Button onClick={() => openEditor(null)}>
                        <Plus />
                        New rush order
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <RushOrderEditor open={editorOpen} onOpenChange={setEditorOpen} order={editing} onSaved={() => load()} />
      <ConvertToJobDialog order={converting} onClose={() => setConverting(null)} onConverted={() => load()} />
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this rush order?"
        description={cancelling ? `${cancelling.orderId} for ${cancelling.customerName}. It moves to Cancelled and can't be converted to a job.` : undefined}
        confirmLabel="Cancel order"
        cancelLabel="Keep"
        onConfirm={async () => {
          if (!cancelling) return;
          await setStatus(cancelling, "cancelled");
          setCancelling(null);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this rush order?"
        description={deleting ? `${deleting.orderId} for ${deleting.customerName}.${jobOf(deleting) ? " The job it became is kept." : ""} This can't be undone.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
