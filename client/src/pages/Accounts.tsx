import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, BarChart3, Landmark, Plus, Scale, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, FilterSelect, MetricBar, Pagination, SearchField, Stack, Tag, Toolbar, ViewTabs, type Column } from "@/components/data";
import { QuickReceivePaymentDialog } from "@/components/accounts/QuickReceivePaymentDialog";
import { NewTransactionDialog } from "@/components/accounts/NewTransactionDialog";
import { AccountsReports } from "@/components/accounts/AccountsReports";
import { BankReconciliation } from "@/components/accounts/BankReconciliation";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/useDebounced";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

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
}

type View = "all" | "income" | "expense" | "other" | "reconciliation" | "reports";
const PAGE_SIZE = 25;
const METHOD: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card", upi: "UPI", wallet: "Wallet", other: "Other" };

// Money in and money out; opening balances and adjustments sit on their own.
const direction = (t: Txn) => (t.transactionType === "income" ? "in" : t.transactionType === "expense" ? "out" : "other");

export default function Accounts() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<Txn[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<{ cashBalance: number; bankBalance: number } | null>(null);
  const [month, setMonth] = useState<{ in: number; out: number } | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [view, setView] = useState<View>("all");
  const [account, setAccount] = useState("all");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<"new" | "receive" | null>(null);

  const canEdit = hasPermission("Accounts: Create & Edit");

  const loadSummary = useCallback(async () => {
    try {
      const b = (await apiClient.getAccountBalances()) as { currentBalances?: { cashBalance?: number; bankBalance?: number } };
      setBalances({ cashBalance: b?.currentBalances?.cashBalance || 0, bankBalance: b?.currentBalances?.bankBalance || 0 });
      const start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      const ledger = (await apiClient.getAccountLedger({ startDate: start.toISOString(), limit: 100 })) as { transactions?: Txn[] };
      const list = ledger?.transactions || [];
      setMonth({
        in: list.filter((t) => t.transactionType === "income").reduce((s, t) => s + t.amount, 0),
        out: list.filter((t) => t.transactionType === "expense").reduce((s, t) => s + t.amount, 0)
      });
    } catch {
      setBalances({ cashBalance: 0, bankBalance: 0 });
    }
  }, []);

  const load = useCallback(async () => {
    if (view === "reports" || view === "reconciliation") return;
    setLoading(true);
    try {
      const p: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE), sortBy: "createdAt", sortOrder: "desc" };
      if (q) p.search = q;
      if (view === "income" || view === "expense") p.transactionType = view;
      if (account !== "all") p.accountType = account;
      const res = (await apiClient.getAccountTransactions(p)) as { transactions?: Txn[]; pagination?: { totalTransactions?: number } };
      let list = res?.transactions || [];
      // "Other" (opening balances, transfers, adjustments) has no single type filter on the API.
      if (view === "other") list = list.filter((t) => direction(t) === "other");
      setRows(list);
      setTotal(view === "other" ? list.length : res?.pagination?.totalTransactions ?? list.length);
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

  const totalBalance = (balances?.cashBalance || 0) + (balances?.bankBalance || 0);
  const net = (month?.in || 0) - (month?.out || 0);
  const amt = (n: number) => formatINR(n, { compact: Math.abs(n) >= 1e5 });

  const columns: Column<Txn>[] = [
    { id: "date", header: "Date", cell: (t) => <span className="whitespace-nowrap">{fmtDate(t.transactionDate || t.createdAt)}</span>, sortValue: (t) => t.transactionDate || t.createdAt, className: "w-[120px]" },
    {
      id: "description",
      header: "Description",
      cell: (t) => {
        const d = direction(t);
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
          {direction(t) === "other" && humanize(t.transactionType).toLowerCase() !== t.category.toLowerCase() && (
            <span className="text-xs text-muted-foreground">{humanize(t.transactionType)}</span>
          )}
        </div>
      ),
      sortValue: (t) => t.category,
      hideBelow: "lg"
    },
    { id: "account", header: "Account", cell: (t) => <Stack top={t.accountName} bottom={METHOD[t.paymentMethod] || humanize(t.paymentMethod)} />, sortValue: (t) => t.accountName, hideBelow: "md" },
    {
      id: "in",
      header: "Money in",
      align: "right",
      cell: (t) => (direction(t) !== "out" ? <span className={cn(direction(t) === "in" && "font-semibold text-success-strong")}>{formatINR(t.amount)}</span> : ""),
      sortValue: (t) => (direction(t) !== "out" ? t.amount : 0)
    },
    {
      id: "out",
      header: "Money out",
      align: "right",
      cell: (t) => (direction(t) === "out" ? <span className="font-semibold text-destructive-strong">{formatINR(t.amount)}</span> : ""),
      sortValue: (t) => (direction(t) === "out" ? t.amount : 0)
    }
  ];

  const inView = rows.filter((t) => direction(t) === "in").reduce((s, t) => s + t.amount, 0);
  const outView = rows.filter((t) => direction(t) === "out").reduce((s, t) => s + t.amount, 0);

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
        loading={!balances}
        metrics={[
          { label: "Total balance", value: amt(totalBalance), hint: "Cash and bank together", tone: totalBalance < 0 ? "danger" : "default" },
          { label: "Cash in hand", value: amt(balances?.cashBalance || 0), hint: "Cash account", onClick: () => setAccount(account === "cash" ? "all" : "cash"), active: account === "cash" },
          { label: "Bank", value: amt(balances?.bankBalance || 0), hint: "Bank accounts", onClick: () => setAccount(account === "bank" ? "all" : "bank"), active: account === "bank" },
          {
            label: "Net this month",
            value: `${net < 0 ? "−" : ""}${amt(Math.abs(net))}`,
            hint: month ? `${formatINR(month.in)} in · ${formatINR(month.out)} out` : undefined,
            tone: net < 0 ? "danger" : "success"
          }
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
            { value: "reconciliation", label: "Bank reconciliation", icon: Scale },
            { value: "reports", label: "Reports", icon: BarChart3 }
          ]}
        />

        {view === "reconciliation" ? (
          <BankReconciliation canEdit={canEdit} />
        ) : view === "reports" ? (
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
                const d = direction(t);
                return (
                  <div className="flex items-start justify-between gap-3">
                    <Stack top={<span className="font-medium">{t.description}</span>} bottom={`${fmtDate(t.transactionDate || t.createdAt)} · ${t.category} · ${t.accountName}`} />
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
      <QuickReceivePaymentDialog open={dialog === "receive"} onOpenChange={(o) => !o && setDialog(null)} onPaymentRecorded={refresh} />
    </PageShell>
  );
}
