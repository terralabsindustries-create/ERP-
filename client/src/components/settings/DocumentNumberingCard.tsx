import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/common/LoadState";
import { useLoader } from "@/hooks/useLoader";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";

/** Settings → Document numbering (backend routes/documentNumbering.js). Issued numbers never change. */
export function DocumentNumberingCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const cfg = useLoader((signal) => apiClient.getWithSignal<any>("/document-numbering", undefined, signal), []);
  const [form, setForm] = useState({ prefix: "INV-", reset: "monthly", padding: "4", stockItemPrefix: "STK-" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (cfg.data) setForm({ prefix: cfg.data.invoice.prefix, reset: cfg.data.invoice.reset, padding: String(cfg.data.invoice.padding), stockItemPrefix: cfg.data.stockItemPrefix });
  }, [cfg.data]);
  const period = form.reset === "financial_year" ? "2627" : "202611";
  const example = `${form.prefix}${period}-${"1".padStart(Number(form.padding) || 4, "0")}`;
  const save = async () => {
    setSaving(true);
    try {
      const res = await apiClient.put<{ example: { invoice: string } }>("/document-numbering", { invoice: { prefix: form.prefix, reset: form.reset, padding: Number(form.padding) }, stockItemPrefix: form.stockItemPrefix });
      toast({ title: "Numbering saved", description: `Next series looks like ${res?.example?.invoice}. Issued invoices keep their numbers.` });
      cfg.reload();
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Document numbering</CardTitle>
        <CardDescription>How official invoice numbers and new item codes are formed. Drafts use DRAFT-numbers; an invoice gets its number when issued.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {cfg.error && !cfg.data ? <ErrorState compact error={cfg.error} what="numbering" onRetry={cfg.reload} /> : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1"><Label htmlFor="dn-prefix">Invoice prefix</Label><Input id="dn-prefix" maxLength={8} value={form.prefix} disabled={!canEdit} onChange={(e) => setForm({ ...form, prefix: e.target.value })} /></div>
              <div className="space-y-1"><Label>Series resets</Label>
                <Select value={form.reset} onValueChange={(v) => setForm({ ...form, reset: v })} disabled={!canEdit}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="monthly">Every month</SelectItem><SelectItem value="financial_year">Every financial year</SelectItem></SelectContent></Select></div>
              <div className="space-y-1"><Label htmlFor="dn-pad">Digits</Label><Input id="dn-pad" type="number" min={3} max={6} value={form.padding} disabled={!canEdit} onChange={(e) => setForm({ ...form, padding: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="dn-sku">Item code prefix</Label><Input id="dn-sku" maxLength={8} value={form.stockItemPrefix} disabled={!canEdit} onChange={(e) => setForm({ ...form, stockItemPrefix: e.target.value })} /></div>
            </div>
            <p className="text-xs text-muted-foreground">Example: <span className="font-mono">{example}</span> ({example.length}/16 characters — GST allows at most 16, letters, digits, “-” and “/”).</p>
            {canEdit && <div className="flex justify-end"><Button onClick={save} disabled={saving}><Save className="h-4 w-4" />{saving ? "Saving..." : "Save numbering"}</Button></div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
