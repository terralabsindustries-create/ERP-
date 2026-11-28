import { useState } from "react";
import { Pause, Play, Plus, Repeat, Trash2, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { DataCard, DataTable, EntityCell, StatusPill, type Column } from "@/components/data";
import { EmptyState } from "@/components/common/EmptyState";
import { CustomerSearch, customerIdOf } from "@/components/customers/CustomerSearch";
import { useLoader } from "@/hooks/useLoader";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, localDate } from "@/lib/format";

/*
  Recurring invoices (backend services/recurringInvoices.js): a template bills
  a customer on a schedule. Each date is billed once, as a DRAFT by default —
  it then follows the normal issue flow.
*/
interface Template {
  _id: string;
  name: string;
  customerId?: { name?: string; company?: string };
  frequency: string;
  interval: number;
  nextRunDate: string;
  endDate?: string;
  status: "active" | "paused" | "cancelled" | "completed";
  generatedCount: number;
  lastError?: string | null;
  issueAutomatically?: boolean;
  items: { itemName: string; quantity: number; unitPrice: number; gstRate: number }[];
}
interface Line { itemName: string; hsnCode: string; quantity: string; unitPrice: string; gstRate: string }

const FREQ: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const TONE: Record<Template["status"], "success" | "warning" | "neutral" | "danger"> = { active: "success", paused: "warning", completed: "neutral", cancelled: "danger" };
const blankLine = (): Line => ({ itemName: "", hsnCode: "", quantity: "1", unitPrice: "", gstRate: "" });
const valueOf = (t: Template) => t.items.reduce((s, i) => s + i.quantity * i.unitPrice * (1 + i.gstRate / 100), 0);

