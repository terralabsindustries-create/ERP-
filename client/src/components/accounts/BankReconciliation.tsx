import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Check, Landmark, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataCard, DataTable, MetricBar, Stack, type Column } from "@/components/data";
import { EmptyState } from "@/components/common/EmptyState";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR } from "@/lib/format";

type Transaction = {
  _id: string;
  createdAt: string;
  postedAt?: string;
  transactionNumber: string;
  transactionType: "income" | "expense" | "transfer" | "opening_balance";
  description: string;
  reference?: string;
  amount: number;
};
type Record = {
  _id: string;
  accountName: string;
  statementDate: string;
  openingBalance: number;
  closingBalance: number;
  clearedTotal: number;
  transactionIds: string[];
};
type Preview = { accounts: string[]; history: Record[]; previous?: Record | null; openingBalance?: number; transactions?: Transaction[] };

const signedCents = (transaction: Transaction) =>
  (transaction.transactionType === "expense" || transaction.transactionType === "transfer" ? -1 : 1) * Math.round(transaction.amount * 100);

export function BankReconciliation({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [accountName, setAccountName] = useState("");
  const [statementDate, setStatementDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [closingBalance, setClosingBalance] = useState("");
  const [preview, setPreview] = useState<Preview>({ accounts: [], history: [] });
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<{ reconciliation: Record; transactions: Transaction[] } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiClient.getBankReconciliation(accountName ? { accountName, statementDate } : undefined)
      .then((data) => {
        if (!active) return;
        const next = data as Preview;
        setPreview(next);
        setSelected([]);
        if (!accountName && next.accounts.length) setAccountName(next.accounts[0]);
      })
      .catch((error) => {
        if (active) toast({ title: "Reconciliation could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountName, statementDate, reload, toast]);

  const transactions = preview.transactions || [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const clearedCents = transactions.reduce((sum, transaction) => sum + (selectedSet.has(transaction._id) ? signedCents(transaction) : 0), 0);
  const openingCents = Math.round((preview.openingBalance || 0) * 100);
  const closingCents = closingBalance.trim() === "" ? null : Math.round(Number(closingBalance) * 100);
  const differenceCents = closingCents === null || !Number.isFinite(closingCents) ? null : closingCents - openingCents - clearedCents;
  const lastDate = preview.previous?.statementDate?.slice(0, 10);
  const dateIsAfterLast = !lastDate || statementDate > lastDate;
  const amountIsValid = closingCents !== null && Number.isFinite(closingCents) && Math.abs(Number(closingBalance) * 100 - closingCents) < 0.000001;

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const save = async () => {
    if (!accountName || !amountIsValid || differenceCents !== 0 || !dateIsAfterLast) return;
    setSaving(true);
    try {
      await apiClient.saveBankReconciliation({ accountName, statementDate, closingBalance: Number(closingBalance), transactionIds: selected });
      toast({ title: "Bank statement reconciled", description: `${selected.length} entries cleared.` });
      setClosingBalance("");
      setReload((value) => value + 1);
    } catch (error) {
      toast({ title: "Reconciliation could not be saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      setReload((value) => value + 1);
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (record: Record) => {
    try {
      const data = await apiClient.getBankReconciliationDetail(record._id);
      setDetail(data as { reconciliation: Record; transactions: Transaction[] });
    } catch (error) {
      toast({ title: "Statement could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const columns: Column<Transaction>[] = [
    { id: "selected", header: "Cleared", cell: (t) => <input type="checkbox" aria-label={`Clear ${t.description}`} checked={selectedSet.has(t._id)} disabled={!canEdit} onChange={() => toggle(t._id)} />, className: "w-20" },
    { id: "date", header: "Date", cell: (t) => fmtDate(t.postedAt || t.createdAt), sortValue: (t) => t.postedAt || t.createdAt },
    { id: "description", header: "Entry", cell: (t) => <Stack top={t.description} bottom={t.reference || t.transactionNumber} />, sortValue: (t) => t.description },
    { id: "money", header: "Amount", align: "right", cell: (t) => <span className="num">{signedCents(t) < 0 ? "−" : "+"}{formatINR(Math.abs(t.amount))}</span>, sortValue: signedCents }
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="reconcile-account">Bank account</Label>
          <select id="reconcile-account" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={accountName} onChange={(event) => { setAccountName(event.target.value); setClosingBalance(""); }}>
            {preview.accounts.length === 0 && <option value="">No bank accounts</option>}
            {preview.accounts.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="reconcile-date">Statement date</Label>
          <Input id="reconcile-date" type="date" value={statementDate} onChange={(event) => { setStatementDate(event.target.value); setClosingBalance(""); }} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reconcile-balance">Statement closing balance (₹)</Label>
          <Input id="reconcile-balance" type="number" step="0.01" value={closingBalance} onChange={(event) => setClosingBalance(event.target.value)} placeholder="Enter balance from bank statement" />
        </div>
      </div>

      {accountName ? (
        <>
          {!dateIsAfterLast && <p className="text-sm text-destructive">Choose a date after the last reconciled statement ({fmtDate(preview.previous!.statementDate)}).</p>}
          <MetricBar loading={loading} metrics={[
            { label: "Previous statement", value: formatINR(preview.openingBalance || 0), hint: lastDate ? `As of ${fmtDate(preview.previous!.statementDate)}` : "First reconciliation starts at zero" },
            { label: "Selected entries", value: `${selected.length}`, hint: `${formatINR(clearedCents / 100)} net` },
            { label: "Calculated balance", value: formatINR((openingCents + clearedCents) / 100) },
            { label: "Difference", value: differenceCents === null ? "—" : formatINR(differenceCents / 100), tone: differenceCents === null ? "default" : differenceCents === 0 ? "success" : "danger" }
          ]} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Tick entries that appear on the bank statement. Add an opening balance transaction before the first statement if needed.</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw className="h-4 w-4" />Refresh</Button>
              {canEdit && <Button onClick={save} disabled={loading || saving || !dateIsAfterLast || !amountIsValid || differenceCents !== 0}><Check className="h-4 w-4" />{saving ? "Saving…" : "Reconcile statement"}</Button>}
            </div>
          </div>
          <DataCard>
            <DataTable columns={columns} rows={transactions} rowKey={(t) => t._id} loading={loading}
              mobile={(t) => <label className="flex items-center gap-3"><input type="checkbox" checked={selectedSet.has(t._id)} disabled={!canEdit} onChange={() => toggle(t._id)} /><Stack top={t.description} bottom={`${fmtDate(t.postedAt || t.createdAt)} · ${t.reference || t.transactionNumber}`} /><span className="ml-auto num whitespace-nowrap">{signedCents(t) < 0 ? "−" : "+"}{formatINR(Math.abs(t.amount))}</span></label>}
              empty={<EmptyState icon={Landmark} title="No uncleared entries" description="There are no completed bank transactions to clear for this date." />} />
          </DataCard>
        </>
      ) : <EmptyState icon={Landmark} title="No bank account yet" description="Record a transaction against a bank account to start reconciling statements." />}

      {preview.history.length > 0 && <div className="space-y-2">
        <h3 className="text-sm font-semibold">Reconciled statements</h3>
        <div className="grid gap-2">
          {preview.history.map((record) => <button key={record._id} type="button" onClick={() => openDetail(record)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-4 py-3 text-left text-sm hover:bg-muted/50">
            <span>{record.accountName} · {fmtDate(record.statementDate)}</span>
            <span className="num">{formatINR(record.closingBalance)} · {record.transactionIds.length} cleared</span>
          </button>)}
        </div>
      </div>}
      {detail && <div className="rounded-xl border bg-card p-4 text-sm">
        <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{detail.reconciliation.accountName} · {fmtDate(detail.reconciliation.statementDate)}</h3><Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Close</Button></div>
        <p className="mt-2 text-muted-foreground">Opening {formatINR(detail.reconciliation.openingBalance)} + cleared {formatINR(detail.reconciliation.clearedTotal)} = closing {formatINR(detail.reconciliation.closingBalance)}</p>
        <div className="mt-3 space-y-1">{detail.transactions.map((t) => <div key={t._id} className="flex justify-between gap-3 border-t py-2"><span>{fmtDate(t.postedAt || t.createdAt)} · {t.description}</span><span className="num whitespace-nowrap">{signedCents(t) < 0 ? "−" : "+"}{formatINR(Math.abs(t.amount))}</span></div>)}</div>
      </div>}
    </div>
  );
}
