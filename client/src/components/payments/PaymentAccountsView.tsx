import { useCallback, useEffect, useState } from "react";
import { History, Pencil, Plus, Power, Scale, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, DataCard, DataTable, Pagination, StatusPill, type Column } from "@/components/data";
import { useToast } from "@/hooks/use-toast";
import { fmtDate, formatINR } from "@/lib/format";
import { istToday, KIND_LABEL, paymentAccountsApi, type LedgerEntry, type PaymentAccount, type PaymentAccountInput, type PaymentAccountKind } from "@/lib/api/paymentAccounts";
import { PaymentCollectionPanel } from "./PaymentCollectionPanel";

const detailOf = (a: PaymentAccount) =>
  a.kind === "bank" ? [a.bankName, a.accountNumberMasked, a.ifscCode].filter(Boolean).join(" · ") : a.kind === "wallet" ? [a.provider, a.walletId].filter(Boolean).join(" · ") : "Cash in hand";

/**
 * Accounts → Payment accounts: where the business receives money (Cash,
 * Paytm, bank accounts), their balances, the daily closing report, each
 * account's history, and balance adjustments.
 */
export function PaymentAccountsView({ canEdit, canDelete }: { canEdit: boolean; canDelete: boolean }) {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PaymentAccount | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<PaymentAccount | null>(null);
  const [history, setHistory] = useState<PaymentAccount | null>(null);
  const [deleting, setDeleting] = useState<PaymentAccount | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAccounts(await paymentAccountsApi.list());
    } catch (e) {
      toast({ title: "Payment accounts could not be loaded", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);
  const refresh = () => {
    load();
    setReloadKey((k) => k + 1);
  };

  const toggleActive = async (a: PaymentAccount) => {
    try {
      await paymentAccountsApi.update(a._id, { isActive: !a.isActive });
      toast({ title: a.isActive ? `${a.nickname} is inactive` : `${a.nickname} is active again`, description: a.isActive ? "It is no longer offered for new payments; its history stays." : undefined });
      refresh();
    } catch (e) {
      toast({ title: "Not changed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await paymentAccountsApi.remove(deleting._id);
      toast({ title: `${deleting.nickname} deleted` });
      setDeleting(null);
      refresh();
    } catch (e) {
      toast({ title: "Not deleted", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      throw e;
    }
  };

  const columns: Column<PaymentAccount>[] = [
    {
      id: "name",
      header: "Account",
      cell: (a) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{a.nickname}</span>
            {!a.isActive && <StatusPill>Inactive</StatusPill>}
          </div>
          <div className="truncate text-xs text-muted-foreground">{detailOf(a)}</div>
        </div>
      ),
      sortValue: (a) => a.nickname
    },
    { id: "kind", header: "Type", cell: (a) => KIND_LABEL[a.kind], sortValue: (a) => a.kind, hideBelow: "md" },
    { id: "opening", header: "Opening balance", align: "right", cell: (a) => <span className="text-muted-foreground">{formatINR(a.openingBalance)} · {fmtDate(a.openingDate)}</span>, hideBelow: "lg" },
    { id: "balance", header: "Balance now", align: "right", cell: (a) => <span className="num font-semibold">{formatINR(a.balance ?? 0)}</span>, sortValue: (a) => a.balance ?? 0 }
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold">Payment accounts</h2>
            <p className="text-sm text-muted-foreground">Where customers' payments are received. Balances come from every payment, refund, transfer and adjustment recorded against the account.</p>
          </div>
          {canEdit && (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add account
            </Button>
          )}
        </div>
        <DataCard>
          <DataTable
            columns={columns}
            rows={accounts}
            rowKey={(a) => a._id}
            loading={loading}
            onRowClick={(a) => setHistory(a)}
            actions={(a) => [
              { label: "History", icon: History, onClick: () => setHistory(a) },
              { label: "Edit", icon: Pencil, onClick: () => setEditing(a), hidden: !canEdit },
              { label: "Adjust balance", icon: Scale, onClick: () => setAdjusting(a), hidden: !canEdit },
              { label: a.isActive ? "Mark inactive" : "Mark active", icon: Power, onClick: () => toggleActive(a), hidden: !canEdit, separated: true },
              { label: "Delete", icon: Trash2, destructive: true, onClick: () => setDeleting(a), hidden: !canDelete }
            ]}
            actionsLabel={(a) => `Actions for ${a.nickname}`}
            empty={<p className="px-4 py-6 text-sm text-muted-foreground">No accounts yet. Add Cash, Paytm and each bank account money is received into.</p>}
            mobile={(a) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{a.nickname}</div>
                  <div className="truncate text-xs text-muted-foreground">{detailOf(a)}</div>
                </div>
                <span className="num font-semibold">{formatINR(a.balance ?? 0)}</span>
              </div>
            )}
          />
        </DataCard>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-display text-lg font-semibold">Daily closing</h2>
          <p className="text-sm text-muted-foreground">Opening balance, money received and paid out, and the closing balance of each account for a day or a period.</p>
        </div>
        <PaymentCollectionPanel key={reloadKey} variant="report" />
      </section>

      <PaymentAccountDialog
        account={editing === "new" ? null : editing}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      <AdjustBalanceDialog account={adjusting} onOpenChange={(o) => !o && setAdjusting(null)} onSaved={refresh} />
      <AccountHistoryDialog account={history} onOpenChange={(o) => !o && setHistory(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.nickname}?`}
        description="Only an account nothing has been received into can be deleted. One with history is marked inactive instead."
        onConfirm={remove}
      />
    </div>
  );
}

const emptyForm = (): PaymentAccountInput & { openingBalanceText: string } => ({
  kind: "bank",
  nickname: "",
  bankName: "",
  accountHolderName: "",
  accountNumber: "",
  ifscCode: "",
  provider: "",
  walletId: "",
  openingBalanceText: "",
  openingDate: istToday(),
  notes: ""
});

/** Add or edit a payment account. An edit shows the account number masked; leave it blank to keep it. */
function PaymentAccountDialog({ account, open, onOpenChange, onSaved }: { account: PaymentAccount | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setForm(
      account
        ? {
            kind: account.kind,
            nickname: account.nickname,
            bankName: account.bankName || "",
            accountHolderName: account.accountHolderName || "",
            accountNumber: "",
            ifscCode: account.ifscCode || "",
            provider: account.provider || "",
            walletId: account.walletId || "",
            openingBalanceText: String(account.openingBalance || ""),
            openingDate: (account.openingDate || "").slice(0, 10) ? new Date(new Date(account.openingDate).getTime() + 330 * 60000).toISOString().slice(0, 10) : istToday(),
            notes: account.notes || ""
          }
        : emptyForm()
    );
  }, [open, account]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!form.nickname.trim()) return setError("Give the account a name, e.g. HDFC Current or Paytm.");
    const opening = form.openingBalanceText.trim() === "" ? 0 : Number(form.openingBalanceText);
    if (!Number.isFinite(opening)) return setError("The opening balance must be a number.");
    const input: PaymentAccountInput = {
      kind: form.kind,
      nickname: form.nickname.trim(),
      openingBalance: opening,
      openingDate: form.openingDate,
      notes: form.notes?.trim() || undefined,
      ...(form.kind === "bank"
        ? { bankName: form.bankName?.trim(), accountHolderName: form.accountHolderName?.trim(), ifscCode: form.ifscCode?.trim().toUpperCase(), ...(form.accountNumber?.trim() ? { accountNumber: form.accountNumber.replace(/\s+/g, "") } : {}) }
        : form.kind === "wallet"
          ? { provider: form.provider?.trim(), walletId: form.walletId?.trim() }
          : {})
    };
    setSaving(true);
    setError("");
    try {
      if (account) await paymentAccountsApi.update(account._id, input);
      else await paymentAccountsApi.create(input);
      toast({ title: account ? `${input.nickname} saved` : `${input.nickname} added` });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The account could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.nickname}` : "Add payment account"}</DialogTitle>
          <DialogDescription>The name is what staff choose when recording a payment. Full account numbers are not shown in lists.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pa-kind">Type</Label>
              <Select value={form.kind} onValueChange={(v) => v && set({ kind: v as PaymentAccountKind })}>
                <SelectTrigger id="pa-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(KIND_LABEL) as PaymentAccountKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pa-name">Name</Label>
              <Input id="pa-name" value={form.nickname} maxLength={60} onChange={(e) => set({ nickname: e.target.value })} placeholder={form.kind === "bank" ? "HDFC Current" : form.kind === "wallet" ? "Paytm" : "Cash"} />
            </div>
          </div>

          {form.kind === "bank" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pa-bank">Bank name</Label>
                <Input id="pa-bank" value={form.bankName} onChange={(e) => set({ bankName: e.target.value })} placeholder="HDFC Bank" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pa-holder">Account holder</Label>
                <Input id="pa-holder" value={form.accountHolderName} onChange={(e) => set({ accountHolderName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pa-number">Account number</Label>
                <Input
                  id="pa-number"
                  inputMode="numeric"
                  autoComplete="off"
                  value={form.accountNumber}
                  onChange={(e) => set({ accountNumber: e.target.value })}
                  placeholder={account?.accountNumberMasked ? `${account.accountNumberMasked} (leave blank to keep)` : ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pa-ifsc">IFSC</Label>
                <Input id="pa-ifsc" value={form.ifscCode} maxLength={11} onChange={(e) => set({ ifscCode: e.target.value.toUpperCase() })} placeholder="HDFC0001234" />
              </div>
            </div>
          )}
          {form.kind === "wallet" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pa-provider">Provider</Label>
                <Input id="pa-provider" value={form.provider} onChange={(e) => set({ provider: e.target.value })} placeholder="Paytm, PhonePe…" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pa-wallet">UPI ID / merchant ID / number</Label>
                <Input id="pa-wallet" value={form.walletId} onChange={(e) => set({ walletId: e.target.value })} placeholder="shop@paytm" />
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pa-opening">Opening balance (₹)</Label>
              <Input id="pa-opening" type="number" inputMode="decimal" step="0.01" value={form.openingBalanceText} onChange={(e) => set({ openingBalanceText: e.target.value })} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pa-opening-date">As of</Label>
              <Input id="pa-opening-date" type="date" value={form.openingDate} max={istToday()} onChange={(e) => set({ openingDate: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pa-notes">Notes</Label>
            <Textarea id="pa-notes" rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Optional" />
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-sm text-destructive-strong">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {account ? "Save" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Match the recorded balance to the real one (a statement, a cash count), with the reason on record. */
function AdjustBalanceDialog({ account, onOpenChange, onSaved }: { account: PaymentAccount | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [actual, setActual] = useState("");
  const [date, setDate] = useState(istToday());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!account) return;
    setActual(String(account.balance ?? ""));
    setDate(istToday());
    setNote("");
    setError("");
  }, [account]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || saving) return;
    if (actual.trim() === "" || !Number.isFinite(Number(actual))) return setError("Enter the actual balance.");
    if (note.trim().length < 3) return setError("Say why the balance differs.");
    setSaving(true);
    try {
      const res = await paymentAccountsApi.adjust(account._id, { actualBalance: Number(actual), date, note: note.trim() });
      toast({
        title: res.difference ? `${account.nickname} adjusted by ${formatINR(res.difference)}` : "The recorded balance already matches",
        description: res.difference ? `Recorded ${formatINR(res.recorded)} at the end of ${date}.` : undefined
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The balance could not be adjusted.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Adjust {account?.nickname}</DialogTitle>
          <DialogDescription>Enter the real balance at the end of a day. The difference is recorded as an adjustment, with your reason.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="adj-actual">Actual balance (₹)</Label>
              <Input id="adj-actual" type="number" inputMode="decimal" step="0.01" value={actual} onChange={(e) => setActual(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adj-date">At the end of</Label>
              <Input id="adj-date" type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adj-note">Reason</Label>
            <Input id="adj-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Bank charges, cash count short…" />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive-strong">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Record adjustment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ENTRY_LABEL = (e: LedgerEntry) =>
  e.sourcePaymentId ? "Payment received" : e.sourceRefundPaymentId ? "Refund" : e.transactionType === "opening_balance" ? "Opening balance" : e.transactionType === "transfer" ? "Transfer" : e.transactionType === "adjustment" ? "Adjustment" : e.transactionType === "expense" ? "Paid out" : "Money in";

/** Everything that moved money in or out of one account, newest first. */
function AccountHistoryDialog({ account, onOpenChange }: { account: PaymentAccount | null; onOpenChange: (o: boolean) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<LedgerEntry | null>(null);

  useEffect(() => {
    setPage(1);
    setFrom("");
    setTo("");
    setDetail(null);
  }, [account]);
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    paymentAccountsApi
      .ledger(account._id, { from: from || undefined, to: to || undefined, page, limit: 20 })
      .then((r) => {
        if (cancelled) return;
        setRows(r.entries);
        setTotal(r.pagination.total);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "The history could not be loaded"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [account, from, to, page]);

  const columns: Column<LedgerEntry>[] = [
    { id: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap">{new Date(e.date).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>, className: "w-[150px]" },
    {
      id: "what",
      header: "Entry",
      cell: (e) => (
        <div className="min-w-0">
          <div className="font-medium">{ENTRY_LABEL(e)}</div>
          <div className="truncate text-xs text-muted-foreground">
            {[e.customerId?.name, e.invoiceId?.invoiceNumber, e.reference || e.referenceNumber].filter(Boolean).join(" · ") || e.description}
          </div>
        </div>
      )
    },
    { id: "status", header: "Status", cell: (e) => <StatusPill tone={e.status === "completed" ? "success" : e.status === "pending" ? "warning" : "neutral"}>{e.status}</StatusPill>, hideBelow: "md" },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (e) => (
        <span className={e.direction === "in" ? "font-semibold text-success-strong" : e.direction === "out" ? "font-semibold text-destructive-strong" : undefined}>
          {e.direction === "out" ? "−" : e.direction === "in" ? "+" : ""}
          {formatINR(e.amount)}
        </span>
      )
    }
  ];

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{account?.nickname} — history</DialogTitle>
          <DialogDescription>Payments received, refunds, transfers, adjustments and the opening balance. Select an entry for its details.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="hist-from" className="text-xs text-muted-foreground">From</Label>
            <Input id="hist-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-8 w-[150px]" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hist-to" className="text-xs text-muted-foreground">To</Label>
            <Input id="hist-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-8 w-[150px]" />
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive-strong">{error}</p>
        ) : (
          <DataCard footer={total > 20 && <Pagination page={page} pageSize={20} total={total} onPageChange={setPage} noun="entries" />}>
            <DataTable columns={columns} rows={rows} rowKey={(e) => e._id} loading={loading} onRowClick={(e) => setDetail(e)} empty={<p className="px-4 py-6 text-sm text-muted-foreground">Nothing recorded in this period.</p>} />
          </DataCard>
        )}
        {detail && (
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 rounded-md border bg-muted/30 p-3 text-sm" data-testid="entry-detail">
            <dt className="text-muted-foreground">Entry</dt>
            <dd>{ENTRY_LABEL(detail)} · {detail.transactionNumber}</dd>
            <dt className="text-muted-foreground">Date</dt>
            <dd>{fmtDate(detail.date)}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd>{formatINR(detail.amount)} {detail.direction === "out" ? "out" : detail.direction === "in" ? "in" : ""}</dd>
            {detail.customerId?.name && (<><dt className="text-muted-foreground">Customer</dt><dd>{detail.customerId.name}</dd></>)}
            {detail.invoiceId?.invoiceNumber && (<><dt className="text-muted-foreground">Invoice</dt><dd>{detail.invoiceId.invoiceNumber}</dd></>)}
            {(detail.reference || detail.referenceNumber) && (<><dt className="text-muted-foreground">Reference</dt><dd>{[detail.reference, detail.referenceNumber].filter(Boolean).join(" · ")}</dd></>)}
            <dt className="text-muted-foreground">Status</dt>
            <dd>{detail.status}</dd>
            <dt className="text-muted-foreground">Description</dt>
            <dd>{detail.description}</dd>
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
