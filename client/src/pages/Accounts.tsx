import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3, Landmark, Plus, Scale, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, FilterSelect, MetricBar, Pagination, SearchField, Stack, Tag, Toolbar, ViewTabs, type Column } from "@/components/data";
import { CreatePaymentDialog } from "@/components/payments/CreatePaymentDialog";
import { NewTransactionDialog } from "@/components/accounts/NewTransactionDialog";
import { AccountsReports } from "@/components/accounts/AccountsReports";
import { BankReconciliation } from "@/components/accounts/BankReconciliation";
import { PaymentAccountsView } from "@/components/payments/PaymentAccountsView";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { loadAccountsSummary, type Balances, type Loaded, type MonthTotals } from "@/lib/accountsSummary";

interface Txn {
  _id: string;
  transactionNumber?: string;
  transactionType: "income" | "expense" | "transfer" | "opening_balance" | "adjustment";
  category: string;
  amount: number;
  description: string;
  paymentMethod: string;
  accountType: string;
  accountName: string;
  reference?: string;
  createdAt: string;
  transactionDate?: string;
  transferDetails?: { toAccountType?: string; toAccount?: string };
}

type View = "all" | "income" | "expense" | "other" | "payment-accounts" | "reconciliation" | "reports";
const PAGE_SIZE = 25;
const METHOD: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card", upi: "UPI", wallet: "Wallet", other: "Other" };

// The non-income/expense types the "Balances & adjustments" tab lists.
const OTHER_TYPES = "transfer,opening_balance,adjustment";

/**
 * Money in and money out. A transfer is money out of its source and money in
 * to its destination, so it reads that way when one account is filtered;
 * across all accounts it moves nothing, like opening balances and adjustments.
 */
const direction = (t: Txn, account = "all") => {
  if (t.transactionType === "income") return "in";
  if (t.transactionType === "expense") return "out";
  if (t.transactionType === "transfer" && account !== "all") {
    const to = t.transferDetails?.toAccountType;
    if (t.accountType === account && to !== account) return "out";
    if (to === account && t.accountType !== account) return "in";
  }
  return "other";
};
const accountText = (t: Txn) => (t.transactionType === "transfer" && t.transferDetails?.toAccount ? `${t.accountName} → ${t.transferDetails.toAccount}` : t.accountName);

