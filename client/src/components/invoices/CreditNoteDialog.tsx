import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileMinus2, FilePlus2, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusPill } from "@/components/data";
import { ErrorState } from "@/components/common/LoadState";
import { useToast } from "@/hooks/use-toast";
import apiClient, { type CreditNoteRecord } from "@/lib/apiClient";
import { formatINR } from "@/lib/printWorkflow";
import { formatDate } from "@/lib/format";

/*
  Raise a GST credit or debit note against an issued invoice, issue it, and see
  the notes already raised. Limits and GST are worked out by the server
  (services/creditNotes.js); the figures here are a preview of the same rule.
*/

const REASONS: { value: string; label: string; types: ("credit" | "debit")[] }[] = [
  { value: "sales_return", label: "Goods returned", types: ["credit"] },
  { value: "post_sale_discount", label: "Discount after sale", types: ["credit"] },
  { value: "price_revision", label: "Price revised", types: ["credit", "debit"] },
  { value: "deficiency_in_service", label: "Deficiency in service", types: ["credit"] },
  { value: "excess_charged", label: "Excess charged", types: ["credit"] },
  { value: "short_charged", label: "Short charged", types: ["debit"] },
  { value: "correction", label: "Correction", types: ["credit", "debit"] },
  { value: "other", label: "Other", types: ["credit", "debit"] },
];

interface LineRow {
  invoiceLineRef: string;
  itemName: string;
  unit?: string;
  gstRate: number;
  quantity: number;
  taxableValue: number;
  creditableValue: number;
  creditableQuantity: number;
}

