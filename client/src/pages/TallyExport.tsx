import { useState } from "react";
import { AlertTriangle, Download, FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Panel } from "@/components/common/Panel";
import { ErrorState } from "@/components/common/LoadState";
import { useLoader } from "@/hooks/useLoader";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDateTime, localDate } from "@/lib/format";

/*
  Tally export (backend services/tallyExport.js): check the ledger names, see
  what will go out and any problems, then download Tally "Import Data" XML.
*/
const LEDGERS: [string, string][] = [
  ["salesLedger", "Sales ledger"], ["purchaseLedger", "Purchase ledger"], ["outputCgst", "Output CGST"], ["outputSgst", "Output SGST"],
  ["outputIgst", "Output IGST"], ["inputCgst", "Input CGST"], ["inputSgst", "Input SGST"], ["inputIgst", "Input IGST"],
  ["cashLedger", "Cash ledger"], ["bankLedger", "Bank ledger"], ["roundOff", "Round-off ledger"],
];
const firstOfMonth = () => localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

export default function TallyExport() {
  const { toast } = useToast();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(localDate());
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const qs = new URLSearchParams({ from, to, ...Object.fromEntries(Object.entries(mapping).filter(([, v]) => v.trim())) }).toString();
  const preview = useLoader((signal) => apiClient.getWithSignal<any>(`/tally/preview?${qs}`, undefined, signal), [qs]);
  const history = useLoader((signal) => apiClient.getWithSignal<{ exports: any[] }>("/tally/history", undefined, signal), []);
  const p = preview.data;

  const download = async (kind: "vouchers" | "masters") => {
    try {
      await apiClient.downloadExport(`/tally/export?kind=${kind}&${qs}`, `Tally_${kind}.xml`);
      history.reload();
      preview.reload();
    } catch (error) {
      toast({ title: "Export failed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Tally export"
        description="Sales, credit/debit notes, receipts and purchases as Tally import XML. Import into a test company first: this file has not been import-tested against your Tally version."
        actions={
          <>
            <Button variant="outline" onClick={() => download("masters")}><FileCode2 />Ledgers (masters)</Button>
            <Button onClick={() => download("vouchers")} disabled={!p}><Download />Vouchers</Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">From<Input type="date" className="mt-1 h-9 w-[160px]" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="text-xs text-muted-foreground">To<Input type="date" className="mt-1 h-9 w-[160px]" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="What will be exported">
          <div className="space-y-3 p-4 text-sm">
            {preview.error && !p ? (
              <ErrorState compact error={preview.error} what="the preview" onRetry={preview.reload} />
            ) : !p ? (
              <div className="h-20 animate-pulse rounded bg-muted" />
            ) : (
              <>
                <ul className="grid grid-cols-2 gap-2">
                  {Object.entries(p.counts as Record<string, number>).map(([k, v]) => <li key={k} className="rounded-md border p-2"><div className="text-xs text-muted-foreground">{k}</div><div className="num text-lg font-semibold">{v}</div></li>)}
                  {Object.keys(p.counts).length === 0 && <li className="col-span-2 text-muted-foreground">No issued documents in this period.</li>}
                </ul>
                {p.problems.length > 0 && (
                  <div className="rounded-md border border-warning/40 bg-warning-soft p-2 text-warning-strong">
                    <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" />Left out ({p.problems.length})</p>
                    <ul className="mt-1 list-disc pl-5 text-xs">{p.problems.map((x: any) => <li key={x.key}>{x.number}: {x.message}</li>)}</ul>
                  </div>
                )}
                {p.alreadyExported.length > 0 && <p className="text-xs text-warning-strong">{p.alreadyExported.length} document{p.alreadyExported.length === 1 ? " was" : "s were"} already exported earlier — importing them again may duplicate vouchers in Tally.</p>}
                {p.roundOffs.length > 0 && <p className="text-xs text-muted-foreground">{p.roundOffs.length} voucher(s) get a round-off line of up to ₹1.</p>}
              </>
            )}
          </div>
        </Panel>
        <Panel title="Ledger names in Tally" description="Use the exact names of the ledgers in your Tally company.">
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {LEDGERS.map(([k, label]) => (
              <div key={k} className="space-y-1"><Label htmlFor={`tl-${k}`} className="text-xs">{label}</Label>
                <Input id={`tl-${k}`} className="h-8" placeholder={p?.mapping?.[k] || ""} value={mapping[k] || ""} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })} />
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Export history">
        <ul className="divide-y text-sm">
          {(history.data?.exports || []).map((e) => (
            <li key={e._id} className="flex flex-wrap gap-x-4 px-4 py-2">
              <span className="font-medium">{e.kind === "masters" ? "Ledgers" : "Vouchers"}</span>
              <span className="text-muted-foreground">{fmtDateTime(e.createdAt)} by {e.exportedByName}</span>
              <span className="ml-auto text-xs text-muted-foreground">{Object.entries(e.counts || {}).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>
            </li>
          ))}
          {history.data && history.data.exports.length === 0 && <li className="px-4 py-3 text-muted-foreground">Nothing exported yet.</li>}
        </ul>
      </Panel>
    </PageShell>
  );
}
