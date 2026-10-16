import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Download, Pencil, Plus, ReceiptText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog, DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { NewPurchaseBillDialog } from "@/components/purchase-bills/NewPurchaseBillDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { daysUntil, dueLabel, fmtDate, formatINR } from "@/lib/format";

interface Bill {
  _id: string;
  billNumber: string;
  vendorName: string;
  vendorInvoiceNumber?: string;
  billDate: string;
  dueDate?: string;
  totalAmount: number;
  paidAmount?: number;
  balanceAmount?: number;
  paymentStatus: "pending" | "partial" | "paid";
}

interface Stats {
  totalBills: number;
  totalAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  overdueAmount?: number;
  counts?: Partial<Record<"pending" | "partial" | "paid" | "overdue", number>>;
}

type View = "all" | "pending" | "partial" | "overdue" | "paid";
const PAGE_SIZE = 25;

const isOverdue = (b: Bill) => b.paymentStatus !== "paid" && (daysUntil(b.dueDate) ?? 0) < 0;
const statusOf = (b: Bill): { label: string; tone: PillTone } =>
  b.paymentStatus === "paid"
    ? { label: "Paid", tone: "success" }
    : isOverdue(b)
      ? { label: "Overdue", tone: "danger" }
      : b.paymentStatus === "partial"
        ? { label: "Part paid", tone: "info" }
        : { label: "Unpaid", tone: "warning" };