export default function Accounts() {
  const { hasPermission, user } = useAuth();
  const { toast } = useToast();
  // The profit & loss report is the owner's alone (the API refuses anyone else).
  const isOwner = user?.role === "admin";
  const [rows, setRows] = useState<Txn[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<Loaded<Balances>>({ state: "loading" });
  const [month, setMonth] = useState<Loaded<MonthTotals>>({ state: "loading" });
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  // ?view=payment-accounts opens that tab (the payment forms link to it).
  const [view, setView] = useState<View>(() => (new URLSearchParams(window.location.search).get("view") === "payment-accounts" ? "payment-accounts" : "all"));
  const [account, setAccount] = useState("all");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<"new" | "receive" | null>(null);

  const canEdit = hasPermission("Accounts: Create & Edit");

  // Balances and this month's totals load independently: one failing shows
  // that figure as unavailable and leaves the other as loaded.
  const loadSummary = useCallback(async () => {
    const summary = await loadAccountsSummary(apiClient);
    setBalances(summary.balances);
    setMonth(summary.month);
  }, []);

  const load = useCallback(async () => {
    if (view === "reports" || view === "reconciliation" || view === "payment-accounts") return;
    setLoading(true);
    try {
      const p: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE), sortBy: "createdAt", sortOrder: "desc" };
      if (q) p.search = q;
      if (view === "income" || view === "expense") p.transactionType = view;
      if (view === "other") p.transactionType = OTHER_TYPES;
      if (account !== "all") p.accountType = account;
      const res = (await apiClient.getAccountTransactions(p)) as { transactions?: Txn[]; pagination?: { totalTransactions?: number } };
      const list = res?.transactions || [];
      setRows(list);
      setTotal(res?.pagination?.totalTransactions ?? list.length);
    } catch (error) {
      toast({ title: "Transactions could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, q, view, account, toast]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [q, view, account]);

  const refresh = () => {
    load();
    loadSummary();
  };

  const amt = (n: number) => formatINR(n, { compact: Math.abs(n) >= 1e5 });
  const bal = balances.state === "ready" ? balances.value : null;
  const totalBalance = bal ? bal.cashBalance + bal.bankBalance : 0;
  const totals = month.state === "ready" ? month.value : null;
  const net = totals ? totals.in - totals.out : 0;
  const unavailable = (what: string, error: string) => ({
    value: <span className="text-muted-foreground">—</span>,
    hint: <span title={error}>{what} unavailable · <button type="button" className="underline underline-offset-2" onClick={() => loadSummary()}>Retry</button></span>,
    tone: "warning" as const
  });
  const balanceMetric = (label: string, value: number, hint: string) =>
    bal ? { label, value: amt(value), hint } : balances.state === "failed" ? { label, ...unavailable("Balance", balances.error) } : { label, value: "…", hint };

  const columns: Column<Txn>[] = [
    { id: "date", header: "Date", cell: (t) => <span className="whitespace-nowrap">{fmtDate(t.transactionDate || t.createdAt)}</span>, sortValue: (t) => t.transactionDate || t.createdAt, className: "w-[120px]" },
    {
      id: "description",
      header: "Description",
      cell: (t) => {
        const d = direction(t, account);
        const Icon = d === "in" ? ArrowDownLeft : d === "out" ? ArrowUpRight : Scale;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                d === "in" ? "bg-success-soft text-success-strong" : d === "out" ? "bg-destructive-soft text-destructive-strong" : "bg-muted text-muted-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <Stack top={<span className="font-medium">{t.description}</span>} bottom={<span className="font-mono">{t.reference || t.transactionNumber}</span>} />
          </div>
        );
      },
      className: "min-w-[260px]"
    },
    {
      id: "category",
      header: "Category",
      cell: (t) => (
        <div className="flex flex-wrap items-center gap-1">
          <Tag>{t.category}</Tag>
          {t.transactionType !== "income" && t.transactionType !== "expense" && humanize(t.transactionType).toLowerCase() !== t.category.toLowerCase() && (
            <span className="text-xs text-muted-foreground">{humanize(t.transactionType)}</span>
          )}
        </div>
      ),
      sortValue: (t) => t.category,
      hideBelow: "lg"
    },
    { id: "account", header: "Account", cell: (t) => <Stack top={accountText(t)} bottom={METHOD[t.paymentMethod] || humanize(t.paymentMethod)} />, sortValue: (t) => accountText(t), hideBelow: "md" },
    {
      id: "in",
      header: "Money in",
      align: "right",
      cell: (t) => (direction(t, account) !== "out" ? <span className={cn(direction(t, account) === "in" && "font-semibold text-success-strong")}>{formatINR(t.amount)}</span> : ""),
      sortValue: (t) => (direction(t, account) !== "out" ? t.amount : 0)
    },
    {
      id: "out",
      header: "Money out",
      align: "right",
      cell: (t) => (direction(t, account) === "out" ? <span className="font-semibold text-destructive-strong">{formatINR(t.amount)}</span> : ""),
      sortValue: (t) => (direction(t, account) === "out" ? t.amount : 0)
    }
  ];

  const inView = rows.filter((t) => direction(t, account) === "in").reduce((s, t) => s + t.amount, 0);
  const outView = rows.filter((t) => direction(t, account) === "out").reduce((s, t) => s + t.amount, 0);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Accounts"
        description="Cash and bank balances, and every amount that came in or went out."
        actions={
          canEdit && (
            <>
              <Button variant="outline" onClick={() => setDialog("receive")}>
                <ArrowDownLeft />
                Receive payment
              </Button>
              <Button onClick={() => setDialog("new")}>
                <Plus />
                New transaction
              </Button>
            </>
          )
        }
      />

      <MetricBar
        loading={balances.state === "loading" && month.state === "loading"}
        metrics={[
          { ...balanceMetric("Total balance", totalBalance, "Cash and bank together"), ...(bal && { tone: totalBalance < 0 ? "danger" : "default" }) },
          { ...balanceMetric("Cash in hand", bal?.cashBalance || 0, "Cash account"), onClick: () => setAccount(account === "cash" ? "all" : "cash"), active: account === "cash" },
          { ...balanceMetric("Bank", bal?.bankBalance || 0, "Bank accounts"), onClick: () => setAccount(account === "bank" ? "all" : "bank"), active: account === "bank" },
          totals
            ? {
                label: "Net this month",
                value: `${net < 0 ? "−" : ""}${amt(Math.abs(net))}`,
                hint: `${formatINR(totals.in)} in · ${formatINR(totals.out)} out`,
                tone: net < 0 ? "danger" : "success"
              }
            : month.state === "failed"
              ? { label: "Net this month", ...unavailable("Monthly total", month.error) }
              : { label: "Net this month", value: "…" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "all", label: "All entries", icon: Wallet },
            { value: "income", label: "Money in", icon: ArrowDownLeft },
            { value: "expense", label: "Money out", icon: ArrowUpRight },
            { value: "other", label: "Balances & adjustments", icon: Landmark },
            { value: "payment-accounts", label: "Payment accounts", icon: Landmark },
            { value: "reconciliation", label: "Bank reconciliation", icon: Scale },
            ...(isOwner ? [{ value: "reports" as const, label: "Profit & loss", icon: BarChart3 }] : [])
          ]}
        />

        {view === "payment-accounts" ? (
          <PaymentAccountsView canEdit={canEdit} canDelete={hasPermission("Accounts: Delete")} />
        ) : view === "reconciliation" ? (
          <BankReconciliation canEdit={canEdit} />
        ) : view === "reports" && isOwner ? (
          <AccountsReports />
        ) : (
          <DataCard
            toolbar={
              <Toolbar search={<SearchField value={search} onChange={setSearch} placeholder="Search description, category or reference" />}>
                <FilterSelect
                  label="Account"
                  value={account}
                  onChange={setAccount}
                  options={[
                    { value: "cash", label: "Cash" },
                    { value: "bank", label: "Bank" }
                  ]}
                />
              </Toolbar>
            }
            footer={
              !loading &&
              rows.length > 0 && (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span className="num">
                    On this page: <span className="text-success-strong">{formatINR(inView)} in</span> · <span className="text-destructive-strong">{formatINR(outView)} out</span>
                  </span>
                  <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} noun="entries" />
                </div>
              )
            }
          >
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(t) => t._id}
              loading={loading}
              mobile={(t) => {
                const d = direction(t, account);
                return (
                  <div className="flex items-start justify-between gap-3">
                    <Stack top={<span className="font-medium">{t.description}</span>} bottom={`${fmtDate(t.transactionDate || t.createdAt)} · ${t.category} · ${accountText(t)}`} />
                    <span className={cn("num shrink-0 font-semibold", d === "in" && "text-success-strong", d === "out" && "text-destructive-strong")}>
                      {d === "out" ? "−" : d === "in" ? "+" : ""}
                      {formatINR(t.amount)}
                    </span>
                  </div>
                );
              }}
              empty={
                <EmptyState
                  icon={Wallet}
                  title={q || view !== "all" || account !== "all" ? "No entries in this view" : "No transactions yet"}
                  description={q || view !== "all" || account !== "all" ? undefined : "Record opening balances, money received and expenses to see your cash position."}
                  action={
                    canEdit &&
                    !q &&
                    view === "all" && (
                      <Button onClick={() => setDialog("new")}>
                        <Plus />
                        New transaction
                      </Button>
                    )
                  }
                />
              }
            />
          </DataCard>
        )}
      </div>

      <NewTransactionDialog open={dialog === "new"} onOpenChange={(o) => !o && setDialog(null)} onTransactionCreated={refresh} />
      <CreatePaymentDialog open={dialog === "receive"} onOpenChange={(o) => !o && setDialog(null)} onPaymentCreated={refresh} />
    </PageShell>
  );
}
