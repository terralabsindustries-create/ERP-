import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, BadgeCheck, Briefcase, Download, FileText, Pencil, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type Metric } from "@/components/data";
import { useLoader } from "@/hooks/useLoader";
import { useDebounced } from "@/hooks/useDebounced";
import { CreateCustomerDialog } from "@/components/customers/CreateCustomerDialog";
import { EditCustomerDialog } from "@/components/customers/EditCustomerDialog";
import { CreateJobDialog } from "@/components/jobs/CreateJobDialog";
import { StatementDialog } from "@/components/customers/StatementDialog";
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

type View = "all" | "agency" | "walkin" | "business" | "individual" | "inactive";

const isBusiness = (c: Customer) => c.customerType === "Business" || c.customerType === "Corporate";
const inView = (c: Customer, v: View) =>
  v === "all"
    ? true
    : v === "inactive"
      ? c.status !== "active"
      : c.status === "active" &&
        (v === "business"
          ? isBusiness(c)
          : v === "walkin"
            ? c.customerType === "Walk-in"
            : v === "agency"
              ? c.customerType === "Agency"
              : !isBusiness(c) && c.customerType !== "Walk-in" && c.customerType !== "Agency");

const PAGE_SIZE = 50;
const SORT_KEYS: Record<string, string> = { name: "name", type: "customerType", status: "status" };

interface Summary {
  counts: Record<View, number>;
  active: number;
  withGstin: number;
  tags: string[];
  billing: { invoiced: number; outstanding: number; owing: number } | null;
}

/** Every customer matching the filters, for exports (fetched a few pages at a time). */
const fetchMatching = (params: Record<string, string | undefined>) =>
  apiClient.listAll<Customer>("/customers", "customers", { status: "all", ...params }, 10000).then((all) => all.map((c) => ({ ...c, id: c.id || (c._id as string) })));

