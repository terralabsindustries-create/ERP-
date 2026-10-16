import { useCallback, useEffect, useMemo, useState } from "react";
import { endOfMonth, format, startOfMonth, startOfYear, subMonths } from "date-fns";
import { Briefcase, Download, Loader2, Pencil, Plus, ReceiptIndianRupee, Trash2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { EditorSheet } from "@/components/users/EditorSheet";
import { ConfirmDialog, DataCard, DataTable, FilterSelect, MetricBar, Pagination, SearchField, Stack, StatusPill, Tag, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, humanize, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

const CATEGORIES = ["Materials", "Labor", "Overhead", "Equipment", "Transport", "Other"] as const;
type Category = (typeof CATEGORIES)[number];
const CATEGORY_LABEL: Record<Category, string> = { Materials: "Materials", Labor: "Labour", Overhead: "Overheads", Equipment: "Machine & equipment", Transport: "Transport", Other: "Other" };
const UNITS = ["pieces", "sheets", "reams", "boxes", "rolls", "kg", "grams", "meters", "sqft", "sqm", "liters", "hours", "days"];

interface CostEntry {
  _id: string;
  jobId?: { _id: string; title: string; status?: string } | string | null;
  jobTitle: string;
  category: Category;
  description: string;
  amount: number;
  quantity?: number;
  unit?: string;
  date?: string;
  createdAt: string;
  vendorId?: string | null;
  vendorName?: string;
  invoiceNumber?: string;
  notes?: string;
}

interface JobProfit {
  jobId: string;
  title: string;
  status?: string;
  customerName: string;
  revenue: number;
  invoices: number;
  cost: number;
  costEntries: number;
  byCategory: Partial<Record<Category, number>>;
  profit: number;
  margin: number | null;
}

interface Stats {
  revenue: number;
  invoices: number;
  totalCost: number;
  costEntries: number;
  profit: number;
  margin: number | null;
  byCategory: { _id: Category; total: number; count: number }[];
}

type View = "jobs" | "costs";
type Period = "month" | "last3" | "year" | "all";
const PAGE = 25;

const periodRange = (p: Period): { from?: string; to?: string; label: string } => {
  const now = new Date();
  const ymd = (d: Date) => format(d, "yyyy-MM-dd");
  if (p === "month") return { from: ymd(startOfMonth(now)), to: ymd(endOfMonth(now)), label: format(now, "MMMM yyyy") };
  if (p === "last3") return { from: ymd(startOfMonth(subMonths(now, 2))), to: ymd(endOfMonth(now)), label: "the last 3 months" };
  if (p === "year") return { from: ymd(startOfYear(now)), to: ymd(now), label: String(now.getFullYear()) };
  return { label: "all time" };
};

const marginTone = (m: number | null): PillTone => (m === null ? "neutral" : m < 0 ? "danger" : m < 15 ? "warning" : "success");
const amt = (n: number) => formatINR(n, { compact: Math.abs(n) >= 1e5 });
const jobIdOf = (c: CostEntry) => (c.jobId && typeof c.jobId === "object" ? c.jobId._id : (c.jobId as string | undefined));

const EMPTY_FORM = { jobId: "", category: "Materials" as Category, description: "", amount: "", quantity: "", unit: "pieces", date: format(new Date(), "yyyy-MM-dd"), vendorId: "", invoiceNumber: "", notes: "" };

export default function Costs() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Cost & Profit");
  const canExport = hasPermission("Cost & Profit: Export");

  const [view, setView] = useState<View>("jobs");
  const [period, setPeriod] = useState<Period>("month");
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<JobProfit[]>([]);
  const [costs, setCosts] = useState<CostEntry[]>([]);
  const [costTotal, setCostTotal] = useState(0);
  const [costSum, setCostSum] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [category, setCategory] = useState("all");
  const [jobFilter, setJobFilter] = useState<JobProfit | null>(null);
  const [page, setPage] = useState(1);

  const [editor, setEditor] = useState<{ open: boolean; cost: CostEntry | null }>({ open: false, cost: null });
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<CostEntry | null>(null);
  const [jobOptions, setJobOptions] = useState<{ _id: string; title: string; customerName?: string }[]>([]);
  const [vendors, setVendors] = useState<{ _id: string; name: string }[]>([]);

  const range = periodRange(period);

  const loadStats = useCallback(async () => {
    try {
      const res = (await apiClient.get("/costs/stats/summary", { from: range.from, to: range.to })) as { stats?: Stats };
      setStats(res?.stats || null);
    } catch {
      setStats(null);
    }
  }, [range.from, range.to]);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await apiClient.get("/costs/jobs", { from: range.from, to: range.to, search: q })) as { jobs?: JobProfit[] };
      setJobs(res?.jobs || []);
    } catch (error) {
      toast({ title: "Job profit could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, q, toast]);

  const loadCosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await apiClient.get("/costs", {
        from: range.from,
        to: range.to,
        search: q,
        category: category !== "all" ? category : undefined,
        jobId: jobFilter?.jobId,
        page,
        limit: PAGE
      })) as { costs?: CostEntry[]; totalAmount?: number; pagination?: { total?: number } };
      setCosts(res?.costs || []);
      setCostTotal(res?.pagination?.total || 0);
      setCostSum(res?.totalAmount || 0);
    } catch (error) {
      toast({ title: "Costs could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, q, category, jobFilter, page, toast]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => {
    if (view === "jobs") loadJobs();
    else loadCosts();
  }, [view, loadJobs, loadCosts]);
  useEffect(() => setPage(1), [q, category, jobFilter, period]);

  const refresh = () => {
    loadStats();
    if (view === "jobs") loadJobs();
    else loadCosts();
  };

  // Pickers are loaded when the editor first opens.
  const openEditor = async (cost: CostEntry | null, presetJob?: string) => {
    setForm(
      cost
        ? {
            jobId: jobIdOf(cost) || "",
            category: cost.category,
            description: cost.description,
            amount: String(cost.amount),
            quantity: cost.quantity ? String(cost.quantity) : "",
            unit: cost.unit || "pieces",
            date: format(new Date(cost.date || cost.createdAt), "yyyy-MM-dd"),
            vendorId: cost.vendorId ? String(cost.vendorId) : "",
            invoiceNumber: cost.invoiceNumber || "",
            notes: cost.notes || ""
          }
        : { ...EMPTY_FORM, jobId: presetJob || "" }
    );
    setEditor({ open: true, cost });
    if (!jobOptions.length) {
      try {
        const all = await apiClient.listAll<{ _id: string; title: string; customerId?: { name?: string } | string }>("/jobs", "jobs");
        setJobOptions(all.map((j) => ({ _id: j._id, title: j.title, customerName: typeof j.customerId === "object" ? j.customerId?.name : undefined })));
      } catch {
        setJobOptions([]);
      }
    }
    if (!vendors.length) {
      apiClient
        .listAll<{ _id: string; name: string }>("/vendors", "vendors")
        .then(setVendors)
        .catch(() => setVendors([]));
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.jobId || !form.description.trim() || !(Number(form.amount) > 0)) {
      toast({ title: "Choose a job, describe the cost and enter the amount", variant: "destructive" });
      return;
    }
    setSaving(true);
    const payload = {
      jobId: form.jobId,
      category: form.category,
      description: form.description.trim(),
      amount: Number(form.amount),
      quantity: form.quantity ? Number(form.quantity) : undefined,
      unit: form.quantity ? form.unit : undefined,
      date: form.date,
      vendorId: form.vendorId || (editor.cost ? "" : undefined),
      invoiceNumber: form.invoiceNumber,
      notes: form.notes
    };
    try {
      if (editor.cost) await apiClient.updateCost(editor.cost._id, payload);
      else await apiClient.createCost(payload);
      toast({ title: editor.cost ? "Cost updated" : "Cost added", description: `${formatINR(payload.amount)} · ${payload.description}` });
      setEditor({ open: false, cost: null });
      refresh();
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteCost(deleting._id);
      toast({ title: "Cost deleted" });
      setDeleting(null);
      refresh();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows =
      view === "jobs"
        ? [
            ["Job", "Customer", "Revenue (excl. GST)", "Costs", ...CATEGORIES.map((c) => CATEGORY_LABEL[c]), "Profit", "Margin %"].join(","),
            ...jobs.map((j) => [j.title, j.customerName, j.revenue, j.cost, ...CATEGORIES.map((c) => j.byCategory[c] || 0), j.profit, j.margin === null ? "" : j.margin.toFixed(1)].map(esc).join(","))
          ]
        : [
            ["Date", "Job", "Category", "Description", "Quantity", "Unit", "Amount", "Supplier", "Bill no."].join(","),
            ...costs.map((c) => [fmtDate(c.date || c.createdAt), c.jobTitle, CATEGORY_LABEL[c.category], c.description, c.quantity || "", c.quantity ? c.unit : "", c.amount, c.vendorName, c.invoiceNumber].map(esc).join(","))
          ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    a.download = `${view === "jobs" ? "job_profit" : "job_costs"}_${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const lossMaking = jobs.filter((j) => j.profit < 0).length;

  const jobColumns: Column<JobProfit>[] = [
    { id: "job", header: "Job", cell: (j) => <Stack top={<span className="font-medium">{j.title}</span>} bottom={j.customerName} />, sortValue: (j) => j.title.toLowerCase(), className: "min-w-[220px]" },
    { id: "revenue", header: "Billed", align: "right", cell: (j) => (j.revenue ? formatINR(j.revenue) : <span className="text-muted-foreground">Not billed</span>), sortValue: (j) => j.revenue },
    {
      id: "cost",
      header: "Costs",
      align: "right",
      cell: (j) => (j.cost ? <Stack className="text-right" top={formatINR(j.cost)} bottom={plural(j.costEntries, "entry", "entries")} /> : <span className="text-muted-foreground">None recorded</span>),
      sortValue: (j) => j.cost
    },
    {
      id: "profit",
      header: "Profit",
      align: "right",
      cell: (j) => <span className={cn("font-semibold", j.profit < 0 ? "text-destructive-strong" : "text-success-strong")}>{j.profit < 0 ? "−" : ""}{formatINR(Math.abs(j.profit))}</span>,
      sortValue: (j) => j.profit
    },
    {
      id: "margin",
      header: "Margin",
      align: "right",
      cell: (j) => <StatusPill tone={marginTone(j.margin)}>{j.margin === null ? "No revenue" : `${j.margin.toFixed(1)}%`}</StatusPill>,
      sortValue: (j) => (j.margin === null ? -Infinity : j.margin),
      className: "w-[120px]"
    }
  ];

  const costColumns: Column<CostEntry>[] = [
    { id: "date", header: "Date", cell: (c) => <span className="whitespace-nowrap">{fmtDate(c.date || c.createdAt)}</span>, sortValue: (c) => c.date || c.createdAt, className: "w-[120px]" },
    { id: "what", header: "Cost", cell: (c) => <Stack top={<span className="font-medium">{c.description}</span>} bottom={c.jobTitle} />, className: "min-w-[240px]" },
    { id: "category", header: "Category", cell: (c) => <Tag>{CATEGORY_LABEL[c.category] || c.category}</Tag>, sortValue: (c) => c.category, hideBelow: "md" },
    {
      id: "supplier",
      header: "Supplier",
      cell: (c) => (c.vendorName ? <Stack top={c.vendorName} bottom={c.invoiceNumber ? `Bill ${c.invoiceNumber}` : undefined} /> : <span className="text-muted-foreground">—</span>),
      hideBelow: "lg"
    },
    { id: "qty", header: "Qty", align: "right", cell: (c) => (c.quantity ? `${c.quantity.toLocaleString("en-IN")} ${humanize(c.unit || "")}`.trim() : "—"), hideBelow: "xl" },
    { id: "amount", header: "Amount", align: "right", cell: (c) => <span className="font-semibold">{formatINR(c.amount)}</span>, sortValue: (c) => c.amount }
  ];

  const unitLabel = useMemo(() => (form.unit ? humanize(form.unit) : ""), [form.unit]);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Cost & profit"
        description="What each job really cost — paper, plates, labour, outside work — against what it was billed for."
        actions={
          <>
            {canExport && (
              <Button variant="outline" onClick={exportCsv} disabled={view === "jobs" ? !jobs.length : !costs.length}>
                <Download />
                Export
              </Button>
            )}
            {canEdit && (
              <Button onClick={() => openEditor(null, jobFilter?.jobId)}>
                <Plus />
                Add cost
              </Button>
            )}
          </>
        }
      />

      <MetricBar
        loading={!stats}
        metrics={[
          { label: "Billed (excl. GST)", value: amt(stats?.revenue || 0), hint: `${plural(stats?.invoices || 0, "invoice")} · ${range.label}` },
          { label: "Costs", value: amt(stats?.totalCost || 0), hint: plural(stats?.costEntries || 0, "entry", "entries"), onClick: () => setView("costs"), active: view === "costs" },
          { label: "Profit", value: `${(stats?.profit || 0) < 0 ? "−" : ""}${amt(Math.abs(stats?.profit || 0))}`, tone: (stats?.profit || 0) < 0 ? "danger" : "success" },
          {
            label: "Margin",
            value: stats?.margin === null || stats?.margin === undefined ? "—" : `${stats.margin.toFixed(1)}%`,
            hint: lossMaking ? `${plural(lossMaking, "job")} at a loss` : "No loss-making jobs",
            tone: stats?.margin !== null && stats?.margin !== undefined && stats.margin < 0 ? "danger" : "default"
          }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={(v) => {
            setView(v);
            if (v === "jobs") setJobFilter(null);
          }}
          tabs={[
            { value: "jobs", label: "Profit by job", icon: TrendingUp, count: view === "jobs" ? jobs.length : undefined },
            { value: "costs", label: "All costs", icon: ReceiptIndianRupee, count: view === "costs" ? costTotal : undefined }
          ]}
        />

        <DataCard
          toolbar={
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder={view === "jobs" ? "Search job or customer" : "Search cost, job, supplier or bill no."} />}>
              <FilterSelect
                label="Period"
                value={period}
                onChange={(v) => setPeriod(v as Period)}
                allLabel="All time"
                options={[
                  { value: "month", label: "This month" },
                  { value: "last3", label: "Last 3 months" },
                  { value: "year", label: "This year" }
                ]}
              />
              {view === "costs" && <FilterSelect label="Category" value={category} onChange={setCategory} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />}
              {view === "costs" && jobFilter && (
                <Button variant="outline" size="sm" onClick={() => setJobFilter(null)}>
                  Job: {jobFilter.title} ×
                </Button>
              )}
            </Toolbar>
          }
          footer={
            !loading &&
            (view === "jobs"
              ? jobs.length > 0 && (
                  <span>
                    {plural(jobs.length, "job")} · costs and invoices dated in {range.label}
                  </span>
                )
              : costTotal > 0 && (
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="num">Total in this view: {formatINR(costSum)}</span>
                    <Pagination page={page} pageSize={PAGE} total={costTotal} onPageChange={setPage} noun="costs" />
                  </div>
                ))
          }
        >
          {view === "jobs" ? (
            <DataTable
              columns={jobColumns}
              rows={jobs}
              rowKey={(j) => j.jobId}
              loading={loading}
              defaultSort={{ id: "profit", dir: "asc" }}
              onRowClick={(j) => {
                setJobFilter(j);
                setView("costs");
              }}
              actions={(j) => [
                {
                  label: "See costs",
                  icon: ReceiptIndianRupee,
                  onClick: () => {
                    setJobFilter(j);
                    setView("costs");
                  }
                },
                { label: "Add cost to this job", icon: Plus, onClick: () => openEditor(null, j.jobId), hidden: !canEdit }
              ]}
              actionsLabel={(j) => `Actions for ${j.title}`}
              mobile={(j) => (
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{j.title}</span>
                    <StatusPill tone={marginTone(j.margin)}>{j.margin === null ? "No revenue" : `${j.margin.toFixed(1)}%`}</StatusPill>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Billed {formatINR(j.revenue)} · costs {formatINR(j.cost)} ·{" "}
                    <span className={cn("font-medium", j.profit < 0 ? "text-destructive-strong" : "text-success-strong")}>
                      {j.profit < 0 ? "loss" : "profit"} {formatINR(Math.abs(j.profit))}
                    </span>
                  </div>
                </div>
              )}
              empty={
                <EmptyState
                  icon={Briefcase}
                  title={q ? "No jobs match" : `Nothing for ${range.label}`}
                  description={q ? undefined : "Jobs appear here once they have costs recorded or invoices raised in this period."}
                  action={
                    canEdit &&
                    !q && (
                      <Button onClick={() => openEditor(null)}>
                        <Plus />
                        Add cost
                      </Button>
                    )
                  }
                />
              }
            />
          ) : (
            <DataTable
              columns={costColumns}
              rows={costs}
              rowKey={(c) => c._id}
              loading={loading}
              onRowClick={canEdit ? (c) => openEditor(c) : undefined}
              actions={(c) => [
                { label: "Edit cost", icon: Pencil, onClick: () => openEditor(c), hidden: !canEdit },
                { label: "Delete cost", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting(c), hidden: !canEdit }
              ]}
              actionsLabel={(c) => `Actions for ${c.description}`}
              mobile={(c) => (
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">{c.description}</span>
                    <span className="num shrink-0 font-semibold">{formatINR(c.amount)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {fmtDate(c.date || c.createdAt)} · {CATEGORY_LABEL[c.category]} · {c.jobTitle}
                  </div>
                </div>
              )}
              empty={<EmptyState compact icon={ReceiptIndianRupee} title="No costs in this view" description="Try another period, category or search." />}
            />
          )}
        </DataCard>

        {stats && stats.byCategory.length > 0 && (
          <section className="rounded-xl border bg-card p-4 shadow-card sm:p-5" aria-label="Costs by category">
            <h2 className="text-sm font-semibold">Where the money went · {range.label}</h2>
            <div className="mt-3 space-y-2.5">
              {stats.byCategory.map((c) => {
                const pct = stats.totalCost ? (c.total / stats.totalCost) * 100 : 0;
                return (
                  <button
                    key={c._id}
                    type="button"
                    onClick={() => {
                      setCategory(c._id);
                      setView("costs");
                    }}
                    className="block w-full text-left"
                  >
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span>{CATEGORY_LABEL[c._id] || c._id}</span>
                      <span className="num text-muted-foreground">
                        <span className="font-medium text-foreground">{formatINR(c.total)}</span> · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>

      <EditorSheet
        open={editor.open}
        onOpenChange={(open) => setEditor((s) => ({ ...s, open }))}
        title={editor.cost ? "Edit cost" : "Add a job cost"}
        description="Record what a job used or paid for, so its profit is right."
        onSubmit={save}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setEditor({ open: false, cost: null })}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {editor.cost ? "Save changes" : "Add cost"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cost-job">Job</Label>
            <Select value={form.jobId} onValueChange={(v) => setForm({ ...form, jobId: v })}>
              <SelectTrigger id="cost-job">
                <SelectValue placeholder={jobOptions.length ? "Choose a job" : "Loading jobs…"} />
              </SelectTrigger>
              <SelectContent>
                {jobOptions.map((j) => (
                  <SelectItem key={j._id} value={j._id}>
                    {j.title}
                    {j.customerName ? ` · ${j.customerName}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cost-category">Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as Category })}>
                <SelectTrigger id="cost-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-date">Date</Label>
              <Input id="cost-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cost-desc">What was it for</Label>
            <Input id="cost-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Maplitho 70gsm, 2 reams" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cost-qty">Quantity</Label>
              <Input id="cost-qty" type="number" inputMode="decimal" min="0" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-unit">Unit</Label>
              <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
                <SelectTrigger id="cost-unit">
                  <SelectValue>{unitLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {humanize(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-amount">Amount (₹)</Label>
              <Input id="cost-amount" type="number" inputMode="decimal" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
          </div>
          {Number(form.quantity) > 0 && Number(form.amount) > 0 && (
            <p className="text-xs text-muted-foreground">
              {formatINR(Number(form.amount) / Number(form.quantity))} per {humanize(form.unit).toLowerCase().replace(/s$/, "")}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cost-vendor">Supplier</Label>
              <Select value={form.vendorId || "none"} onValueChange={(v) => setForm({ ...form, vendorId: v === "none" ? "" : v })}>
                <SelectTrigger id="cost-vendor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No supplier</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v._id} value={v._id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost-bill">Supplier bill no.</Label>
              <Input id="cost-bill" value={form.invoiceNumber} onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cost-notes">Notes</Label>
            <Textarea id="cost-notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" />
          </div>
        </div>
      </EditorSheet>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this cost?"
        description={deleting ? `${formatINR(deleting.amount)} · ${deleting.description} (${deleting.jobTitle}). The job's profit is worked out again.` : undefined}
        onConfirm={remove}
      />
    </PageShell>
  );
}