interface Props {
  invoice: { _id: string; invoiceNumber: string } | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

const newKey = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function CreditNoteDialog({ invoice, onOpenChange, onChanged }: Props) {
  const { toast } = useToast();
  const [lines, setLines] = useState<LineRow[]>([]);
  const [notes, setNotes] = useState<CreditNoteRecord[]>([]);
  const [isInterState, setIsInterState] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [noteType, setNoteType] = useState<"credit" | "debit">("credit");
  const [reason, setReason] = useState("sales_return");
  const [reasonText, setReasonText] = useState("");
  const [entries, setEntries] = useState<Record<string, { quantity: string; taxableValue: string }>>({});
  const [busy, setBusy] = useState(false);
  const idemKey = useRef(newKey());

  const load = useCallback(async () => {
    if (!invoice) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [l, n] = await Promise.all([apiClient.getCreditableLines(invoice._id), apiClient.getCreditNotes({ invoiceId: invoice._id, limit: 100 })]);
      setLines(l.lines || []);
      setIsInterState(!!l.invoice?.isInterState);
      setNotes(n.notes || []);
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, [invoice]);

  useEffect(() => {
    if (!invoice) return;
    setEntries({});
    setReasonText("");
    setNoteType("credit");
    setReason("sales_return");
    idemKey.current = newKey();
    load();
  }, [invoice, load]);

  const preview = useMemo(() => {
    let taxable = 0;
    let gst = 0;
    for (const l of lines) {
      const v = Number(entries[l.invoiceLineRef]?.taxableValue || 0);
      if (v > 0) {
        taxable += v;
        gst += Math.round(v * l.gstRate) / 100;
      }
    }
    return { taxable: Math.round(taxable * 100) / 100, gst: Math.round(gst * 100) / 100, total: Math.round((taxable + gst) * 100) / 100 };
  }, [entries, lines]);

  const setEntry = (ref: string, field: "quantity" | "taxableValue", value: string) =>
    setEntries((e) => ({ ...e, [ref]: { quantity: e[ref]?.quantity || "", taxableValue: e[ref]?.taxableValue || "", [field]: value } }));

  const fillFull = () =>
    setEntries(Object.fromEntries(lines.filter((l) => l.creditableValue > 0).map((l) => [l.invoiceLineRef, { quantity: String(l.creditableQuantity || ""), taxableValue: String(l.creditableValue) }])));

  const save = async (issueNow: boolean) => {
    if (!invoice || busy) return;
    const items = lines
      .map((l) => ({ invoiceLineRef: l.invoiceLineRef, quantity: Number(entries[l.invoiceLineRef]?.quantity || 0), taxableValue: Number(entries[l.invoiceLineRef]?.taxableValue || 0) }))
      .filter((i) => i.taxableValue > 0);
    if (!items.length) {
      toast({ title: "Enter an amount", description: "Give the taxable value to adjust on at least one line.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const { note } = await apiClient.createCreditNote({ noteType, invoiceId: invoice._id, reason, reasonText, items, idempotencyKey: idemKey.current });
      if (issueNow) {
        const issued = await apiClient.issueCreditNote(note._id);
        toast({ title: `${issued.note.noteNumber} issued`, description: `Balance on ${invoice.invoiceNumber} is now ${formatINR(issued.invoice.balanceAmount)}.` });
      } else {
        toast({ title: "Draft note saved", description: `${note.noteNumber} — issue it when it is final.` });
      }
      idemKey.current = newKey();
      setEntries({});
      setReasonText("");
      await load();
      onChanged?.();
    } catch (error) {
      toast({ title: "Note not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await run();
      toast({ title: done });
      await load();
      onChanged?.();
    } catch (error) {
      toast({ title: "Not done", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const reasons = REASONS.filter((r) => r.types.includes(noteType));

  return (
    <Dialog open={!!invoice} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Credit / debit note — {invoice?.invoiceNumber}</DialogTitle>
          <DialogDescription>
            An issued invoice is corrected with a note, never edited. A credit note lowers what the customer owes; a debit note raises it. GST is
            adjusted at each line's original rate ({isInterState ? "IGST" : "CGST + SGST"}).
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <ErrorState compact error={loadError} what="the invoice lines" onRetry={load} />
        ) : loading && !lines.length ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Note type</Label>
                <Select value={noteType} onValueChange={(v) => { setNoteType(v as "credit" | "debit"); setReason(v === "credit" ? "sales_return" : "short_charged"); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">Credit note (reduce)</SelectItem>
                    <SelectItem value="debit">Debit note (increase)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{reasons.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                {noteType === "credit" && <Button type="button" variant="outline" className="w-full" onClick={fillFull}>Credit everything left</Button>}
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Line</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">{noteType === "credit" ? "Can credit" : "Invoiced"}</th>
                    <th className="w-24 px-3 py-2 font-medium">Qty</th>
                    <th className="w-32 px-3 py-2 font-medium">Taxable value</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.invoiceLineRef} className="border-b last:border-0">
                      <td className="px-3 py-2">{l.itemName}</td>
                      <td className="num px-3 py-2 text-right">{l.gstRate}%</td>
                      <td className="num px-3 py-2 text-right">{formatINR(noteType === "credit" ? l.creditableValue : l.taxableValue)}</td>
                      <td className="px-3 py-1.5">
                        <Input aria-label={`Quantity for ${l.itemName}`} type="number" min={0} step="any" value={entries[l.invoiceLineRef]?.quantity || ""} onChange={(e) => setEntry(l.invoiceLineRef, "quantity", e.target.value)} />
                      </td>
                      <td className="px-3 py-1.5">
                        <Input aria-label={`Taxable value for ${l.itemName}`} type="number" min={0} step="0.01" value={entries[l.invoiceLineRef]?.taxableValue || ""} onChange={(e) => setEntry(l.invoiceLineRef, "taxableValue", e.target.value)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cn-reason">Details {["other", "correction"].includes(reason) && <span className="text-destructive">*</span>}</Label>
              <Textarea id="cn-reason" rows={2} maxLength={500} value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="e.g. 200 cards returned — misprint on the back" />
            </div>

            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
              <span>Taxable <span className="num font-medium">{formatINR(preview.taxable)}</span></span>
              <span>GST <span className="num font-medium">{formatINR(preview.gst)}</span></span>
              <span className="font-semibold">Note total <span className="num">{formatINR(preview.total)}</span></span>
            </div>

            {notes.length > 0 && (
              <div className="space-y-2">
                <p className="section-label">Notes on this invoice</p>
                <ul className="divide-y rounded-md border text-sm">
                  {notes.map((n) => (
                    <li key={n._id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      {n.noteType === "credit" ? <FileMinus2 className="h-4 w-4 text-muted-foreground" /> : <FilePlus2 className="h-4 w-4 text-muted-foreground" />}
                      <span className="font-mono text-xs">{n.noteNumber}</span>
                      <span className="text-muted-foreground">{formatDate(n.noteDate)}</span>
                      <StatusPill tone={n.status === "issued" ? "success" : n.status === "cancelled" ? "danger" : "neutral"}>{n.status}</StatusPill>
                      <span className="num ml-auto font-medium">{n.noteType === "credit" ? "−" : "+"}{formatINR(n.totalAmount)}</span>
                      {n.status === "draft" && (
                        <>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => apiClient.issueCreditNote(n._id), "Note issued")}>Issue</Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => apiClient.deleteCreditNote(n._id), "Draft deleted")}>Delete</Button>
                        </>
                      )}
                      {n.status === "issued" && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                          const why = window.prompt(`Why cancel ${n.noteNumber}? Its number is kept.`);
                          if (why && why.trim().length >= 3) act(() => apiClient.cancelCreditNote(n._id, why.trim()), "Note cancelled");
                        }}>Cancel</Button>
                      )}
                      <Button size="icon" variant="ghost" aria-label={`Download ${n.noteNumber}`} onClick={() => apiClient.downloadCreditNotePdf(n._id, n.noteNumber).catch((e) => toast({ title: "Download failed", description: e.message, variant: "destructive" }))}>
                        <Download className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="secondary" disabled={busy || !!loadError} onClick={() => save(false)}>Save draft</Button>
          <Button disabled={busy || !!loadError} onClick={() => save(true)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Issue {noteType === "credit" ? "credit" : "debit"} note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