export default function Customers() {
  const { user, hasPermission } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("q") || "");
  // A search from the header while already on this page arrives as a new ?q.
  const qParam = searchParams.get("q");
  useEffect(() => {
    if (qParam !== null) setSearch(qParam);
  }, [qParam]);
  const [view, setView] = useState<View>("all");
  const [gst, setGst] = useState("all");
  const [tag, setTag] = useState("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ id: string; dir: "asc" | "desc" } | null>({ id: "name", dir: "asc" });
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [jobFor, setJobFor] = useState<Customer | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statementFor, setStatementFor] = useState<Customer | null>(null);
  const canStatement = hasPermission("Invoicing") || hasPermission("Payments") || hasPermission("Accounts");
  const [bulkBusy, setBulkBusy] = useState(false);

  const canEdit = hasPermission("Customers: Create & Edit");
  const canCreateJob = hasPermission("Jobs: Create & Edit");
  const canExport = hasPermission("Customers: Export");
  const q = useDebounced(search.trim(), 300);

  // Search, filters, sort and pages run on the server over every customer; a
  // newer request cancels the one in flight (useLoader), and a failed one keeps
  // the rows already shown under a "may be out of date" notice.
  const filters = useMemo(
    () => ({ view, gst: gst === "all" ? undefined : gst, tag: tag === "all" ? undefined : tag, search: q || undefined }),
    [view, gst, tag, q]
  );
  useEffect(() => { setPage(1); setSelected(new Set()); }, [filters]);
  const list = useLoader(
    (signal) =>
      apiClient.getWithSignal<{ customers: Customer[]; pagination: { totalCustomers: number } }>(
        "/customers",
        {
          status: "all",
          ...filters,
          page,
          limit: PAGE_SIZE,
          ...(sort && SORT_KEYS[sort.id] ? { sortBy: SORT_KEYS[sort.id], sortOrder: sort.dir } : {}),
        },
        signal
      ),
    [filters, page, sort],
    { enabled: !!user }
  );
  const summaryQ = useLoader((signal) => apiClient.getWithSignal<Summary>("/customers/stats/summary", undefined, signal), [], { enabled: !!user });
  const customers = useMemo(() => (list.data?.customers || []).map((c) => ({ ...c, id: c.id || (c._id as string) })), [list.data]);
  const total = list.data?.pagination?.totalCustomers ?? 0;
  const summary = summaryQ.data;
  const load = () => { list.reload(); summaryQ.reload(); };
  const loading = list.isLoading;
  const loadError = list.error;

  const showBilling = !!summary?.billing || hasPermission("Invoicing");
  const allTags = summary?.tags || [];
  const rows = customers;
  const count = (v: View) => summary?.counts?.[v] ?? 0;
  const billed = summary?.billing?.invoiced ?? 0;
  const outstanding = summary?.billing?.outstanding ?? 0;
  const owing = summary?.billing?.owing ?? 0;

  const metrics: Metric[] = [
    { label: "Customers", value: count("all"), hint: `${summary?.active ?? 0} active` },
    { label: "Businesses", value: count("business"), hint: `${summary?.withGstin ?? 0} with a GSTIN`, onClick: () => setView("business"), active: view === "business" },
    ...(showBilling
      ? [
          { label: "Billed", value: formatINR(billed, { compact: billed >= 1e5 }), hint: "Issued invoices, all time" },
          { label: "Outstanding", value: formatINR(outstanding, { compact: outstanding >= 1e5 }), hint: owing ? `${owing} customer${owing === 1 ? " owes" : "s owe"} money` : "Nothing owed", tone: (outstanding > 0 ? "warning" : "success") as Metric["tone"] }
        ]
      : [{ label: "Walk-in", value: count("walkin"), hint: "Counter customers" }])
  ];

  const exportMatching = async (all: boolean) => {
    try {
      const list = await fetchMatching(all ? {} : filters);
      exportRows(list, all ? "all_customers" : "customers");
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  // Bulk actions: each selected customer is checked by the server (business,
  // permission); the answer lists what succeeded and what did not, and why.
  const runBulk = async (action: "deactivate" | "reactivate") => {
    if (!selected.size || bulkBusy) return;
    setBulkBusy(true);
    try {
      const res = await apiClient.post<{ succeeded: string[]; failed: { id: string; reason: string }[] }>("/customers/bulk", { action, ids: [...selected] });
      toast({
        title: `${res.succeeded.length} customer${res.succeeded.length === 1 ? "" : "s"} ${action === "deactivate" ? "deactivated" : "reactivated"}`,
        description: res.failed.length ? `${res.failed.length} not changed: ${res.failed.slice(0, 3).map((f) => f.reason).join("; ")}` : undefined,
        variant: res.failed.length ? "destructive" : undefined
      });
      setSelected(new Set());
      load();
    } catch (error) {
      toast({ title: "Not changed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

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
                  <DropdownMenuItem onClick={() => exportMatching(false)} disabled={total === 0}>
                    <Download />
                    This view ({total})
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportMatching(true)} disabled={count("all") === 0}>
                    <FileText />
                    All customers ({count("all")})
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

      <MetricBar metrics={metrics} loading={summaryQ.isLoading || (!!summaryQ.error && !summary)} />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All", count: count("all") },
            { value: "walkin", label: "Walk-in", count: count("walkin") },
            { value: "agency", label: "Agencies", count: count("agency") },
            { value: "business", label: "Businesses", count: count("business") },
            { value: "individual", label: "Individuals", count: count("individual") },
            { value: "inactive", label: "Inactive", count: count("inactive") }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search name, phone, company or GSTIN" />}>
              {selected.size > 0 && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs" role="region" aria-label="Bulk actions">
                  <span className="font-medium">{selected.size} selected</span>
                  <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={() => exportRows(customers.filter((c) => selected.has(c.id)), "selected_customers")}>Export</Button>
                  <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={() => runBulk("deactivate")}>Deactivate</Button>
                  <Button size="sm" variant="outline" className="h-7" disabled={bulkBusy} onClick={() => runBulk("reactivate")}>Reactivate</Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())}>Clear</Button>
                </div>
              )}
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
          footer={!loading && total > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{total.toLocaleString("en-IN")} customer{total === 1 ? "" : "s"}{list.isRefreshing ? " · updating…" : ""}</span>
              <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="customers" />
            </div>
          )}
        >
          <DataTable
            error={loadError}
            errorWhat="customers"
            onRetry={() => list.reload()}
            sort={sort}
            onSortChange={(s) => { setSort(s); setPage(1); }}
            selectable={canEdit}
            selected={selected}
            onSelectedChange={setSelected}
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            loading={loading}
            onRowClick={canEdit ? edit : undefined}
            actions={(c) => [
              { label: "Edit customer", icon: Pencil, onClick: () => edit(c), hidden: !canEdit },
              { label: "New job ticket", icon: Briefcase, onClick: () => setJobFor(c), hidden: !canCreateJob },
              { label: "Statement of account", icon: FileText, onClick: () => setStatementFor(c), hidden: !canStatement }
            ]}
            actionsLabel={(c) => `Actions for ${c.name}`}
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
              count("all") === 0 && !filtered ? (
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

      <StatementDialog party={statementFor ? { id: statementFor.id, name: statementFor.name, kind: "customer" } : null} onOpenChange={(o) => !o && setStatementFor(null)} />
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
        preselectedCustomer={jobFor}
      />
    </PageShell>
  );
}
