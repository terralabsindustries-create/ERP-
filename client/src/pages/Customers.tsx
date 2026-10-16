import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, BadgeCheck, Briefcase, Download, FileText, Pencil, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, FilterSelect, MetricBar, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type Metric } from "@/components/data";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { EditCustomerDialog } from "@/components/customers/EditCustomerDialog";
import { CreateJobDialog } from "@/components/jobs/CreateJobDialog";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { exportToCSV, formatCustomersForExport } from "@/utils/exportUtils";
import { formatINR, localDate } from "@/lib/format";

interface Customer {
  id: string;
  _id?: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  company: string | null;
  notes: string | null;
  gstNumber: string | null;
  customerType: string;
  tags: string[];
  status: string;
  createdAt: string;
  isBlacklisted?: boolean;
  gstVerified?: boolean;
  /** Issued invoices; null when this login can't see invoices. */
  billing?: { invoiced: number; outstanding: number; invoices: number; lastInvoiceDate?: string } | null;
}

type View = "all" | "business" | "individual" | "walkin" | "inactive";

const isBusiness = (c: Customer) => c.customerType === "Business" || c.customerType === "Corporate";
const inView = (c: Customer, v: View) =>
  v === "all"
    ? true
    : v === "inactive"
      ? c.status !== "active"
      : c.status === "active" &&
        (v === "business" ? isBusiness(c) : v === "walkin" ? c.customerType === "Walk-in" : !isBusiness(c) && c.customerType !== "Walk-in");

/** Fetches every customer, a hundred at a time (the API's page limit). */
async function fetchAllCustomers(): Promise<Customer[]> {
  const all: Customer[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = (await apiClient.getCustomer({ status: "all", limit: 100, page })) as { customers?: Customer[]; pagination?: { total?: number } };
    const batch = res?.customers || [];
    all.push(...batch.map((c) => ({ ...c, id: c.id || (c._id as string) })));
    if (batch.length < 100 || page >= (res?.pagination?.total || 1)) break;
  }
  return all;
}

