import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { BadgePercent, Loader2, Pencil, Plus, Power, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { EditorSheet, EditorSection } from "@/components/users/EditorSheet";
import { ConfirmDialog, DataCard, DataTable, EntityCell, MetricBar, SearchField, Stack, StatusPill, Toolbar, ViewTabs, type Column, type PillTone } from "@/components/data";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { fmtDate, formatINR, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

type Audience = "all" | "new" | "returning" | "specific";

interface Rule {
  _id: string;
  name: string;
  type: "percentage" | "fixed" | "bulk";
  value: number;
  minimumAmount?: number;
  maximumAmount?: number;
  customerType: Audience;
  customerIds?: { _id: string; name: string }[];
  validFrom?: string;
  validUntil?: string;
  isActive: boolean;
  description?: string;
}

interface Rate {
  _id: string;
  customerId?: { _id: string; name: string; phone?: string } | null;
  customerName: string;
  discountPercentage: number;
  validFrom?: string;
  validUntil?: string;
  isActive: boolean;
  notes?: string;
}

interface CustomerOption {
  _id: string;
  name: string;
  phone?: string;
}

type View = "rules" | "rates";
type State = "on" | "scheduled" | "ended" | "off";

const AUDIENCE: Record<Audience, string> = { all: "Every customer", new: "New customers", returning: "Returning customers", specific: "Chosen customers" };
const STATE: Record<State, { label: string; tone: PillTone }> = {
  on: { label: "On", tone: "success" },
  scheduled: { label: "Starts later", tone: "info" },
  ended: { label: "Ended", tone: "neutral" },
  off: { label: "Off", tone: "neutral" }
};

const stateOf = (r: { isActive: boolean; validFrom?: string; validUntil?: string }): State => {
  if (!r.isActive) return "off";
  const now = Date.now();
  if (r.validFrom && new Date(r.validFrom).getTime() > now) return "scheduled";
  if (r.validUntil && new Date(r.validUntil).getTime() < now) return "ended";
  return "on";
};
const offerLabel = (r: Rule) => (r.type === "fixed" ? `${formatINR(r.value)} off` : `${r.value}% off`);
const dateSpan = (from?: string, until?: string) => (until ? `${fmtDate(from)} – ${fmtDate(until)}` : from && new Date(from).getTime() > Date.now() ? `From ${fmtDate(from)}` : "No end date");
const ymd = (d?: string) => (d ? format(new Date(d), "yyyy-MM-dd") : "");

const EMPTY_RULE = { name: "", type: "percentage" as "percentage" | "fixed", value: "", minimumAmount: "", maximumAmount: "", customerType: "all" as Audience, customerIds: [] as string[], validFrom: format(new Date(), "yyyy-MM-dd"), validUntil: "", isActive: true, description: "" };
const EMPTY_RATE = { customerId: "", discountPercentage: "", validFrom: format(new Date(), "yyyy-MM-dd"), validUntil: "", isActive: true, notes: "" };

export default function Discounts() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("Discounts: Create & Edit");
  const canDelete = hasPermission("Discounts: Delete");

  const [view, setView] = useState<View>("rules");
  const [rules, setRules] = useState<Rule[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");

  const [ruleEditor, setRuleEditor] = useState<{ open: boolean; rule: Rule | null }>({ open: false, rule: null });
  const [ruleForm, setRuleForm] = useState(EMPTY_RULE);
  const [rateEditor, setRateEditor] = useState<{ open: boolean; rate: Rate | null }>({ open: false, rate: null });
  const [rateForm, setRateForm] = useState(EMPTY_RATE);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ kind: "rule"; item: Rule } | { kind: "rate"; item: Rate } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, p] = (await Promise.all([apiClient.get("/discounts/rules"), apiClient.get("/discounts/customer-pricing")])) as [{ discountRules?: Rule[] }, { customerPricing?: Rate[] }];
      setRules(r?.discountRules || []);
      setRates(p?.customerPricing || []);
    } catch (error) {
      toast({ title: "Discounts could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const loadCustomers = async () => {
    if (customers.length) return;
    try {
      setCustomers(await apiClient.listAll<CustomerOption>("/customers", "customers", { status: "all" }));
    } catch {
      setCustomers([]);
    }
  };

  const openRule = (rule: Rule | null) => {
    setRuleForm(
      rule
        ? {
            name: rule.name,
            type: rule.type === "fixed" ? "fixed" : "percentage",
            value: String(rule.value),
            minimumAmount: rule.minimumAmount ? String(rule.minimumAmount) : "",
            maximumAmount: rule.maximumAmount ? String(rule.maximumAmount) : "",
            customerType: rule.customerType || "all",
            customerIds: (rule.customerIds || []).map((c) => c._id),
            validFrom: ymd(rule.validFrom) || format(new Date(), "yyyy-MM-dd"),
            validUntil: ymd(rule.validUntil),
            isActive: rule.isActive,
            description: rule.description || ""
          }
        : EMPTY_RULE
    );
    setCustomerQuery("");
    setRuleEditor({ open: true, rule });
    loadCustomers();
  };

  const openRate = (rate: Rate | null) => {
    setRateForm(
      rate
        ? {
            customerId: rate.customerId?._id || "",
            discountPercentage: String(rate.discountPercentage),
            validFrom: ymd(rate.validFrom) || format(new Date(), "yyyy-MM-dd"),
            validUntil: ymd(rate.validUntil),
            isActive: rate.isActive,
            notes: rate.notes || ""
          }
        : EMPTY_RATE
    );
    setRateEditor({ open: true, rate });
    loadCustomers();
  };

  const saveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const payload = {
      ...ruleForm,
      value: Number(ruleForm.value),
      minimumAmount: ruleForm.minimumAmount ? Number(ruleForm.minimumAmount) : undefined,
      maximumAmount: ruleForm.type === "percentage" && ruleForm.maximumAmount ? Number(ruleForm.maximumAmount) : undefined,
      customerIds: ruleForm.customerType === "specific" ? ruleForm.customerIds : []
    };
    try {
      if (ruleEditor.rule) await apiClient.put(`/discounts/rules/${ruleEditor.rule._id}`, payload);
      else await apiClient.post("/discounts/rules", payload);
      toast({ title: ruleEditor.rule ? "Discount rule updated" : "Discount rule added", description: payload.name });
      setRuleEditor({ open: false, rule: null });
      load();
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saveRate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const payload = { ...rateForm, discountPercentage: Number(rateForm.discountPercentage) };
    try {
      if (rateEditor.rate) await apiClient.put(`/discounts/customer-pricing/${rateEditor.rate._id}`, payload);
      else await apiClient.post("/discounts/customer-pricing", payload);
      toast({ title: rateEditor.rate ? "Customer rate updated" : "Customer rate added" });
      setRateEditor({ open: false, rate: null });
      load();
    } catch (error) {
      toast({ title: "Not saved", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (r: Rule) => {
    try {
      await apiClient.setDiscountRuleActive(r._id, !r.isActive);
      toast({ title: `${r.name} turned ${r.isActive ? "off" : "on"}` });
      load();
    } catch (error) {
      toast({ title: "Not changed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      if (deleting.kind === "rule") await apiClient.delete(`/discounts/rules/${deleting.item._id}`);
      else await apiClient.delete(`/discounts/customer-pricing/${deleting.item._id}`);
      toast({ title: deleting.kind === "rule" ? "Discount rule deleted" : "Customer rate removed" });
      setDeleting(null);
      load();
    } catch (error) {
      toast({ title: "Not deleted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      throw error;
    }
  };

  const q = search.trim().toLowerCase();
  const ruleRows = useMemo(() => rules.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)), [rules, q]);
  const rateRows = useMemo(() => rates.filter((r) => !q || r.customerName.toLowerCase().includes(q)), [rates, q]);
  const activeRules = rules.filter((r) => stateOf(r) === "on").length;
  const activeRates = rates.filter((r) => stateOf(r) === "on").length;
  const bestRate = rates.filter((r) => stateOf(r) === "on").sort((a, b) => b.discountPercentage - a.discountPercentage)[0];

  const ruleColumns: Column<Rule>[] = [
    { id: "name", header: "Discount", cell: (r) => <EntityCell icon={BadgePercent} title={r.name} subtitle={r.description} />, sortValue: (r) => r.name.toLowerCase(), className: "min-w-[220px]" },
    {
      id: "offer",
      header: "Offer",
      cell: (r) => (
        <Stack
          top={<span className="font-medium">{offerLabel(r)}</span>}
          bottom={[r.minimumAmount ? `on orders over ${formatINR(r.minimumAmount)}` : "", r.maximumAmount && r.type !== "fixed" ? `up to ${formatINR(r.maximumAmount)}` : ""].filter(Boolean).join(", ") || "Any order"}
        />
      )
    },
    {
      id: "who",
      header: "For",
      cell: (r) => (
        <Stack top={AUDIENCE[r.customerType] || AUDIENCE.all} bottom={r.customerType === "specific" ? (r.customerIds || []).map((c) => c.name).slice(0, 3).join(", ") + ((r.customerIds || []).length > 3 ? ` +${(r.customerIds || []).length - 3}` : "") : undefined} />
      ),
      hideBelow: "md"
    },
    { id: "dates", header: "Runs", cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{dateSpan(r.validFrom, r.validUntil)}</span>, hideBelow: "lg" },
    { id: "state", header: "Status", cell: (r) => <StatusPill tone={STATE[stateOf(r)].tone}>{STATE[stateOf(r)].label}</StatusPill>, sortValue: (r) => stateOf(r), className: "w-[120px]" }
  ];

  const rateColumns: Column<Rate>[] = [
    { id: "customer", header: "Customer", cell: (r) => <EntityCell avatar={r.customerName} title={r.customerName} subtitle={r.customerId?.phone} />, sortValue: (r) => r.customerName.toLowerCase(), className: "min-w-[220px]" },
    { id: "discount", header: "Discount", align: "right", cell: (r) => <span className="font-semibold">{r.discountPercentage}%</span>, sortValue: (r) => r.discountPercentage },
    { id: "dates", header: "Runs", cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{dateSpan(r.validFrom, r.validUntil)}</span>, hideBelow: "md" },
    { id: "notes", header: "Notes", cell: (r) => <span className="block max-w-[240px] truncate text-muted-foreground">{r.notes || "—"}</span>, hideBelow: "lg" },
    { id: "state", header: "Status", cell: (r) => <StatusPill tone={STATE[stateOf(r)].tone}>{STATE[stateOf(r)].label}</StatusPill>, className: "w-[120px]" }
  ];

  const pickable = customers.filter((c) => !customerQuery || c.name.toLowerCase().includes(customerQuery.toLowerCase()) || (c.phone || "").includes(customerQuery));
  const ratedCustomers = new Set(rates.map((r) => r.customerId?._id));

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow="Sales & estimating"
        title="Discounts"
        description="Offers and standing customer rates. When you make an invoice, the best one for that customer is suggested."
        actions={
          canEdit && (
            <Button onClick={() => (view === "rules" ? openRule(null) : openRate(null))}>
              <Plus />
              {view === "rules" ? "New discount" : "New customer rate"}
            </Button>
          )
        }
      />

      <MetricBar
        loading={loading}
        metrics={[
          { label: "Discounts on", value: activeRules, hint: plural(rules.length, "rule"), onClick: () => setView("rules"), active: view === "rules" },
          { label: "Customer rates", value: activeRates, hint: `${plural(rates.length, "customer")} with a rate`, onClick: () => setView("rates"), active: view === "rates" },
          { label: "Starting later", value: rules.filter((r) => stateOf(r) === "scheduled").length, hint: "Scheduled offers" },
          { label: "Highest rate", value: bestRate ? `${bestRate.discountPercentage}%` : "—", hint: bestRate?.customerName || "No customer rates" }
        ]}
      />

      <div className="space-y-4">
        <ViewTabs<View>
          value={view}
          onChange={setView}
          tabs={[
            { value: "rules", label: "Discount rules", icon: BadgePercent, count: rules.length },
            { value: "rates", label: "Customer rates", icon: UserRound, count: rates.length }
          ]}
        />

        <DataCard toolbar={<Toolbar search={<SearchField value={search} onChange={setSearch} placeholder={view === "rules" ? "Search discounts" : "Search customers"} />} />}>
          {view === "rules" ? (
            <DataTable
              columns={ruleColumns}
              rows={ruleRows}
              rowKey={(r) => r._id}
              loading={loading}
              onRowClick={canEdit ? (r) => openRule(r) : undefined}
              actions={(r) => [
                { label: "Edit", icon: Pencil, onClick: () => openRule(r), hidden: !canEdit },
                { label: r.isActive ? "Turn off" : "Turn on", icon: Power, onClick: () => toggleRule(r), hidden: !canEdit },
                { label: "Delete", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting({ kind: "rule", item: r }), hidden: !canDelete }
              ]}
              actionsLabel={(r) => `Actions for ${r.name}`}
              mobile={(r) => (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{r.name}</span>
                    <StatusPill tone={STATE[stateOf(r)].tone}>{STATE[stateOf(r)].label}</StatusPill>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {offerLabel(r)} · {AUDIENCE[r.customerType] || AUDIENCE.all}
                    {r.minimumAmount ? ` · over ${formatINR(r.minimumAmount)}` : ""}
                  </div>
                </div>
              )}
              empty={
                <EmptyState
                  icon={BadgePercent}
                  title={q ? "No discounts match" : "No discount rules yet"}
                  description={q ? undefined : "For example: 10% off orders over ₹5,000, or ₹200 off a customer's first order."}
                  action={
                    canEdit &&
                    !q && (
                      <Button onClick={() => openRule(null)}>
                        <Plus />
                        New discount
                      </Button>
                    )
                  }
                />
              }
            />
          ) : (
            <DataTable
              columns={rateColumns}
              rows={rateRows}
              rowKey={(r) => r._id}
              loading={loading}
              onRowClick={canEdit ? (r) => openRate(r) : undefined}
              actions={(r) => [
                { label: "Edit", icon: Pencil, onClick: () => openRate(r), hidden: !canEdit },
                { label: "Remove", icon: Trash2, destructive: true, separated: true, onClick: () => setDeleting({ kind: "rate", item: r }), hidden: !canDelete }
              ]}
              actionsLabel={(r) => `Actions for ${r.customerName}`}
              mobile={(r) => (
                <div className="flex items-center justify-between gap-3">
                  <EntityCell avatar={r.customerName} title={r.customerName} subtitle={dateSpan(r.validFrom, r.validUntil)} />
                  <span className="num font-semibold">{r.discountPercentage}%</span>
                </div>
              )}
              empty={
                <EmptyState
                  icon={UserRound}
                  title={q ? "No customers match" : "No customer rates yet"}
                  description={q ? undefined : "Give a regular customer a standing discount; it's suggested on every invoice for them."}
                  action={
                    canEdit &&
                    !q && (
                      <Button onClick={() => openRate(null)}>
                        <Plus />
                        New customer rate
                      </Button>
                    )
                  }
                />
              }
            />
          )}
        </DataCard>
      </div>

      <EditorSheet
        open={ruleEditor.open}
        onOpenChange={(open) => setRuleEditor((s) => ({ ...s, open }))}
        title={ruleEditor.rule ? "Edit discount" : "New discount"}
        description="Suggested on invoices whenever it applies."
        onSubmit={saveRule}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setRuleEditor({ open: false, rule: null })}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {ruleEditor.rule ? "Save changes" : "Add discount"}
            </Button>
          </>
        }
      >
        <EditorSection title="Offer">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input id="rule-name" value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} placeholder="e.g. Wedding season 10%" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-type">Kind</Label>
              <Select value={ruleForm.type} onValueChange={(v) => setRuleForm({ ...ruleForm, type: v as "percentage" | "fixed" })}>
                <SelectTrigger id="rule-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">% off the order</SelectItem>
                  <SelectItem value="fixed">₹ off the order</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-value">{ruleForm.type === "percentage" ? "Discount (%)" : "Discount (₹)"}</Label>
              <Input id="rule-value" type="number" inputMode="decimal" min="0" max={ruleForm.type === "percentage" ? 100 : undefined} value={ruleForm.value} onChange={(e) => setRuleForm({ ...ruleForm, value: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-min">Minimum order (₹)</Label>
              <Input id="rule-min" type="number" inputMode="decimal" min="0" value={ruleForm.minimumAmount} onChange={(e) => setRuleForm({ ...ruleForm, minimumAmount: e.target.value })} placeholder="Any amount" />
            </div>
            {ruleForm.type === "percentage" && (
              <div className="space-y-1.5">
                <Label htmlFor="rule-max">Maximum discount (₹)</Label>
                <Input id="rule-max" type="number" inputMode="decimal" min="0" value={ruleForm.maximumAmount} onChange={(e) => setRuleForm({ ...ruleForm, maximumAmount: e.target.value })} placeholder="No limit" />
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rule-desc">Note</Label>
            <Textarea id="rule-desc" rows={2} value={ruleForm.description} onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })} placeholder="Optional — shown to your team" />
          </div>
        </EditorSection>

        <EditorSection title="Who gets it">
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Who gets it">
            {(Object.keys(AUDIENCE) as Audience[]).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={ruleForm.customerType === a}
                onClick={() => setRuleForm({ ...ruleForm, customerType: a })}
                className={cn("rounded-md border px-3 py-2 text-left text-[13px] transition-colors", ruleForm.customerType === a ? "border-primary bg-primary-soft/40 font-medium" : "hover:bg-muted")}
              >
                {AUDIENCE[a]}
              </button>
            ))}
          </div>
          {ruleForm.customerType === "new" && <p className="text-xs text-muted-foreground">Customers with no invoice yet.</p>}
          {ruleForm.customerType === "specific" && (
            <div className="space-y-2">
              <Input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} placeholder="Search customers" aria-label="Search customers" />
              <div className="max-h-56 overflow-y-auto rounded-md border">
                {pickable.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">{customers.length ? "No customers match" : "Loading customers…"}</p>
                ) : (
                  pickable.slice(0, 200).map((c) => {
                    const checked = ruleForm.customerIds.includes(c._id);
                    return (
                      <label key={c._id} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/50">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => setRuleForm((f) => ({ ...f, customerIds: v ? [...f.customerIds, c._id] : f.customerIds.filter((id) => id !== c._id) }))}
                        />
                        <span className="truncate">{c.name}</span>
                        {c.phone && <span className="ml-auto text-xs text-muted-foreground">{c.phone}</span>}
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-xs text-muted-foreground">{plural(ruleForm.customerIds.length, "customer")} chosen</p>
            </div>
          )}
        </EditorSection>

        <EditorSection title="When">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-from">Starts</Label>
              <Input id="rule-from" type="date" value={ruleForm.validFrom} onChange={(e) => setRuleForm({ ...ruleForm, validFrom: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-until">Ends</Label>
              <Input id="rule-until" type="date" min={ruleForm.validFrom || undefined} value={ruleForm.validUntil} onChange={(e) => setRuleForm({ ...ruleForm, validUntil: e.target.value })} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="rule-active" className="font-normal">
              Turned on
            </Label>
            <Switch id="rule-active" checked={ruleForm.isActive} onCheckedChange={(v) => setRuleForm({ ...ruleForm, isActive: v })} />
          </div>
        </EditorSection>
      </EditorSheet>

      <EditorSheet
        open={rateEditor.open}
        onOpenChange={(open) => setRateEditor((s) => ({ ...s, open }))}
        title={rateEditor.rate ? `Rate for ${rateEditor.rate.customerName}` : "New customer rate"}
        description="A standing discount for one customer, suggested on their invoices."
        onSubmit={saveRate}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setRateEditor({ open: false, rate: null })}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {rateEditor.rate ? "Save changes" : "Add rate"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {!rateEditor.rate && (
            <div className="space-y-1.5">
              <Label htmlFor="rate-customer">Customer</Label>
              <Select value={rateForm.customerId} onValueChange={(v) => setRateForm({ ...rateForm, customerId: v })}>
                <SelectTrigger id="rate-customer">
                  <SelectValue placeholder={customers.length ? "Choose a customer" : "Loading customers…"} />
                </SelectTrigger>
                <SelectContent>
                  {customers
                    .filter((c) => !ratedCustomers.has(c._id))
                    .map((c) => (
                      <SelectItem key={c._id} value={c._id}>
                        {c.name}
                        {c.phone ? ` · ${c.phone}` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="rate-pct">Discount (%)</Label>
            <Input id="rate-pct" type="number" inputMode="decimal" min="0" max="100" value={rateForm.discountPercentage} onChange={(e) => setRateForm({ ...rateForm, discountPercentage: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rate-from">Starts</Label>
              <Input id="rate-from" type="date" value={rateForm.validFrom} onChange={(e) => setRateForm({ ...rateForm, validFrom: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-until">Ends</Label>
              <Input id="rate-until" type="date" min={rateForm.validFrom || undefined} value={rateForm.validUntil} onChange={(e) => setRateForm({ ...rateForm, validUntil: e.target.value })} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
            <Label htmlFor="rate-active" className="font-normal">
              Turned on
            </Label>
            <Switch id="rate-active" checked={rateForm.isActive} onCheckedChange={(v) => setRateForm({ ...rateForm, isActive: v })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate-notes">Notes</Label>
            <Textarea id="rate-notes" rows={2} value={rateForm.notes} onChange={(e) => setRateForm({ ...rateForm, notes: e.target.value })} placeholder="Optional" />
          </div>
        </div>
      </EditorSheet>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting?.kind === "rule" ? `Delete ${deleting.item.name}?` : `Remove ${deleting?.item.customerName}'s rate?`}
        description="It won't be suggested on new invoices. Invoices already made keep their discount."
        confirmLabel={deleting?.kind === "rule" ? "Delete" : "Remove"}
        onConfirm={remove}
      />
    </PageShell>
  );
}
