import { useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Printer } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/common/LoadState";
import { useLoader } from "@/hooks/useLoader";
import { useToast } from "@/hooks/use-toast";
import apiClient, { BASE_URL } from "@/lib/apiClient";
import { fmtDate, formatINR, localDate } from "@/lib/format";
import { printPdf } from "@/lib/printPdf";

/*
  Statement of account for a customer or supplier (backend services/statements.js):
  opening balance, every document in the period with a running balance, the
  closing balance, ageing, and cancelled documents listed outside the balance.
*/
interface Props {
  party: { id: string; name: string; kind: "customer" | "supplier" } | null;
  onOpenChange: (open: boolean) => void;
}

const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 864e5));

export function StatementDialog({ party, onOpenChange }: Props) {
  const { toast } = useToast();
  const [from, setFrom] = useState(daysAgo(90));
  const [to, setTo] = useState(localDate());
  const path = party ? `/statements/${party.kind}/${party.id}` : "";
  const st = useLoader((signal) => apiClient.getWithSignal<any>(path, { from, to }, signal), [path, from, to], { enabled: !!party });
  const data = st.data;
  const exportAs = (format: "pdf" | "xlsx") =>
    apiClient.downloadExport(`${path}?from=${from}&to=${to}&format=${format}`, `Statement.${format}`).catch((e) => toast({ title: "Export failed", description: e.message, variant: "destructive" }));
  const print = () =>
    printPdf(async () => {
      const res = await fetch(`${BASE_URL}${path}?from=${from}&to=${to}&format=pdf`, { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } });
      if (!res.ok) throw new Error("The statement could not be prepared");
      return { blob: await res.blob(), filename: "Statement.pdf" };
    });

  return (
    <Dialog open={!!party} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Statement of account — {party?.name}</DialogTitle>
          <DialogDescription>Invoices and notes add to the balance; payments and credit notes reduce it. Cancelled documents are listed but not counted.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">From<Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="mt-1 h-9 w-[160px]" /></label>
          <label className="text-xs text-muted-foreground">To<Input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="mt-1 h-9 w-[160px]" /></label>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={print} disabled={!data}><Printer />Print</Button>
            <Button variant="outline" size="sm" onClick={() => exportAs("xlsx")} disabled={!data}><FileSpreadsheet />Excel</Button>
            <Button size="sm" onClick={() => exportAs("pdf")} disabled={!data}><Download />PDF</Button>
          </div>
        </div>
        {st.error && !data ? (
          <ErrorState compact error={st.error} what="the statement" onRetry={st.reload} />
        ) : !data ? (
          <div className="space-y-2 py-4">{[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Details</th>
                    <th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th><th className="px-3 py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="font-medium"><td className="px-3 py-2" colSpan={6}>Opening balance</td><td className="num px-3 py-2 text-right">{formatINR(data.opening)}</td></tr>
                  {data.lines.map((l: any, i: number) => (
                    <tr key={i}>
                      <td className="px-3 py-2">{fmtDate(l.date)}</td><td className="px-3 py-2">{l.type}</td><td className="px-3 py-2 font-mono text-xs">{l.reference}</td>
                      <td className="max-w-[200px] truncate px-3 py-2 text-muted-foreground">{l.description}</td>
                      <td className="num px-3 py-2 text-right">{l.debit ? formatINR(l.debit) : ""}</td><td className="num px-3 py-2 text-right">{l.credit ? formatINR(l.credit) : ""}</td>
                      <td className="num px-3 py-2 text-right">{formatINR(l.balance)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold"><td className="px-3 py-2" colSpan={4}>Closing balance</td><td className="num px-3 py-2 text-right">{formatINR(data.debits)}</td><td className="num px-3 py-2 text-right">{formatINR(data.credits)}</td><td className="num px-3 py-2 text-right">{formatINR(data.closing)}</td></tr>
                </tbody>
              </table>
            </div>
            {data.ageing && (
              <div className="grid grid-cols-5 gap-2 text-center text-xs">
                {[["Current", data.ageing.current], ["1–30 days", data.ageing.d1_30], ["31–60", data.ageing.d31_60], ["61–90", data.ageing.d61_90], ["90+", data.ageing.d90plus]].map(([k, v]) => (
                  <div key={k as string} className="rounded-md border p-2"><div className="text-muted-foreground">{k}</div><div className="num font-semibold">{formatINR(v as number)}</div></div>
                ))}
              </div>
            )}
            {data.reconciliation && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className={data.reconciliation.balanced ? "h-3.5 w-3.5 text-success-strong" : "h-3.5 w-3.5 text-warning-strong"} />
                {data.reconciliation.balanced
                  ? "Agrees with the invoices' balances, money on account and unapplied credit."
                  : `Does not agree with the documents (${formatINR(data.reconciliation.documentsBalance)}). Check payments recorded outside Payments.`}
              </p>
            )}
            {data.voided?.length > 0 && (
              <p className="text-xs text-muted-foreground">Not in the balance: {data.voided.map((v: any) => `${v.type} ${v.reference} (${formatINR(v.amount)})`).join(", ")}</p>
            )}
            {data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