export default function Customers() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  // A search from the header while already on this page arrives as a new ?q.
  const qParam = searchParams.get("q");
  useEffect(() => {
    if (qParam !== null) setSearch(qParam);
  }, [qParam]);
  const [view, setView] = useState<View>("all");
  const [gst, setGst] = useState("all");
  const [tag, setTag] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [jobFor, setJobFor] = useState<Customer | null>(null);

  const canEdit = hasPermission("Customers: Create & Edit");
  const canCreateJob = hasPermission("Jobs: Create & Edit");
  const canExport = hasPermission("Customers: Export");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      setCustomers(await fetchAllCustomers());
    } catch (error) {
      toast({ title: "Customers could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const showBilling = customers.some((c) => c.billing !== undefined && c.billing !== null) || hasPermission("Invoicing");
  const allTags = useMemo(() => Array.from(new Set(customers.flatMap((c) => c.tags || []))).sort(), [customers]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return customers.filter((c) => {
      const matches =
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.company || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q) ||
        (c.gstNumber || "").toLowerCase().includes(q) ||
        (!!digits && (c.phone || "").replace(/\D/g, "").includes(digits));
      const gstOk =
        gst === "all" || (gst === "verified" ? !!c.gstVerified : gst === "unverified" ? !!c.gstNumber && !c.gstVerified : !c.gstNumber);
      return matches && inView(c, view) && gstOk && (tag === "all" || (c.tags || []).includes(tag));
    });
  }, [customers, search, view, gst, tag]);

  const count = (v: View) => customers.filter((c) => inView(c, v)).length;
  const billed = customers.reduce((s, c) => s + (c.billing?.invoiced || 0), 0);
  const outstanding = customers.reduce((s, c) => s + (c.billing?.outstanding || 0), 0);
  const owing = customers.filter((c) => (c.billing?.outstanding || 0) > 0.5).length;
  const active = customers.filter((c) => c.status === "active").length;

  const metrics: Metric[] = [
    { label: "Customers", value: customers.length, hint: `${active} active` },
    { label: "Businesses", value: customers.filter(isBusiness).length, hint: `${customers.filter((c) => c.gstNumber).length} with a GSTIN`, onClick: () => setView("business"), active: view === "business" },
    ...(showBilling
      ? [
          { label: "Billed", value: formatINR(billed, { compact: billed >= 1e5 }), hint: "Issued invoices, all time" },
          { label: "Outstanding", value: formatINR(outstanding, { compact: outstanding >= 1e5 }), hint: owing ? `${owing} customer${owing === 1 ? " owes" : "s owe"} money` : "Nothing owed", tone: (outstanding > 0 ? "warning" : "success") as Metric["tone"] }
        ]
      : [{ label: "Walk-in", value: count("walkin"), hint: "Counter customers" }])
  ];

  const exportRows = (list: Customer[], name: string) => {
    try {
      exportToCSV(formatCustomersForExport(list), `${name}_${localDate()}`);
      toast({ title: `Exported ${list.length} customer${list.length === 1 ? "" : "s"}` });
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  // A copy each time so the edit dialog (which opens on a new customer) reopens.
  const edit = (c: Customer) => setEditing({ ...c });

  const columns: Column<Customer>[] = [
    {
      id: "name",
      header: "Customer",
      cell: (c) => (
        <div className="flex items-center gap-2">
          <EntityCell avatar={c.name} title={c.name} subtitle={c.company || c.customerType} />
          {c.isBlacklisted && (
            <StatusPill tone="danger" className="shrink-0">
              Blacklisted
            </StatusPill>
          )}
        </div>
      ),
      sortValue: (c) => c.name.toLowerCase(),
      className: "min-w-[220px]"
    },
    {
      id: "contact",
      header: "Contact",
      cell: (c) => <Stack top={c.phone || <span className="text-muted-foreground">—</span>} bottom={c.email} />,
      hideBelow: "lg"
    },
    {
      id: "type",
      header: "Type",
      cell: (c) => (
        <div className="flex flex-wrap items-center gap-1">
          <span>{c.customerType || "Individual"}</span>
          {(c.tags || []).slice(0, 2).map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      ),
      sortValue: (c) => c.customerType,
      hideBelow: "md"
    },
    {
      id: "gst",
      header: "GSTIN",
      cell: (c) =>
        c.gstNumber ? (
          <span className="inline-flex items-center gap-1 font-mono text-xs">
            {c.gstNumber}
            {c.gstVerified && <BadgeCheck className="h-3.5 w-3.5 text-success-strong" aria-label="Verified" />}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      hideBelow: "xl"
    },
    ...(showBilling
      ? ([
          {
            id: "billed",
            header: "Billed",
            align: "right",
            cell: (c) => (
              <Stack
                top={c.billing ? formatINR(c.billing.invoiced) : <span className="text-muted-foreground">—</span>}
                bottom={c.billing ? `${c.billing.invoices} invoice${c.billing.invoices === 1 ? "" : "s"}` : undefined}
              />
            ),
            sortValue: (c) => c.billing?.invoiced || 0,
            hideBelow: "lg"
          },
          {
            id: "due",
            header: "Outstanding",
            align: "right",
            cell: (c) =>
              (c.billing?.outstanding || 0) > 0.5 ? (
                <span className="font-semibold text-warning-strong">{formatINR(c.billing!.outstanding)}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
            sortValue: (c) => c.billing?.outstanding || 0
          }
        ] as Column<Customer>[])
      : []),
    {
      id: "status",
      header: "Status",
      cell: (c) => (
        <StatusPill tone={c.status === "active" ? "success" : c.status === "blacklisted" ? "danger" : "neutral"}>
          {c.status === "active" ? "Active" : c.status === "blacklisted" ? "Blacklisted" : "Inactive"}
        </StatusPill>
      ),
      sortValue: (c) => c.status,
      className: "w-[110px]"
    }
  ];

  const filtered = !!search || gst !== "all" || tag !== "all";

  return (
    <PageShell>
      <PageHeader
        eyebrow="Sales & estimating"
        title="Customers"
        description="Print buyers, agencies and walk-in customers, with what they've been billed and still owe."
        actions={
          <>
            {canExport && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Download />
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Export to CSV</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => exportRows(rows, "customers")} disabled={rows.length === 0}>
                    <Download />
                    This view ({rows.length})
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportRows(customers, "all_customers")} disabled={customers.length === 0}>
                    <FileText />
                    All customers ({customers.length})
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && (
              <Button onClick={() => setShowCreate(true)}>
                <Plus />
                Add customer
              </Button>
            )}
          </>
        }
      />

      <MetricBar metrics={metrics} loading={loading} />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All", count: customers.length },
            { value: "business", label: "Businesses", count: count("business") },
            { value: "individual", label: "Individuals", count: count("individual") },
            { value: "walkin", label: "Walk-in", count: count("walkin") },
            { value: "inactive", label: "Inactive", count: count("inactive") }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search name, phone, company or GSTIN" />}>
              <FilterSelect
                label="GST"
                value={gst}
                onChange={setGst}
                options={[
                  { value: "verified", label: "Verified GSTIN" },
                  { value: "unverified", label: "Unverified GSTIN" },
                  { value: "none", label: "No GSTIN" }
                ]}
              />
              {allTags.length > 0 && <FilterSelect label="Tag" value={tag} onChange={setTag} options={allTags.map((t) => ({ value: t, label: t }))} />}
            </Toolbar>
          }
          footer={!loading && rows.length > 0 && `${rows.length} of ${customers.length} customers`}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            loading={loading}
            onRowClick={canEdit ? edit : undefined}
            actions={(c) => [
              { label: "Edit customer", icon: Pencil, onClick: () => edit(c), hidden: !canEdit },
              { label: "New job ticket", icon: Briefcase, onClick: () => setJobFor(c), hidden: !canCreateJob }
            ]}
            actionsLabel={(c) => `Actions for ${c.name}`}
            defaultSort={{ id: "name", dir: "asc" }}
            mobile={(c) => (
              <div className="flex items-start justify-between gap-3">
                <EntityCell avatar={c.name} title={c.name} subtitle={c.company || c.phone || c.customerType} />
                <div className="shrink-0 text-right text-sm">
                  {(c.billing?.outstanding || 0) > 0.5 ? (
                    <>
                      <div className="num font-semibold text-warning-strong">{formatINR(c.billing!.outstanding)}</div>
                      <div className="text-xs text-muted-foreground">due</div>
                    </>
                  ) : (
                    <StatusPill tone={c.status === "active" ? "success" : "neutral"}>{c.status === "active" ? "Active" : "Inactive"}</StatusPill>
                  )}
                </div>
              </div>
            )}
            rowClassName={(c) => (c.status !== "active" ? "text-muted-foreground" : undefined)}
            empty={
              customers.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No customers yet"
                  description="Add the print buyers you work with to raise quotes, job tickets and invoices for them."
                  action={
                    canEdit && (
                      <Button onClick={() => setShowCreate(true)}>
                        <Plus />
                        Add customer
                      </Button>
                    )
                  }
                />
              ) : (
                <EmptyState
                  compact
                  icon={filtered ? AlertTriangle : Users}
                  title="No customers in this view"
                  description={filtered ? "Try another search or filter." : undefined}
                  action={
                    filtered && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSearch("");
                          setGst("all");
                          setTag("all");
                        }}
                      >
                        Clear filters
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </DataCard>
      </div>

      <CreateCustomerDialog open={showCreate} onOpenChange={setShowCreate} onCustomerCreated={load} />
      <EditCustomerDialog customer={editing as never} onCustomerUpdated={load} onCustomerDeleted={load} />
      <CreateJobDialog
        open={!!jobFor}
        onOpenChange={(o) => !o && setJobFor(null)}
        onJobCreated={() => {
          toast({ title: "Job ticket created", description: jobFor ? `For ${jobFor.name}` : undefined });
          setJobFor(null);
          navigate("/jobs");
        }}
        customers={customers}
        preselectedCustomer={jobFor}
      />
    </PageShell>
  );
}
