import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataCard, DataTable, FilterSelect, MetricBar, StatusPill, type Column } from "@/components/data";
import { formatINR } from "@/lib/format";
import { istToday, paymentAccountsApi, type ClosingRow, type CollectionSummary } from "@/lib/api/paymentAccounts";

const money = (n: number) => formatINR(n);
const compact = (n: number) => formatINR(n, { compact: Math.abs(n) >= 1e5 });

/**
 * Where payments were received, by account, for a day or a period:
 * - the headline: total collected, cash, wallet/UPI (Paytm…), bank;
 * - per account: opening balance, received, other money in, paid out,
 *   closing balance (opening + in − out) and the balance it holds now.
 * Collections are the period's receipts; balances are what the accounts hold.
 *
 * `variant="dashboard"` shows the headline and a short per-account list;
 * `variant="report"` is the full daily closing report.
 */
export function PaymentCollectionPanel({ variant = "report" }: { variant?: "dashboard" | "report" }) {
  const [from, setFrom] = useState(istToday());
  const [to, setTo] = useState(istToday());
  const [accountId, setAccountId] = useState("all");
  const [data, setData] = useState<CollectionSummary | null>(null);
  const [accountOptions, setAccountOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const summary = await paymentAccountsApi.summary({ from, to: variant === "dashboard" ? from : to, accountId: accountId === "all" ? undefined : accountId });
      setData(summary);
      if (accountId === "all") setAccountOptions(summary.accounts.map((a) => ({ value: a._id, label: a.isActive ? a.nickname : `${a.nickname} (inactive)` })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The collection summary could not be loaded");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, accountId, variant]);

  useEffect(() => {
    load();
  }, [load]);

  const period = variant === "dashboard" || from === to ? (from === istToday() ? "today" : `on ${from}`) : `${from} to ${to}`;
  const t = data?.totals;
  const banks = data?.accounts.filter((a) => a.kind === "bank") || [];

  const filters = (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={`${variant}-from`} className="text-xs text-muted-foreground">
          {variant === "dashboard" ? "Day" : "From"}
        </Label>
        <Input id={`${variant}-from`} type="date" value={from} max={istToday()} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 w-[150px]" />
      </div>
      {variant === "report" && (
        <div className="space-y-1">
          <Label htmlFor="report-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input id="report-to" type="date" value={to} min={from} max={istToday()} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 w-[150px]" />
        </div>
      )}
      <FilterSelect label="Account" value={accountId} onChange={setAccountId} options={accountOptions} allLabel="All accounts" />
      <Button variant="ghost" size="sm" onClick={load} disabled={loading} aria-label="Refresh">
        <RefreshCw className={loading ? "animate-spin" : undefined} />
      </Button>
    </div>
  );

  const metrics = [
    { label: `Collected ${period}`, value: compact(t?.collected || 0), hint: data?.unassigned.received ? `${money(data.unassigned.received)} not in an account` : `${data?.accounts.reduce((n, a) => n + a.receivedCount, 0) || 0} payments` },
    { label: "Cash", value: compact(data?.byKind.cash.received || 0), hint: `Balance ${compact(data?.byKind.cash.currentBalance || 0)}` },
    { label: "Paytm / UPI wallets", value: compact(data?.byKind.wallet.received || 0), hint: `Balance ${compact(data?.byKind.wallet.currentBalance || 0)}` },
    { label: "Bank accounts", value: compact(data?.byKind.bank.received || 0), hint: `Balance ${compact(data?.byKind.bank.currentBalance || 0)}` },
    { label: "Total balance now", value: compact(t?.currentBalance || 0), hint: "Across all accounts", tone: (t?.currentBalance || 0) < 0 ? ("danger" as const) : ("default" as const) }
  ];

  const columns: Column<ClosingRow>[] = [
    {
      id: "account",
      header: "Account",
      cell: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{r.nickname}</span>
          <span className="text-xs text-muted-foreground">{r.kindLabel}</span>
          {!r.isActive && <StatusPill>Inactive</StatusPill>}
        </div>
      ),
      sortValue: (r) => r.nickname
    },
    { id: "opening", header: "Opening", align: "right", cell: (r) => money(r.opening), sortValue: (r) => r.opening, hideBelow: variant === "dashboard" ? "lg" : undefined },
    { id: "received", header: "Received", align: "right", cell: (r) => <span className={r.received ? "font-semibold text-success-strong" : undefined}>{money(r.received)}</span>, sortValue: (r) => r.received },
    ...(variant === "report"
      ? [{ id: "otherIn", header: "Other in", align: "right" as const, cell: (r: ClosingRow) => money(r.otherIn), sortValue: (r: ClosingRow) => r.otherIn, hideBelow: "md" as const }]
      : []),
    { id: "paidOut", header: "Paid out", align: "right", cell: (r) => <span className={r.paidOut ? "text-destructive-strong" : undefined}>{money(r.paidOut)}</span>, sortValue: (r) => r.paidOut, hideBelow: variant === "dashboard" ? "lg" : undefined },
    { id: "closing", header: "Closing", align: "right", cell: (r) => <span className="font-semibold">{money(r.closing)}</span>, sortValue: (r) => r.closing },
    ...(variant === "report"
      ? [{ id: "now", header: "Balance now", align: "right" as const, cell: (r: ClosingRow) => money(r.currentBalance), sortValue: (r: ClosingRow) => r.currentBalance, hideBelow: "md" as const }]
      : [])
  ];

  return (
    <div className="space-y-3" data-testid={`collection-${variant}`}>
      <MetricBar loading={loading && !data} metrics={metrics} />
      <DataCard
        toolbar={filters}
        footer={
          data && (
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Closing = opening + received + other in − paid out. Pending, failed and cancelled payments are not counted; a refund is paid out on the day it is refunded.
              </span>
              <span className="num font-medium text-foreground">
                {money(t!.opening)} + {money(t!.received + t!.otherIn)} − {money(t!.paidOut)} = {money(t!.closing)}
              </span>
            </div>
          )
        }
      >
        {error ? (
          <p role="alert" className="px-4 py-6 text-sm text-destructive-strong">
            {error}
          </p>
        ) : (
          <DataTable
            columns={columns}
            rows={data?.accounts || []}
            rowKey={(r) => r._id}
            loading={loading && !data}
            empty={<p className="px-4 py-6 text-sm text-muted-foreground">No payment accounts yet. Add Cash, Paytm and your bank accounts under Accounts → Payment accounts.</p>}
            mobile={(r) => (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{r.nickname}</span>
                  <span className="num font-semibold">{money(r.closing)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Opening {money(r.opening)} · in {money(r.received + r.otherIn)} · out {money(r.paidOut)}
                </div>
              </div>
            )}
          />
        )}
      </DataCard>
      {variant === "dashboard" && banks.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Bank-wise {period}: {banks.map((b) => `${b.nickname} ${money(b.received)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