export default function PurchaseBills() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const vendor = params.get("vendor") || "all";
  const [bills, setBills] = useState<Bill[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [vendors, setVendors] = useState<{ _id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [view, setView] = useState<View>("all");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ open: boolean; bill: Bill | null }>({ open: false, bill: null });
  const [deleting, setDeleting] = useState<Bill | null>(null);

  const canEdit = hasPermission("Purchase Bills: Create & Edit");
  const canDelete = hasPermission("Purchase Bills: Delete");
  const canPay = hasPermission("Purchase Bills: Record Payment") || canEdit;

  const loadStats = useCallback(async () => {
    try {
      const res = (await apiClient.getPurchaseBillStats()) as { stats?: Stats };
      setStats(res?.stats || null);
    } catch {
      setStats(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE), sortBy: "billDate", sortOrder: "desc" };
      if (q) p.search = q;
      if (view !== "all") p.paymentStatus = view;
      if (vendor !== "all") p.vendorId = vendor;
      const res = (await apiClient.getPurchaseBills(p)) as { bills?: Bill[]; pagination?: { totalBills?: number } };
      setBills(res?.bills || []);
      setTotal(res?.pagination?.totalBills ?? (res?.bills || []).length);
    } catch (error) {
      toast({ title: "Purchase bills could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, q, view, vendor, toast]);

  useEffect(() => {
    loadStats();
    apiClient
      .getVendors({ limit: 100 })
      .then((r) => setVendors(((r as { vendors?: { _id: string; name: string }[] })?.vendors || []).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setVendors([]));
  }, [loadStats]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [q, view, vendor]);

  const refresh = () => {
    load();
    loadStats();
  };

  const setVendor = (v: string) => setParams(v === "all" ? {} : { vendor: v }, { replace: true });

  const markPaid = async (b: Bill) => {
    try {
      await apiClient.updatePurchaseBill(b._id, { paidAmount: b.totalAmount });
      toast({ title: `${b.billNumber} marked as paid` });
      refresh();
    } catch (error) {
      toast({ title: "Not updated", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const download = async (b: Bill) => {
    try {
      toast({ title: `Preparing ${b.billNumber}…` });
      await apiClient.downloadPurchaseBillPDF(b._id);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deletePurchaseBill(deleting._id);
      toast({ title: `${deleting.billNumber} deleted` });
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const c = stats?.counts || {};
  const vendorName = vendors.find((v) => v._id === vendor)?.name;

  const columns: Column<Bill>[] = [
    {
      id: "bill",
      header: "Bill",
      cell: (b) => <EntityCell title={b.billNumber} mono subtitle={b.vendorInvoiceNumber ? `Supplier ref ${b.vendorInvoiceNumber}` : undefined} />,
      sortValue: (b) => b.billNumber,
      className: "min-w-[170px]"
    },
    { id: "vendor", header: "Supplier", cell: (b) => <span className="font-medium">{b.vendorName}</span>, sortValue: (b) => b.vendorName },
    { id: "date", header: "Bill date", cell: (b) => <span className="whitespace-nowrap">{fmtDate(b.billDate)}</span>, sortValue: (b) => b.billDate, hideBelow: "lg" },
    {
      id: "due",
      header: "Due",
      cell: (b) => (
        <Stack
          top={<span className="whitespace-nowrap">{fmtDate(b.dueDate)}</span>}
          bottom={b.paymentStatus !== "paid" && b.dueDate ? <span className={isOverdue(b) ? "text-destructive-strong" : undefined}>{dueLabel(b.dueDate)}</span> : undefined}
        />
      ),
      sortValue: (b) => b.dueDate || "",
      hideBelow: "md"
    },
    { id: "amount", header: "Amount", align: "right", cell: (b) => formatINR(b.totalAmount || 0), sortValue: (b) => b.totalAmount },
    {
      id: "balance",
      header: "Balance",
      align: "right",
      cell: (b) =>
        (b.balanceAmount || 0) > 0.5 ? <span className="font-semibold">{formatINR(b.balanceAmount || 0)}</span> : <span className="text-muted-foreground">—</span>,
      sortValue: (b) => b.balanceAmount || 0
    },
    {
      id: "status",
      header: "Status",
      cell: (b) => {
        const s = statusOf(b);
        return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
      },
      className: "w-[110px]"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Materials & purchase"
        title="Purchase bills"
        description="Bills from paper, ink and plate suppliers — what you bought, what's paid and what's still due."
        actions={
          canEdit && (
            <Button onClick={() => setDialog({ open: true, bill: null })}>
              <Plus />
              Record a bill
            </Button>
          )
        }
      />

      <MetricBar
        loading={!stats && loading}
        metrics={[
          { label: "Purchases", value: formatINR(stats?.totalAmount || 0, { compact: (stats?.totalAmount || 0) >= 1e5 }), hint: `${stats?.totalBills || 0} bills` },
          { label: "Paid", value: formatINR(stats?.paidAmount || 0, { compact: (stats?.paidAmount || 0) >= 1e5 }), hint: `${c.paid || 0} bills settled`, tone: "success" },
          {
            label: "Outstanding",
            value: formatINR(stats?.outstandingAmount || 0, { compact: (stats?.outstandingAmount || 0) >= 1e5 }),
            hint: `${(c.pending || 0) + (c.partial || 0)} bills to pay`,
            tone: (stats?.outstandingAmount || 0) > 0 ? "warning" : "default",
            onClick: () => setView(view === "pending" ? "all" : "pending"),
            active: view === "pending"
          },
          {
            label: "Overdue",
            value: formatINR(stats?.overdueAmount || 0, { compact: (stats?.overdueAmount || 0) >= 1e5 }),
            hint: c.overdue ? `${c.overdue} past the due date` : "Nothing overdue",
            tone: c.overdue ? "danger" : "default",
            onClick: () => setView(view === "overdue" ? "all" : "overdue"),
            active: view === "overdue"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All bills", count: stats?.totalBills },
            { value: "pending", label: "Unpaid", count: c.pending || 0 },
            { value: "partial", label: "Part paid", count: c.partial || 0 },
            { value: "overdue", label: "Overdue", count: c.overdue || 0, tone: "danger" },
            { value: "paid", label: "Paid", count: c.paid || 0 }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search bill no., supplier or supplier ref" />}>
              <FilterSelect label="Supplier" value={vendor} onChange={setVendor} options={vendors.map((v) => ({ value: v._id, label: v.name }))} />
            </Toolbar>
          }
          footer={!loading && total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="bills" />}
        >
          <DataTable
            columns={columns}
            rows={bills}
            rowKey={(b) => b._id}
            loading={loading}
            onRowClick={canEdit ? (b) => setDialog({ open: true, bill: b }) : undefined}
            actions={(b) => [
              { label: "Edit bill", icon: Pencil, onClick: () => setDialog({ open: true, bill: b }), hidden: !canEdit },
              { label: "Mark as paid", icon: CheckCircle2, onClick: () => markPaid(b), hidden: !canPay || b.paymentStatus === "paid" },
              { label: "Download PDF", icon: Download, onClick: () => download(b) },
              { label: "Delete bill", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(b), hidden: !canDelete }
            ]}
            actionsLabel={(b) => `Actions for ${b.billNumber}`}
            mobile={(b) => {
              const s = statusOf(b);
              return (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{b.vendorName}</span>
                    <span className="num font-semibold">{formatINR(b.totalAmount || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {b.billNumber} · {fmtDate(b.billDate)}
                    </span>
                    <StatusPill tone={s.tone}>{s.label}</StatusPill>
                  </div>
                </div>
              );
            }}
            empty={
              q || view !== "all" || vendor !== "all" ? (
                <EmptyState
                  compact
                  icon={ReceiptText}
                  title={vendorName ? `No bills from ${vendorName} in this view` : "No bills in this view"}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch("");
                        setView("all");
                        setVendor("all");
                      }}
                    >
                      Show all bills
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={ReceiptText}
                  title="No purchase bills yet"
                  description="Record supplier bills to track what you owe and claim input GST."
                  action={
                    canEdit && (
                      <Button onClick={() => setDialog({ open: true, bill: null })}>
                        <Plus />
                        Record a bill
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <NewPurchaseBillDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={refresh}
        bill={dialog.bill}
        defaultVendorId={vendor !== "all" ? vendor : undefined}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.billNumber}?`}
        description="The bill is removed permanently, along with what it says you owe this supplier."
        onConfirm={remove}
      />
    </PageShell>
  );
}
