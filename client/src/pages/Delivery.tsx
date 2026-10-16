import { useCallback, useEffect, useState } from "react";
import { startOfWeek } from "date-fns";
import { Ban, CheckCircle2, Eye, Pencil, Plus, Printer, RotateCcw, Trash2, Truck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type RowAction } from "@/components/data";
import { DeliveryDetail } from "@/components/delivery/DeliveryDetail";
import { DeliveryEditor } from "@/components/delivery/DeliveryEditor";
import { DeliveryStatusDialog, type StatusMode } from "@/components/delivery/DeliveryStatusDialog";
import { printChallan, type ChallanBusiness } from "@/components/delivery/challan";
import { PRIORITY_LABEL, STATUS_META, dateOnly, fmtPhone, isOpen, jobTitleOf, localToday, slotLabel } from "@/components/delivery/deliveryMeta";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { deliveriesApi, type Delivery, type DeliveryList, type DeliveryView } from "@/lib/api/deliveries";
import { dueLabel, fmtDate, formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

interface CompanySettings {
  companyName?: string;
  companyAddress?: { street?: string; city?: string; state?: string; zipCode?: string };
  companyPhone?: string;
  companyEmail?: string;
  gstNumber?: string;
}

/** "Due today" / "2 days overdue" under the date of a delivery that's still open. */
function DueNote({ d }: { d: Delivery }) {
  if (!isOpen(d)) return null;
  const label = dueLabel(dateOnly(d.deliveryDate));
  return <span className={cn(label.includes("overdue") && "font-medium text-destructive-strong")}>{label}</span>;
}

export default function DeliveryPage() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Delivery: Create & Edit");
  const canStatus = hasPermission("Delivery: Update Status");
  const [data, setData] = useState<DeliveryList | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<DeliveryView>("today");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [priority, setPriority] = useState("all");
  const [page, setPage] = useState(1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Delivery | null>(null);
  const [detail, setDetail] = useState<Delivery | null>(null);
  const [status, setStatus] = useState<{ d: Delivery; mode: StatusMode } | null>(null);
  const [cancelling, setCancelling] = useState<Delivery | null>(null);
  const [deleting, setDeleting] = useState<Delivery | null>(null);
  const [business, setBusiness] = useState<ChallanBusiness>({ name: user?.companyName || "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await deliveriesApi.list({
          view,
          search: q || undefined,
          priority: priority === "all" ? undefined : priority,
          today: localToday(),
          weekStart: startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString(),
          page,
          limit: PAGE_SIZE
        })
      );
    } catch (error) {
      toast({ title: "Deliveries could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [view, q, priority, page, toast]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [view, q, priority]);

  // The challan header: the business's own settings, else the login's company name.
  useEffect(() => {
    const fallback = user?.companyName || "";
    setBusiness({ name: fallback });
    if (user?.role !== "admin") return;
    apiClient
      .get<{ settings: CompanySettings }>("/settings")
      .then(({ settings: s }) => {
        const addr = s?.companyAddress;
        setBusiness({
          name: s?.companyName && s.companyName !== "My Company" ? s.companyName : fallback,
          address: addr ? [addr.street, addr.city, [addr.state, addr.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : undefined,
          phone: s?.companyPhone,
          email: s?.companyEmail,
          gstNumber: s?.gstNumber
        });
      })
      .catch(() => undefined);
  }, [user?.role, user?.companyName]);

  /** Show a changed delivery straight away, then refresh the counts. */
  const changed = (d: Delivery) => {
    setDetail((cur) => (cur && cur._id === d._id ? d : cur));
    load();
  };

  const print = (d: Delivery) => {
    try {
      printChallan(d, business);
    } catch (error) {
      toast({ title: "Challan not opened", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const openEditor = (d: Delivery | null) => {
    setEditing(d);
    setDetail(null);
    setEditorOpen(true);
  };
  const openStatus = (d: Delivery, mode: StatusMode) => setStatus({ d, mode });

  const cancel = async () => {
    if (!cancelling) return;
    try {
      const d = await deliveriesApi.setStatus(cancelling._id, { status: "cancelled" });
      toast({ title: `${d.deliveryId} cancelled` });
      setCancelling(null);
      changed(d);
    } catch (error) {
      toast({ title: "Not cancelled", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await deliveriesApi.remove(deleting._id);
      toast({ title: `${deleting.deliveryId} deleted` });
      setDetail((cur) => (cur?._id === deleting._id ? null : cur));
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const s = data?.summary;
  const rows = data?.deliveries || [];
  const total = data?.pagination.totalDeliveries || 0;
  const toggle = (v: DeliveryView) => setView(view === v ? "all" : v);

  const actions = (d: Delivery): RowAction[] => [
    { label: "View details", icon: Eye, onClick: () => setDetail(d) },
    { label: "Dispatch", icon: Truck, onClick: () => openStatus(d, "dispatch"), hidden: !canStatus || d.status !== "scheduled", separated: true },
    { label: "Mark delivered", icon: CheckCircle2, onClick: () => openStatus(d, "deliver"), hidden: !canStatus || !isOpen(d) },
    { label: "Mark failed", icon: XCircle, onClick: () => openStatus(d, "fail"), hidden: !canStatus || !isOpen(d) },
    { label: "Reschedule", icon: RotateCcw, onClick: () => openStatus(d, "reschedule"), hidden: !canStatus || !(d.status === "failed" || (d.status === "cancelled" && canEdit)) },
    { label: "Print challan", icon: Printer, onClick: () => print(d), separated: true },
    { label: "Edit", icon: Pencil, onClick: () => openEditor(d), hidden: !canEdit || d.status === "delivered" || d.status === "cancelled" },
    { label: "Cancel delivery", icon: Ban, onClick: () => setCancelling(d), hidden: !canEdit || d.status === "delivered" || d.status === "cancelled", separated: true },
    { label: "Delete", icon: Trash2, destructive: true, onClick: () => setDeleting(d), hidden: !canEdit }
  ];

  const columns: Column<Delivery>[] = [
    {
      id: "customer",
      header: "Delivery",
      cell: (d) => (
        <EntityCell
          className="max-w-[300px]"
          avatar={d.customerName}
          title={d.customerName}
          subtitle={
            <>
              <span className="font-mono">{d.deliveryId}</span>
              {jobTitleOf(d) ? ` · ${jobTitleOf(d)}` : ""}
            </>
          }
        />
      ),
      sortValue: (d) => d.customerName.toLowerCase(),
      className: "min-w-[240px]"
    },
    {
      id: "date",
      header: "Date",
      cell: (d) => <Stack top={<span className="whitespace-nowrap">{fmtDate(dateOnly(d.deliveryDate))}</span>} bottom={isOpen(d) ? <DueNote d={d} /> : slotLabel(d.deliveryTimeSlot)} />,
      sortValue: (d) => d.deliveryDate,
      className: "w-[150px]"
    },
    {
      id: "address",
      header: "Address",
      cell: (d) => <Stack top={<span className="block max-w-[200px] truncate">{d.deliveryAddress?.street}</span>} bottom={[d.deliveryAddress?.city, d.deliveryAddress?.pincode].filter(Boolean).join(" ")} />,
      hideBelow: "lg"
    },
    {
      id: "driver",
      header: "Driver",
      cell: (d) => (d.driverInfo?.name ? <Stack top={d.driverInfo.name} bottom={d.driverInfo.vehicleNumber || fmtPhone(d.driverInfo.phone)} /> : <span className="text-muted-foreground">Not assigned</span>),
      sortValue: (d) => d.driverInfo?.name || "",
      hideBelow: "md"
    },
    {
      id: "payment",
      header: "Collect",
      align: "right",
      cell: (d) => (d.paymentMethod === "COD" ? <span className="font-medium">{formatINR(d.codAmount || 0)}</span> : <span className="text-muted-foreground">Prepaid</span>),
      sortValue: (d) => (d.paymentMethod === "COD" ? d.codAmount || 0 : 0),
      hideBelow: "lg"
    },
    {
      id: "status",
      header: "Status",
      cell: (d) => (
        <Stack
          top={
            <span className="inline-flex items-center gap-1.5">
              <StatusPill tone={STATUS_META[d.status].tone}>{STATUS_META[d.status].label}</StatusPill>
              {d.priority === "urgent" && <Tag className="border-destructive/30 text-destructive-strong">Urgent</Tag>}
            </span>
          }
          bottom={(d.attempts || 0) > 0 ? `Attempt ${(d.attempts || 0) + 1}` : d.status === "failed" ? d.failureReason : undefined}
        />
      ),
      sortValue: (d) => d.status,
      className: "w-[170px]"
    }
  ];

  const filtered = !!q || priority !== "all";

  return (
    <PageShell>
      <PageHeader
        eyebrow="Production"
        title="Dispatch"
        description="Deliveries of finished jobs: what goes out today, who's carrying it and what came back."
        actions={
          canEdit && (
            <Button onClick={() => openEditor(null)}>
              <Plus />
              Schedule delivery
            </Button>
          )
        }
      />

      <MetricBar
        loading={!data}
        metrics={[
          {
            label: "Due today",
            value: s?.today ?? 0,
            hint: s?.overdue ? `${s.overdue} overdue` : "Nothing overdue",
            tone: s?.overdue ? "danger" : s?.today ? "warning" : "default",
            onClick: () => toggle("today"),
            active: view === "today"
          },
          { label: "In transit", value: s?.in_transit ?? 0, hint: "Out with drivers", tone: s?.in_transit ? "info" : "default", onClick: () => toggle("in_transit"), active: view === "in_transit" },
          { label: "Delivered", value: s?.deliveredThisWeek ?? 0, hint: `This week · ${(s?.delivered ?? 0).toLocaleString("en-IN")} in all`, tone: "success", onClick: () => toggle("delivered"), active: view === "delivered" },
          {
            label: "Failed",
            value: s?.failed ?? 0,
            hint: s?.failed ? "Waiting to be rescheduled" : "None to retry",
            tone: s?.failed ? "danger" : "default",
            onClick: () => toggle("failed"),
            active: view === "failed"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<DeliveryView>
          value={view}
          onChange={setView}
          tabs={[
            { value: "today", label: "Today", count: s?.today, tone: s?.overdue ? "danger" : "default" },
            { value: "upcoming", label: "Upcoming", count: s?.upcoming },
            { value: "in_transit", label: "In transit", count: s?.in_transit },
            { value: "delivered", label: "Delivered", count: s?.delivered },
            { value: "failed", label: "Failed & cancelled", count: s ? s.failed + s.cancelled : undefined, tone: s?.failed ? "danger" : "default" },
            { value: "all", label: "All", count: s?.all }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search customer, challan no., driver or city" />}>
              <FilterSelect label="Priority" value={priority} onChange={setPriority} options={(Object.keys(PRIORITY_LABEL) as (keyof typeof PRIORITY_LABEL)[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
            </Toolbar>
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="deliveries" />}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(d) => d._id}
            loading={loading && !data}
            onRowClick={(d) => setDetail(d)}
            actions={actions}
            actionsLabel={(d) => `Actions for ${d.deliveryId}`}
            mobile={(d) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{d.customerName}</span>
                  <StatusPill tone={STATUS_META[d.status].tone}>{STATUS_META[d.status].label}</StatusPill>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{d.deliveryId}</span> · {fmtDate(dateOnly(d.deliveryDate))}
                  {isOpen(d) && (
                    <>
                      {" · "}
                      <DueNote d={d} />
                    </>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[d.deliveryAddress?.city, d.driverInfo?.name || "No driver yet", d.paymentMethod === "COD" ? `Collect ${formatINR(d.codAmount || 0)}` : null].filter(Boolean).join(" · ")}
                </div>
              </div>
            )}
            empty={
              filtered || view !== "all" ? (
                <EmptyState
                  compact
                  icon={Truck}
                  title={view === "today" && !filtered ? "Nothing to deliver today" : "No deliveries in this view"}
                  description={view === "today" && !filtered ? "Deliveries scheduled for today, and any still open from earlier days, show here." : "Try another view, priority or search."}
                  tone={view === "today" && !filtered ? "success" : "default"}
                />
              ) : (
                <EmptyState
                  icon={Truck}
                  title="No deliveries yet"
                  description="Schedule a delivery when a job is ready to go out. Print the challan for the driver and track it until it's received."
                  action={
                    canEdit && (
                      <Button onClick={() => openEditor(null)}>
                        <Plus />
                        Schedule delivery
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <DeliveryEditor open={editorOpen} onOpenChange={setEditorOpen} delivery={editing} onSaved={changed} />
      <DeliveryDetail
        delivery={detail}
        onOpenChange={(o) => !o && setDetail(null)}
        canEdit={canEdit}
        canStatus={canStatus}
        onStatus={openStatus}
        onEdit={openEditor}
        onPrint={print}
      />
      <DeliveryStatusDialog delivery={status?.d || null} mode={status?.mode || null} onClose={() => setStatus(null)} onDone={changed} />
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this delivery?"
        description={cancelling ? `${cancelling.deliveryId} for ${cancelling.customerName}. You can reschedule it later if plans change.` : undefined}
        confirmLabel="Cancel delivery"
        cancelLabel="Keep"
        onConfirm={cancel}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this delivery?"
        description={deleting ? `${deleting.deliveryId} for ${deleting.customerName} and its history. This can't be undone.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
