import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, Eye, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, FilterSelect, MetricBar, Pagination, SearchField, Toolbar, type Column } from "@/components/data";
import { METHOD_LABELS } from "@/components/payments/paymentMeta";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { istToday, paymentAccountsApi, type CollectionList, type CollectionListParams, type CollectionRow } from "@/lib/api/paymentAccounts";
import { fmtDateTime, formatINR, plural } from "@/lib/format";

/*
  Every payment collected in a period: the receipts behind the dashboard's
  "Payment collection" figures (GET /api/payment-accounts/collections), with
  filters for period, account or account type, method and a search. The
  filters live in the URL, so the dashboard's "View all" opens the same day
  and account, and the browser's Back keeps them.
*/
const PAGE_SIZE = 50;

const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const RANGES: { value: string; label: string; range: () => [string, string] }[] = [
  { value: "today", label: "Today", range: () => [istToday(), istToday()] },
  { value: "yesterday", label: "Yesterday", range: () => [shift(istToday(), -1), shift(istToday(), -1)] },
  { value: "7d", label: "Last 7 days", range: () => [shift(istToday(), -6), istToday()] },
  { value: "month", label: "This month", range: () => [`${istToday().slice(0, 8)}01`, istToday()] },
  { value: "30d", label: "Last 30 days", range: () => [shift(istToday(), -29), istToday()] }
];
const KIND_OPTIONS = [
  { value: "kind:cash", label: "All cash" },
  { value: "kind:wallet", label: "All Paytm / UPI wallets" },
  { value: "kind:bank", label: "All bank accounts" }
];
const SORTS = [
  { value: "-date", label: "Newest first" },
  { value: "date", label: "Oldest first" },
  { value: "-amount", label: "Largest first" },
  { value: "amount", label: "Smallest first" }
];
const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default function PaymentCollections() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const from = isDay(params.get("from")) ? params.get("from")! : istToday();
  const to = isDay(params.get("to")) && params.get("to")! >= from ? params.get("to")! : from;
  const into = params.get("into") || "all"; // "all" | "kind:<kind>" | "acc:<id>" | "unassigned"
  const method = params.get("method") || "all";
  const sort = (params.get("sort") || "-date") as NonNullable<CollectionListParams["sort"]>;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [search, setSearch] = useState(params.get("q") || "");
  const q = useDebounced(search.trim(), 300);

  // Any filter change goes back to page 1.
  const update = useCallback((changes: Record<string, string | null>, keepPage = false) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === "" || v === "all") next.delete(k);
        else next.set(k, v);
      }
      if (!keepPage) next.delete("page");
      return next;
    }, { replace: true });
  }, [setParams]);
  useEffect(() => {
    if ((params.get("q") || "") !== q) update({ q });
  }, [q, params, update]);

  const [data, setData] = useState<CollectionList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo<CollectionListParams>(() => ({
    from,
    to,
    accountId: into === "unassigned" ? "unassigned" : into.startsWith("acc:") ? into.slice(4) : undefined,
    kind: into.startsWith("kind:") ? (into.slice(5) as CollectionListParams["kind"]) : undefined,
    paymentMethod: method === "all" ? undefined : method,
    search: params.get("q") || undefined,
    sort,
    page,
    limit: PAGE_SIZE
  }), [from, to, into, method, sort, page, params]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await paymentAccountsApi.collections(query));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { page: _p, limit: _l, ...rest } = query;
      const qs = new URLSearchParams(Object.entries({ ...rest, format: "csv" }).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();
      await apiClient.downloadExport(`/payment-accounts/collections?${qs}`, `payment-collections_${from}_to_${to}.csv`);
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const previewReceipt = async (r: CollectionRow) => {
    if (!r.payment) return;
    const tab = window.open("", "_blank");
    try {
      const file = await apiClient.getPaymentReceiptPdfFile(r.payment._id, r.payment.paymentId);
      const url = URL.createObjectURL(file.blob);
      if (tab) tab.location.href = url; else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      toast({ title: "Could not get the receipt", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const rangeValue = RANGES.find((r) => { const [f, t] = r.range(); return f === from && t === to; })?.value || "custom";
  const accountOptions = [
    ...KIND_OPTIONS,
    ...(data?.accounts || []).map((a) => ({ value: `acc:${a._id}`, label: `${a.nickname}${a.isActive ? "" : " (inactive)"} · ${a.kindLabel}` })),
    { value: "unassigned", label: "Not in an account" }
  ];
  const period = from === to ? (from === istToday() ? "today" : `on ${fmtDay(from)}`) : `${fmtDay(from)} – ${fmtDay(to)}`;
  const filtered = into !== "all" || method !== "all" || !!params.get("q");
  const rows = data?.rows || [];
  const total = data?.pagination.total || 0;

  const columns: Column<CollectionRow>[] = [
    { id: "date", header: "Received", cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.date)}</span>, className: "w-[170px]" },
    {
      id: "customer",
      header: "Customer",
      cell: (r) => <EntityCell avatar={r.payment?.customerName || "?"} title={r.payment?.customerName || "—"} subtitle={<span className="font-mono">{r.payment?.paymentId || "—"}</span>} />,
      className: "min-w-[200px]"
    },
    {
      id: "invoices",
      header: "Invoices",
      cell: (r) => (r.payment?.invoices.length ? <span className="font-mono text-[13px]">{r.payment.invoices.join(", ")}</span> : <span className="text-muted-foreground">On account</span>),
      hideBelow: "md"
    },
    { id: "method", header: "Method", cell: (r) => (r.method ? METHOD_LABELS[r.method] || r.method : "—"), hideBelow: "lg" },
    {
      id: "account",
      header: "Received into",
      cell: (r) => (r.account ? <span>{r.account.nickname} <span className="text-xs text-muted-foreground">{r.account.kindLabel}</span></span> : <span className="text-muted-foreground">Not in an account</span>),
      hideBelow: "md"
    },
    { id: "ref", header: "Reference", cell: (r) => <span className="block max-w-[160px] truncate text-muted-foreground">{r.payment?.reference || "—"}</span>, hideBelow: "xl" },
    { id: "amount", header: "Amount", align: "right", cell: (r) => <span className="font-semibold">{formatINR(r.amount)}</span> }
  ];

  const methods = (data?.byMethod || []).slice(0, 3);
  return (
    <PageShell>
      <PageHeader
        eyebrow={<Link to="/" className="inline-flex items-center gap-1 hover:text-foreground"><ArrowLeft className="h-3 w-3" />Dashboard</Link>}
        title="Payment collection"
        description="Every payment received, by when it was received (India time). The same figures as the dashboard's collection."
        actions={
          <Button variant="outline" onClick={exportCsv} loading={exporting} disabled={!total}>
            <Download />
            Export CSV
          </Button>
        }
      />

      <MetricBar
        loading={!data && loading}
        metrics={[
          { label: `Collected ${period}`, value: formatINR(data?.totals.amount || 0), hint: plural(data?.totals.count || 0, "payment"), tone: "success" },
          ...methods.map((m) => ({
            label: METHOD_LABELS[m.method] || m.method || "Other",
            value: formatINR(m.amount),
            hint: plural(m.count, "payment"),
            onClick: () => update({ method: method === m.method ? null : m.method }),
            active: method === m.method
          }))
        ]}
      />

      <DataCard
        toolbar={
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <FilterSelect label="Period" value={rangeValue === "today" ? "all" : rangeValue} allLabel="Today" onChange={(v) => {
                const r = RANGES.find((x) => x.value === v) || RANGES[0]; // "all" is Today
                const [f, t] = r.range();
                update({ from: f, to: t });
              }} options={[...RANGES.slice(1).map(({ value, label }) => ({ value, label })), ...(rangeValue === "custom" ? [{ value: "custom", label: "Custom" }] : [])]} />
              <div className="flex items-end gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor="pc-from" className="text-xs text-muted-foreground">From</Label>
                  <Input id="pc-from" type="date" value={from} max={istToday()} onChange={(e) => e.target.value && update({ from: e.target.value, to: e.target.value > to ? e.target.value : to })} className="h-9 w-[150px]" />
                </div>
                <span className="pb-2 text-muted-foreground">–</span>
                <div className="space-y-1">
                  <Label htmlFor="pc-to" className="text-xs text-muted-foreground">To</Label>
                  <Input id="pc-to" type="date" value={to} min={from} max={istToday()} onChange={(e) => e.target.value && update({ to: e.target.value })} className="h-9 w-[150px]" />
                </div>
              </div>
            </div>
            <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search customer, invoice, payment no. or reference" />}>
              <FilterSelect label="Received into" value={into} onChange={(v) => update({ into: v })} options={accountOptions} allLabel="All accounts" />
              <FilterSelect label="Method" value={method} onChange={(v) => update({ method: v })} options={Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
              <FilterSelect label="Sort" value={sort === "-date" ? "all" : sort} allLabel="Newest first" onChange={(v) => update({ sort: v === "all" ? null : v })} options={SORTS.slice(1)} />
            </Toolbar>
          </div>
        }
        footer={!loading && total > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={(p) => update({ page: String(p) }, true)} noun="payments" />}
      >
        <DataTable
          error={error}
          onRetry={load}
          columns={columns}
          rows={rows}
          rowKey={(r) => r._id}
          loading={loading}
          actions={(r) => [{ label: "Preview receipt", icon: Eye, onClick: () => previewReceipt(r), hidden: !r.payment }]}
          actionsLabel={(r) => `Actions for ${r.payment?.paymentId || "payment"}`}
          mobile={(r) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{r.payment?.customerName || "—"}</span>
                <span className="num font-semibold">{formatINR(r.amount)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {fmtDateTime(r.date)} · {r.method ? METHOD_LABELS[r.method] || r.method : "—"} · {r.account?.nickname || "Not in an account"}
                {r.payment?.invoices.length ? ` · ${r.payment.invoices.join(", ")}` : ""}
              </div>
            </div>
          )}
          empty={
            <EmptyState
              compact
              icon={Wallet}
              title={filtered ? "No payments match these filters" : `No payments collected ${period}`}
              description={filtered ? "Try another account, method or search." : "Pick another day or a longer period."}
            />
          }
        />
      </DataCard>
    </PageShell>
  );
}

function fmtDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
