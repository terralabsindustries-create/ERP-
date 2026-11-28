import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/common/LoadState";
import { StatusPill } from "@/components/data";
import { useLoader } from "@/hooks/useLoader";
import { useToast } from "@/hooks/use-toast";
import apiClient, { type ApiError } from "@/lib/apiClient";
import { fmtDateTime } from "@/lib/format";

/*
  E-invoice (IRN) and e-way bill for one invoice (backend services/gstCompliance.js).
  Shows what is missing before anything is sent; IRN/EWB numbers appear only
  as returned by the configured provider. With no provider configured the
  buttons explain that nothing can be generated.
*/
export function GstComplianceDialog({ invoice, onOpenChange }: { invoice: { _id: string; invoiceNumber: string } | null; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const st = useLoader((signal) => apiClient.getWithSignal<any>(`/gst-compliance/invoices/${invoice?._id}`, undefined, signal), [invoice?._id], { enabled: !!invoice });
  const [busy, setBusy] = useState(false);
  const [ewb, setEwb] = useState({ transportMode: "road", vehicleNumber: "", distanceKm: "", fromPincode: "", toPincode: "", transporterId: "", transportDocNumber: "" });
  const d = st.data;
  const loadError = st.error as ApiError | null;
  // A frontend release can reach an older API that does not mount this module.
  // Distinguish that from an invoice the caller cannot access (also a 404).
  const serviceUnavailable = loadError?.kind === "not_found" && /^((API )?Route \/api\/gst-compliance\b)/i.test(loadError.message || "");
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await apiClient.post(`/gst-compliance/invoices/${invoice!._id}/${path}`, body || {});
      toast({ title: "Done" });
    } catch (error: any) {
      toast({ title: "Not generated", description: [error?.message, ...(error?.details?.problems || [])].filter(Boolean).join(" "), variant: "destructive" });
    } finally {
      setBusy(false);
      st.reload();
    }
  };
  const irn = d?.eInvoice;
  const activeEwb = d?.eWayBills?.find((x: any) => x.status === "generated");

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>E-invoice & e-way bill — {invoice?.invoiceNumber}</DialogTitle>
          <DialogDescription>Generated through your authorised provider (GSP). Nothing here is filed until the provider confirms it.</DialogDescription>
        </DialogHeader>
        {serviceUnavailable && !d ? (
          <div role="alert" className="rounded-md border border-warning/40 bg-warning-soft p-4 text-sm text-warning-strong">
            E-invoice and e-way bill status is unavailable on the connected server. Ask your administrator to update the service before using this feature.
          </div>
        ) : st.error && !d ? <ErrorState compact error={st.error} what="the e-invoice status" onRetry={st.reload} /> : !d ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          <div className="space-y-5 text-sm">
            {!d.settings.providerReady && (
              <p className="flex gap-2 rounded-md border border-warning/40 bg-warning-soft p-2 text-warning-strong"><AlertTriangle className="h-4 w-4 shrink-0" />No authorised e-invoice / e-way bill provider is connected, so IRNs and e-way bills cannot be generated yet.</p>
            )}
            <section className="space-y-2">
              <h3 className="font-semibold">E-invoice (IRN) {irn && <StatusPill tone={irn.status === "generated" ? "success" : irn.status === "cancelled" ? "danger" : "warning"}>{irn.status}</StatusPill>}</h3>
              {irn?.irn && <p className="break-all font-mono text-xs">IRN {irn.irn} · Ack {irn.ackNo} · {fmtDateTime(irn.ackDate)}</p>}
              {d.eInvoiceProblems.length > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{d.eInvoiceProblems.map((p: string) => <li key={p}>{p}</li>)}</ul>}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || !d.settings.eInvoiceEnabled || irn?.status === "generated"} onClick={() => run("irn")}>Generate IRN</Button>
                {irn?.status === "generated" && <Button size="sm" variant="outline" disabled={busy} onClick={() => { const code = window.prompt("Reason: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others"); if (code) run("irn/cancel", { reasonCode: Number(code) }); }}>Cancel IRN (within 24 h)</Button>}
              </div>
              {!d.settings.eInvoiceEnabled && <p className="text-xs text-muted-foreground">E-invoicing is switched off for your business (GST Returns → Compliance settings).</p>}
            </section>
            <section className="space-y-2">
              <h3 className="font-semibold">E-way bill {activeEwb && <StatusPill tone="success">{activeEwb.ewbNumber}</StatusPill>}</h3>
              {d.eWayBillRequired === null ? <p className="text-xs text-muted-foreground">Set your e-way bill value limit in compliance settings to see whether this invoice needs one.</p> : <p className="text-xs">{d.eWayBillRequired ? "Needed: the value is above your e-way bill limit." : "Below your e-way bill limit."}</p>}
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1"><Label className="text-xs">Mode</Label>
                  <Select value={ewb.transportMode} onValueChange={(v) => setEwb({ ...ewb, transportMode: v })}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="road">Road</SelectItem><SelectItem value="rail">Rail</SelectItem><SelectItem value="air">Air</SelectItem><SelectItem value="ship">Ship</SelectItem></SelectContent></Select></div>
                {[["vehicleNumber", "Vehicle no."], ["distanceKm", "Distance (km)"], ["fromPincode", "From PIN"], ["toPincode", "To PIN"], ["transporterId", "Transporter ID"], ["transportDocNumber", "Transport doc no."]].map(([k, l]) => (
                  <div key={k} className="space-y-1"><Label className="text-xs" htmlFor={`ewb-${k}`}>{l}</Label><Input id={`ewb-${k}`} className="h-8" value={(ewb as any)[k]} onChange={(e) => setEwb({ ...ewb, [k]: e.target.value })} /></div>
                ))}
              </div>
              <Button size="sm" disabled={busy || !d.settings.eWayBillEnabled || !!activeEwb} onClick={() => run("eway-bill", { ...ewb, distanceKm: Number(ewb.distanceKm) })}>Generate e-way bill</Button>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
