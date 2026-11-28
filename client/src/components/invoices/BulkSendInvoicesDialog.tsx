import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import apiClient from "@/lib/apiClient";
import { getTemplateBodyText, getTemplateVariableNumbers } from "@/lib/whatsappTemplates";
import type { InvoiceRow } from "./InvoicesView";

type Channel = "email" | "whatsapp";
type Result = { ok: boolean; reason?: string };

const recipientOf = (invoice: InvoiceRow, channel: Channel) =>
  channel === "email" ? invoice.customerId?.email?.trim() || "" : invoice.customerId?.phone?.trim() || "";
const recipientProblem = (invoice: InvoiceRow, channel: Channel) => {
  if (["draft", "cancelled", "refunded"].includes(invoice.status)) return "Only issued invoices can be sent";
  const recipient = recipientOf(invoice, channel);
  if (!recipient) return channel === "email" ? "Customer has no email" : "Customer has no phone";
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return "Customer email is invalid";
  return "";
};

export function BulkSendInvoicesDialog({
  channel, invoices, onClose, onSent
}: {
  channel: Channel | null;
  invoices: InvoiceRow[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [message, setMessage] = useState("");
  const [waEnabled, setWaEnabled] = useState(false);
  const [waLoading, setWaLoading] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});

  useEffect(() => {
    if (channel !== "whatsapp") return;
    let cancelled = false;
    setWaLoading(true);
    (async () => {
      try {
        const settings: any = await apiClient.getWhatsAppSettings();
        const enabled = !!settings?.settings?.enabled;
        const response: any = enabled ? await apiClient.getMetaTemplates() : null;
        if (!cancelled) {
          setWaEnabled(enabled);
          setTemplates((response?.templates || []).filter((template: any) => template.status === "APPROVED"));
        }
      } catch {
        if (!cancelled) { setWaEnabled(false); setTemplates([]); }
      } finally {
        if (!cancelled) setWaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [channel]);

  const chosen = templates.find((template) => template.name === templateName);
  const variables = chosen ? getTemplateVariableNumbers(chosen) : [];
  const mappingReady = variables.every((number) => !!mapping[String(number)]);
  const pending = channel ? invoices.filter((invoice) => !recipientProblem(invoice, channel) && !results[invoice._id]?.ok) : [];
  const delivered = Object.values(results).filter((result) => result.ok).length;
  const failed = Object.values(results).filter((result) => !result.ok).length;

  const send = async () => {
    if (!channel || !pending.length || busy) return;
    setBusy(true);
    const next = { ...results };
    try {
      for (const invoice of pending) {
        try {
          if (channel === "email") {
            await apiClient.sendInvoiceEmail(invoice._id, recipientOf(invoice, channel), message.trim() || undefined);
          } else {
            await apiClient.sendInvoiceWhatsApp(invoice._id, recipientOf(invoice, channel), templateName, mapping, chosen?.language);
          }
          next[invoice._id] = { ok: true };
        } catch (error) {
          next[invoice._id] = { ok: false, reason: error instanceof Error ? error.message : "Could not send" };
        }
        setResults({ ...next });
      }
      if (Object.values(next).some((result) => result.ok)) onSent();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!channel} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Send selected invoices by {channel === "whatsapp" ? "WhatsApp" : "email"}</DialogTitle>
          <DialogDescription>Review each recipient before sending. Invoices without a valid contact are skipped. Successful sends are not repeated if you retry failures.</DialogDescription>
        </DialogHeader>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
          {invoices.map((invoice) => {
            const problem = channel ? recipientProblem(invoice, channel) : "";
            const result = results[invoice._id];
            return <div key={invoice._id} className="flex justify-between gap-3 border-b px-1 py-1.5 last:border-0">
              <span className="font-mono">{invoice.invoiceNumber}</span>
              <span className={problem || result?.ok === false ? "text-destructive" : result?.ok ? "text-success" : "text-muted-foreground"}>
                {result?.ok ? "Sent" : result?.reason || problem || recipientOf(invoice, channel!)}
              </span>
            </div>;
          })}
        </div>
        {channel === "email" && <div className="space-y-2"><Label htmlFor="bulk-invoice-message">Message (optional)</Label><Textarea id="bulk-invoice-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Included with each email" /></div>}
        {channel === "whatsapp" && <div className="space-y-3">
          {!waLoading && !waEnabled && <p className="text-sm text-destructive">WhatsApp Business is not connected in Settings.</p>}
          {waEnabled && <><Label htmlFor="bulk-invoice-template">Approved template</Label><Select value={templateName} onValueChange={(value) => { setTemplateName(value); setMapping({}); }}><SelectTrigger id="bulk-invoice-template"><SelectValue placeholder="Choose a template" /></SelectTrigger><SelectContent>{templates.map((template) => <SelectItem key={template.name} value={template.name}>{template.name}</SelectItem>)}</SelectContent></Select></>}
          {chosen && <><p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{getTemplateBodyText(chosen)}</p>{variables.map((number) => <div key={number} className="flex items-center gap-2"><Label className="w-16">{`{{${number}}}`}</Label><Select value={mapping[String(number)] || ""} onValueChange={(value) => setMapping((current) => ({ ...current, [String(number)]: value }))}><SelectTrigger aria-label={`Variable ${number}`}><SelectValue placeholder="Choose invoice data" /></SelectTrigger><SelectContent>{["customerName", "invoiceNumber", "totalAmount", "balanceDue", "invoiceDate", "dueDate", "businessName", "invoiceLink"].map((field) => <SelectItem key={field} value={field}>{field}</SelectItem>)}</SelectContent></Select></div>)}</>}
        </div>}
        {(delivered > 0 || failed > 0) && <p className="text-sm" role="status">{delivered} sent · {failed} failed{pending.length ? ` · ${pending.length} available to retry` : ""}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{pending.length ? "Cancel" : "Close"}</Button>
          <Button type="button" disabled={busy || !pending.length || (channel === "whatsapp" && (!waEnabled || !templateName || !mappingReady))} onClick={send}>{busy ? "Sending…" : failed ? `Retry ${pending.length} failed` : `Send ${pending.length} invoice${pending.length === 1 ? "" : "s"}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