export default function RecurringInvoices() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Invoicing: Create & Edit");
  const list = useLoader((signal) => apiClient.getWithSignal<{ templates: Template[] }>("/recurring-invoices", undefined, signal), []);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", customerId: "", frequency: "monthly", startDate: localDate(), endDate: "", dueInDays: "15", issueAutomatically: false });
  const [lines, setLines] = useState<Line[]>([blankLine()]);

  const act = async (t: Template, action: "pause" | "resume" | "cancel" | "run-now") => {
    try {
      const res = await apiClient.post<{ results?: { generated: boolean; invoiceNumber?: string; error?: string }[] }>(`/recurring-invoices/${t._id}/${action}`, {});
      const made = res?.results?.filter((r) => r.generated) || [];
      toast({ title: action === "run-now" ? `${made.length} invoice${made.length === 1 ? "" : "s"} generated` : `“${t.name}” ${action === "resume" ? "resumed" : action === "pause" ? "paused" : "cancelled"}`, description: made.map((m) => m.invoiceNumber).join(", ") || undefined });
      list.reload();
    } catch (error) {
      toast({ title: "Not done", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await apiClient.post("/recurring-invoices", {
        ...form,
        dueInDays: Number(form.dueInDays) || 0,
        endDate: form.endDate || undefined,
        items: lines.map((l) => ({ itemName: l.itemName, hsnCode: l.hsnCode || undefined, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), gstRate: l.gstRate === "" ? "" : Number(l.gstRate) })),
      });
      toast({ title: "Recurring invoice set up", description: "Drafts are raised on each date; issue them from Invoices." });
      setOpen(false);
      setLines([blankLine()]);
      setForm((f) => ({ ...f, name: "", customerId: "" }));
      list.reload();
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<Template>[] = [
    { id: "name", header: "Recurring invoice", cell: (t) => <EntityCell title={t.name} subtitle={t.customerId?.name} />, sortValue: (t) => t.name },
    { id: "freq", header: "Every", cell: (t) => `${t.interval > 1 ? `${t.interval} × ` : ""}${FREQ[t.frequency] || t.frequency}` },
    { id: "value", header: "Value incl. GST", align: "right", cell: (t) => formatINR(Math.round(valueOf(t) * 100) / 100) },
    { id: "next", header: "Next invoice", cell: (t) => (t.status === "active" || t.status === "paused" ? fmtDate(t.nextRunDate) : "—"), sortValue: (t) => t.nextRunDate },
    { id: "made", header: "Raised", align: "right", cell: (t) => t.generatedCount },
    { id: "status", header: "Status", cell: (t) => <span className="flex flex-col gap-0.5"><StatusPill tone={TONE[t.status]}>{t.status}</StatusPill>{t.lastError && <span className="text-[11px] text-destructive-strong">Last try failed: {t.lastError}</span>}{t.issueAutomatically && <span className="text-[11px] text-muted-foreground">Issues automatically</span>}</span> },
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Billing & finance"
        title="Recurring invoices"
        description="Bill retainers, AMCs and standing orders on a schedule. Each date is billed once, as a draft you issue."
        actions={canEdit && <Button onClick={() => setOpen(true)}><Plus />New recurring invoice</Button>}
      />
      <DataCard>
        <DataTable
          columns={columns}
          rows={list.data?.templates || []}
          rowKey={(t) => t._id}
          loading={list.isLoading}
          error={list.error}
          errorWhat="recurring invoices"
          onRetry={list.reload}
          actions={(t) => [
            { label: "Raise due invoices now", icon: Zap, onClick: () => act(t, "run-now"), hidden: !canEdit || t.status !== "active" || new Date(t.nextRunDate) > new Date() },
            { label: "Pause", icon: Pause, onClick: () => act(t, "pause"), hidden: !canEdit || t.status !== "active" },
            { label: "Resume", icon: Play, onClick: () => act(t, "resume"), hidden: !canEdit || t.status !== "paused" },
            { label: "Cancel", icon: XCircle, destructive: true, separated: true, onClick: () => act(t, "cancel"), hidden: !canEdit || !["active", "paused"].includes(t.status) },
          ]}
          empty={<EmptyState icon={Repeat} title="No recurring invoices" description="Set one up for a customer you bill on a schedule." />}
        />
      </DataCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New recurring invoice</DialogTitle>
            <DialogDescription>A draft invoice is raised on the start date and then on every scheduled date until the end date.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="ri-name">Name</Label><Input id="ri-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Monthly brochure retainer" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Customer</Label><CustomerSearch value={form.customerId} onSelect={(c) => setForm({ ...form, customerId: customerIdOf(c) })} /></div>
            <div className="space-y-1.5"><Label>Every</Label>
              <Select value={form.frequency} onValueChange={(v) => setForm({ ...form, frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(FREQ).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label htmlFor="ri-due">Due after (days)</Label><Input id="ri-due" type="number" min={0} value={form.dueInDays} onChange={(e) => setForm({ ...form, dueInDays: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor="ri-start">First invoice on</Label><Input id="ri-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor="ri-end">Last invoice by (optional)</Label><Input id="ri-end" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></div>
          </div>
          <div className="space-y-2">
            <Label>Lines</Label>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Input className="col-span-4" aria-label="Item" placeholder="Item" value={l.itemName} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, itemName: e.target.value } : x)))} />
                <Input className="col-span-2" aria-label="HSN/SAC" placeholder="HSN/SAC" value={l.hsnCode} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, hsnCode: e.target.value } : x)))} />
                <Input className="col-span-2" aria-label="Quantity" type="number" placeholder="Qty" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                <Input className="col-span-2" aria-label="Price" type="number" placeholder="Price" value={l.unitPrice} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
                <Input className="col-span-1" aria-label="GST %" type="number" placeholder="GST %" value={l.gstRate} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, gstRate: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" className="col-span-1" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setLines([...lines, blankLine()])}><Plus />Add line</Button>
            <p className="text-xs text-muted-foreground">Enter the GST rate on every line (0 if none) — a blank rate is not treated as 0.</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={form.issueAutomatically} onCheckedChange={(v) => setForm({ ...form, issueAutomatically: v === true })} />
            <span>Issue each invoice automatically (it gets its official number on the day). Leave off to review drafts first.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !form.name || !form.customerId}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
