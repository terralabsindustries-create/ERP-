import { useEffect, useState } from "react";
import { Mail, MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { getTemplateBodyText, getTemplateVariableNumbers } from "@/lib/whatsappTemplates";

export interface SendableQuotation {
  _id: string;
  quotationNumber: string;
  customer_id?: { name?: string; email?: string; phone?: string } | null;
}

function Summary({ q }: { q: SendableQuotation }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-muted px-3 py-2 text-sm">
      <span>
        <span className="text-muted-foreground">Quotation </span>
        <span className="font-mono font-medium">{q.quotationNumber}</span>
      </span>
      <span>
        <span className="text-muted-foreground">Customer </span>
        <span className="font-medium">{q.customer_id?.name}</span>
      </span>
    </div>
  );
}

/** Email the quotation PDF to the customer. */
export function SendQuotationEmailDialog({ quotation, onOpenChange, onSent }: { quotation: SendableQuotation | null; onOpenChange: (o: boolean) => void; onSent: () => void }) {
  const { toast } = useToast();
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!quotation) return;
    setTo(quotation.customer_id?.email || "");
    setMessage("");
  }, [quotation]);

  const send = async () => {
    if (!quotation) return;
    setSending(true);
    try {
      await apiClient.sendQuotationEmail(quotation._id, to, message || undefined);
      toast({ title: "Quotation emailed", description: `Sent to ${to}` });
      onOpenChange(false);
      onSent();
    } catch (error) {
      toast({ title: "Email not sent", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={!!quotation} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email quotation
          </DialogTitle>
        </DialogHeader>
        {quotation && (
          <div className="space-y-4">
            <Summary q={quotation} />
            <div className="space-y-1.5">
              <Label htmlFor="q-email-to">Send to</Label>
              <Input id="q-email-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-email-msg">Message (optional)</Label>
              <Textarea id="q-email-msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add a personal note" rows={3} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || !to}>
            <Send />
            {sending ? "Sending…" : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MetaTemplate {
  name: string;
  status: string;
}

/** Send the quotation on WhatsApp with an approved Meta template. */
export function SendQuotationWhatsAppDialog({ quotation, onOpenChange, onSent }: { quotation: SendableQuotation | null; onOpenChange: (o: boolean) => void; onSent: () => void }) {
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [template, setTemplate] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!quotation) return;
    setPhone(quotation.customer_id?.phone || "");
    setTemplate("");
    setMapping({});
    let cancelled = false;
    (async () => {
      setLoadingTemplates(true);
      try {
        const settings = (await apiClient.getWhatsAppSettings()) as { settings?: { enabled?: boolean } };
        const on = !!settings?.settings?.enabled;
        if (cancelled) return;
        setEnabled(on);
        if (on) {
          const res = (await apiClient.getMetaTemplates()) as { templates?: MetaTemplate[] };
          if (!cancelled) setTemplates((res?.templates || []).filter((t) => t.status === "APPROVED"));
        } else setTemplates([]);
      } catch {
        if (!cancelled) {
          setEnabled(false);
          setTemplates([]);
        }
      } finally {
        if (!cancelled) setLoadingTemplates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quotation]);

  const send = async () => {
    if (!quotation) return;
    if (!phone) return toast({ title: "Enter a phone number", variant: "destructive" });
    if (!enabled) return toast({ title: "WhatsApp isn't connected", description: "Connect it in Settings → WhatsApp first.", variant: "destructive" });
    if (!template) return toast({ title: "Choose an approved template", variant: "destructive" });
    setSending(true);
    try {
      await apiClient.sendQuotationWhatsApp(quotation._id, phone, template, mapping);
      toast({ title: "Quotation sent on WhatsApp", description: phone });
      onOpenChange(false);
      onSent();
    } catch (error) {
      toast({ title: "Not sent", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const chosen = templates.find((t) => t.name === template);
  const body = chosen ? getTemplateBodyText(chosen) : "";
  const vars = chosen ? getTemplateVariableNumbers(chosen) : [];

  return (
    <Dialog open={!!quotation} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Send on WhatsApp
          </DialogTitle>
        </DialogHeader>
        {quotation && (
          <div className="space-y-4">
            <Summary q={quotation} />
            <div className="space-y-1.5">
              <Label htmlFor="q-wa-phone">Phone number</Label>
              <Input id="q-wa-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98470 00000" />
            </div>
            {!loadingTemplates && !enabled && (
              <p className="rounded-md border border-warning/30 bg-warning-soft p-3 text-sm text-warning-strong">
                WhatsApp Business isn't connected yet. Connect it in Settings → WhatsApp to send quotations.
              </p>
            )}
            {enabled && (
              <div className="space-y-1.5">
                <Label htmlFor="q-wa-template">Template</Label>
                <Select
                  value={template}
                  onValueChange={(v) => {
                    setTemplate(v);
                    setMapping({});
                  }}
                >
                  <SelectTrigger id="q-wa-template">
                    <SelectValue placeholder={templates.length ? "Choose an approved template" : "No approved templates"} />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {template && (
              <div className="space-y-3 border-t pt-4">
                <Label>Fill the template</Label>
                {body && <p className="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{body}</p>}
                {vars.length === 0 ? (
                  <p className="text-xs text-muted-foreground">This template has no variables.</p>
                ) : (
                  vars.map((n) => (
                    <div key={n} className="flex items-center gap-3">
                      <span className="w-14 rounded bg-muted px-2 py-1 text-center font-mono text-xs">{`{{${n}}}`}</span>
                      <Select value={mapping[String(n)] || ""} onValueChange={(v) => setMapping((m) => ({ ...m, [String(n)]: v }))}>
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Choose what goes here" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="customerName">Customer name</SelectItem>
                          <SelectItem value="quotationNumber">Quotation number</SelectItem>
                          <SelectItem value="totalAmount">Total amount</SelectItem>
                          <SelectItem value="validUntil">Valid until</SelectItem>
                          <SelectItem value="businessName">Business name</SelectItem>
                          <SelectItem value="quotationLink">Quotation link (PDF)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending}>
            <Send />
            {sending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
