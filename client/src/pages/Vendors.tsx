import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Factory, FileText, Pencil, Plus, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column } from "@/components/data";
import { CreateVendorDialog } from "@/components/vendors/CreateVendorDialog";
import { VendorDialog as EditVendorDialog } from "@/components/vendors/EditVendorDialog";
import { NewPurchaseBillDialog } from "@/components/purchase-bills/NewPurchaseBillDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR } from "@/lib/format";

interface Vendor {
  _id: string;
  name: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  gstNumber?: string;
  vendorType?: string;
  paymentTerms?: string;
  status: "active" | "inactive" | "blacklisted";
  address?: { city?: string; state?: string };
  /** From purchase bills; null when this login can't see bills. */
  purchases?: { billed: number; outstanding: number; bills: number; lastBillDate?: string } | null;
}

type View = "all" | "owed" | "active" | "inactive";

export default function Vendors() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [type, setType] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [billFor, setBillFor] = useState<Vendor | null>(null);

  const canEdit = hasPermission("Vendors: Create & Edit");
  const canBill = hasPermission("Purchase Bills: Create & Edit");
  const seesBills = hasPermission("Purchase Bills");

  const load = useCallback(async () => {
    try {
      const res = (await apiClient.getVendors({ limit: 100 })) as { vendors?: Vendor[] };
      setVendors(res?.vendors || []);
    } catch (error) {
      toast({ title: "Suppliers could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const owes = (v: Vendor) => (v.purchases?.outstanding || 0) > 0.5;
  const inView = (v: Vendor, w: View) => (w === "all" ? true : w === "owed" ? owes(v) : w === "active" ? v.status === "active" : v.status !== "active");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors.filter(
      (v) =>
        inView(v, view) &&
        (type === "all" || v.vendorType === type) &&
        (!q || [v.name, v.contactPerson, v.email, v.phone, v.gstNumber].some((f) => (f || "").toLowerCase().includes(q)))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendors, search, view, type]);

  const purchased = vendors.reduce((s, v) => s + (v.purchases?.billed || 0), 0);
  const outstanding = vendors.reduce((s, v) => s + (v.purchases?.outstanding || 0), 0);
  const bills = vendors.reduce((s, v) => s + (v.purchases?.bills || 0), 0);
  const types = Array.from(new Set(vendors.map((v) => v.vendorType).filter(Boolean))) as string[];

  const columns: Column<Vendor>[] = [
    {
      id: "name",
      header: "Supplier",
      cell: (v) => <EntityCell avatar={v.name} title={v.name} subtitle={[v.vendorType, v.address?.city].filter(Boolean).join(" · ") || undefined} />,
      sortValue: (v) => v.name.toLowerCase(),
      className: "min-w-[220px]"
    },
    {
      id: "contact",
      header: "Contact",
      cell: (v) => <Stack top={v.contactPerson || v.phone || <span className="text-muted-foreground">—</span>} bottom={v.contactPerson ? v.phone : v.email} />,
      hideBelow: "md"
    },
    {
      id: "gst",
      header: "GSTIN",
      cell: (v) => (v.gstNumber ? <span className="font-mono text-xs">{v.gstNumber}</span> : <span className="text-muted-foreground">—</span>),
      hideBelow: "xl"
    },
    {
      id: "terms",
      header: "Terms",
      cell: (v) => <span className="whitespace-nowrap">{v.paymentTerms || "—"}</span>,
      sortValue: (v) => v.paymentTerms || "",
      hideBelow: "lg"
    },
    ...(seesBills
      ? ([
          {
            id: "purchased",
            header: "Purchased",
            align: "right",
            cell: (v) => (
              <Stack
                top={v.purchases ? formatINR(v.purchases.billed) : <span className="text-muted-foreground">—</span>}
                bottom={v.purchases ? `${v.purchases.bills} bill${v.purchases.bills === 1 ? "" : "s"} · last ${fmtDate(v.purchases.lastBillDate)}` : undefined}
              />
            ),
            sortValue: (v) => v.purchases?.billed || 0,
            hideBelow: "lg"
          },
          {
            id: "owed",
            header: "You owe",
            align: "right",
            cell: (v) => (owes(v) ? <span className="font-semibold text-warning-strong">{formatINR(v.purchases!.outstanding)}</span> : <span className="text-muted-foreground">—</span>),
            sortValue: (v) => v.purchases?.outstanding || 0
          }
        ] as Column<Vendor>[])
      : []),
    {
      id: "status",
      header: "Status",
      cell: (v) => (
        <StatusPill tone={v.status === "active" ? "success" : v.status === "blacklisted" ? "danger" : "neutral"}>
          {v.status === "active" ? "Active" : v.status === "blacklisted" ? "Blacklisted" : "Inactive"}
        </StatusPill>
      ),
      sortValue: (v) => v.status,
      className: "w-[110px]"
    }
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Materials & purchase"
        title="Suppliers"
        description="Paper merchants, ink and plate suppliers and finishing partners, with what you've bought and still owe."
        actions={
          canEdit && (
            <Button onClick={() => setShowCreate(true)}>
              <Plus />
              Add supplier
            </Button>
          )
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Suppliers", value: vendors.length, hint: `${vendors.filter((v) => v.status === "active").length} active` },
          ...(seesBills
            ? [
                { label: "Purchased", value: formatINR(purchased, { compact: purchased >= 1e5 }), hint: `${bills} purchase bill${bills === 1 ? "" : "s"}` },
                {
                  label: "You owe",
                  value: formatINR(outstanding, { compact: outstanding >= 1e5 }),
                  hint: `${vendors.filter(owes).length} supplier${vendors.filter(owes).length === 1 ? "" : "s"}`,
                  tone: (outstanding > 0 ? "warning" : "success") as "warning" | "success",
                  onClick: () => setView(view === "owed" ? "all" : "owed"),
                  active: view === "owed"
                }
              ]
            : []),
          { label: "With GSTIN", value: vendors.filter((v) => v.gstNumber).length, hint: "Input tax credit possible" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All", count: vendors.length },
            ...(seesBills ? [{ value: "owed" as View, label: "You owe", count: vendors.filter(owes).length, tone: "warning" as const }] : []),
            { value: "active", label: "Active", count: vendors.filter((v) => v.status === "active").length },
            { value: "inactive", label: "Inactive", count: vendors.filter((v) => v.status !== "active").length }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search supplier, contact or GSTIN" />}>
              {types.length > 1 && <FilterSelect label="Type" value={type} onChange={setType} options={types.map((t) => ({ value: t, label: t }))} />}
            </Toolbar>
          }
          footer={!loading && rows.length > 0 && `${rows.length} of ${vendors.length} suppliers`}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(v) => v._id}
            loading={loading}
            onRowClick={canEdit ? (v) => setEditing(v) : undefined}
            actions={(v) => [
              { label: "Edit supplier", icon: Pencil, onClick: () => setEditing(v), hidden: !canEdit },
              { label: "Record a bill", icon: ReceiptText, onClick: () => setBillFor(v), hidden: !canBill },
              { label: "View bills", icon: FileText, onClick: () => navigate(`/purchase-bills?vendor=${v._id}`), hidden: !seesBills }
            ]}
            actionsLabel={(v) => `Actions for ${v.name}`}
            defaultSort={{ id: "name", dir: "asc" }}
            rowClassName={(v) => (v.status !== "active" ? "text-muted-foreground" : undefined)}
            mobile={(v) => (
              <div className="flex items-start justify-between gap-3">
                <EntityCell avatar={v.name} title={v.name} subtitle={v.contactPerson || v.phone || v.vendorType} />
                {owes(v) ? (
                  <div className="shrink-0 text-right">
                    <div className="num text-sm font-semibold text-warning-strong">{formatINR(v.purchases!.outstanding)}</div>
                    <div className="text-xs text-muted-foreground">you owe</div>
                  </div>
                ) : (
                  <StatusPill tone={v.status === "active" ? "success" : "neutral"}>{v.status === "active" ? "Active" : "Inactive"}</StatusPill>
                )}
              </div>
            )}
            empty={
              vendors.length === 0 ? (
                <EmptyState
                  icon={Factory}
                  title="No suppliers yet"
                  description="Add the paper merchants and partners you buy from to record their bills and track what you owe."
                  action={
                    canEdit && (
                      <Button onClick={() => setShowCreate(true)}>
                        <Plus />
                        Add supplier
                      </Button>
                    )
                  }
                />
              ) : (
                <EmptyState compact icon={Factory} title="No suppliers in this view" description="Try another search or view." />
              )
            }
          />
        </DataCard>
      </div>

      <CreateVendorDialog open={showCreate} onOpenChange={setShowCreate} onVendorCreated={load} />
      <EditVendorDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onSuccess={() => {
          setEditing(null);
          load();
        }}
        vendor={editing}
      />
      <NewPurchaseBillDialog
        open={!!billFor}
        onOpenChange={(o) => !o && setBillFor(null)}
        onSaved={() => {
          setBillFor(null);
          load();
        }}
        defaultVendorId={billFor?._id}
      />
    </PageShell>
  );
}
