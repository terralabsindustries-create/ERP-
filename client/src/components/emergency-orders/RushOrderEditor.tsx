import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EditorSection, EditorSheet } from "@/components/users/EditorSheet";
import { RecordPicker, type PickerOption } from "@/components/delivery/RecordPicker";
import { fmtPhone, isPhone } from "@/components/delivery/deliveryMeta";
import { useToast } from "@/hooks/use-toast";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { rushOrdersApi, type CustomerOption, type RushInput, type RushOrder, type RushPriority } from "@/lib/api/rushOrders";
import { PRIORITY_LABEL, customerIdOf } from "./rushMeta";

interface Form {
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  orderDetails: string;
  estimatedAmount: string;
  advancePaid: string;
  priority: RushPriority;
  neededDate: string;
  neededTime: string;
  notes: string;
}
type Errors = Partial<Record<keyof Form, string>>;

/** Three hours from now, on the next half hour. */
function defaultNeededBy() {
  const d = new Date(Date.now() + 3 * 3600e3);
  d.setMinutes(d.getMinutes() <= 30 ? 30 : 60, 0, 0);
  return { neededDate: format(d, "yyyy-MM-dd"), neededTime: format(d, "HH:mm") };
}

const emptyForm = (): Form => ({
  customerId: "",
  customerName: "",
  customerPhone: "",
  customerEmail: "",
  orderDetails: "",
  estimatedAmount: "",
  advancePaid: "",
  priority: "urgent",
  ...defaultNeededBy(),
  notes: ""
});

const formFrom = (o: RushOrder): Form => {
  const d = o.expectedCompletion ? new Date(o.expectedCompletion) : null;
  return {
    customerId: customerIdOf(o),
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    customerEmail: o.customerEmail || "",
    orderDetails: o.orderDetails,
    estimatedAmount: String(o.estimatedAmount ?? ""),
    advancePaid: o.advancePaid ? String(o.advancePaid) : "",
    priority: o.priority || "high",
    ...(d ? { neededDate: format(d, "yyyy-MM-dd"), neededTime: format(d, "HH:mm") } : defaultNeededBy()),
    notes: o.notes || ""
  };
};

function check(f: Form): Errors {
  const e: Errors = {};
  if (!f.customerName.trim()) e.customerName = "Enter the customer's name";
  if (!isPhone(f.customerPhone)) e.customerPhone = "Enter a valid phone number";
  if (f.customerEmail.trim() && !/^\S+@\S+\.\S+$/.test(f.customerEmail.trim())) e.customerEmail = "Enter a valid email address";
  if (!f.orderDetails.trim()) e.orderDetails = "Describe what the customer needs";
  if (f.estimatedAmount === "" || !(Number(f.estimatedAmount) >= 0)) e.estimatedAmount = "Enter the estimated amount";
  if (f.advancePaid && !(Number(f.advancePaid) >= 0)) e.advancePaid = "Enter zero or more";
  else if (Number(f.advancePaid) > Number(f.estimatedAmount || 0)) e.advancePaid = "The advance is more than the estimate";
  if (!f.neededDate || !f.neededTime) e.neededDate = "Choose when it's needed by";
  return e;
}

const toInput = (f: Form): RushInput => ({
  customerId: f.customerId || undefined,
  customerName: f.customerName.trim(),
  customerPhone: f.customerPhone.trim(),
  customerEmail: f.customerEmail.trim() || undefined,
  orderDetails: f.orderDetails.trim(),
  estimatedAmount: Number(f.estimatedAmount) || 0,
  advancePaid: Number(f.advancePaid) || 0,
  priority: f.priority,
  expectedCompletion: new Date(`${f.neededDate}T${f.neededTime}`).toISOString(),
  notes: f.notes.trim() || undefined
});

function Field({ label, htmlFor, error, hint, className, children }: { label: string; htmlFor?: string; error?: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive-strong">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Take a rush order, or edit one. */
export function RushOrderEditor({ open, onOpenChange, order, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; order?: RushOrder | null; onSaved: (o: RushOrder) => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(emptyForm);
  const [errors, setErrors] = useState<Errors>({});
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const editing = !!order;

  useEffect(() => {
    if (!open) return;
    setForm(order ? formFrom(order) : emptyForm());
    setErrors({});
    setCustomersLoading(true);
    rushOrdersApi
      .customers()
      .then(setCustomers)
      .catch(() => setCustomers([]))
      .finally(() => setCustomersLoading(false));
  }, [open, order]);

  const options: PickerOption[] = useMemo(
    () => customers.map((c) => ({ id: c._id, title: c.name, subtitle: [c.company, fmtPhone(c.phone)].filter(Boolean).join(" · "), keywords: [c.phone, c.email].filter(Boolean).join(" ") })),
    [customers]
  );

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const pickCustomer = (id: string) => {
    const c = customers.find((x) => x._id === id);
    setForm((f) => ({ ...f, customerId: id, customerName: c?.name || f.customerName, customerPhone: c?.phone || f.customerPhone, customerEmail: c?.email || f.customerEmail }));
    setErrors((e) => ({ ...e, customerName: undefined, customerPhone: undefined }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problems = check(form);
    setErrors(problems);
    if (Object.values(problems).some(Boolean)) {
      toast({ title: "Check the highlighted fields", description: Object.values(problems).find(Boolean), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const saved = editing && order ? await rushOrdersApi.update(order._id, toInput(form)) : await rushOrdersApi.create(toInput(form));
      toast({ title: editing ? "Rush order updated" : "Rush order added", description: `${saved.orderId} · ${saved.customerName}` });
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      toast({ title: editing ? "Not updated" : "Not added", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const balance = (Number(form.estimatedAmount) || 0) - (Number(form.advancePaid) || 0);

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={editing ? `Edit ${order?.orderId}` : "New rush order"}
      description={editing ? order?.customerName : "Urgent work taken on the spot. Convert it to a job when it needs the full workflow."}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {editing ? "Save changes" : "Add rush order"}
          </Button>
        </>
      }
    >
      <EditorSection title="Customer" description="Pick a saved customer, or just type a name and phone number.">
        <RecordPicker
          id="ro-customer-pick"
          options={options}
          value={form.customerId}
          onChange={(id) => (id ? pickCustomer(id) : set("customerId", ""))}
          loading={customersLoading}
          placeholder="Search saved customers (optional)"
          emptyText="No saved customer matches — type the details below"
          allowClear
          searchFirst
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="ro-name" error={errors.customerName}>
            <Input id="ro-name" value={form.customerName} onChange={(e) => set("customerName", e.target.value)} autoComplete="off" aria-invalid={!!errors.customerName} />
          </Field>
          <Field label="Phone" htmlFor="ro-phone" error={errors.customerPhone}>
            <Input id="ro-phone" type="tel" inputMode="tel" value={form.customerPhone} onChange={(e) => set("customerPhone", e.target.value)} placeholder="+91 98470 00000" aria-invalid={!!errors.customerPhone} />
          </Field>
        </div>
        <Field label="Email" htmlFor="ro-email" error={errors.customerEmail}>
          <Input id="ro-email" type="email" value={form.customerEmail} onChange={(e) => set("customerEmail", e.target.value)} placeholder="Optional" />
        </Field>
      </EditorSection>

      <EditorSection title="Order">
        <Field label="What do they need?" htmlFor="ro-details" error={errors.orderDetails}>
          <Textarea id="ro-details" rows={4} value={form.orderDetails} onChange={(e) => set("orderDetails", e.target.value)} placeholder="e.g. 200 visiting cards, 350 gsm matte, both sides" aria-invalid={!!errors.orderDetails} />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Needed by" htmlFor="ro-date" error={errors.neededDate}>
            <Input id="ro-date" type="date" value={form.neededDate} onChange={(e) => set("neededDate", e.target.value)} aria-invalid={!!errors.neededDate} />
          </Field>
          <Field label="Time" htmlFor="ro-time">
            <Input id="ro-time" type="time" value={form.neededTime} onChange={(e) => set("neededTime", e.target.value)} />
          </Field>
          <Field label="Priority" htmlFor="ro-priority" className="col-span-2 sm:col-span-1">
            <Select value={form.priority} onValueChange={(v) => set("priority", v as RushPriority)}>
              <SelectTrigger id="ro-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRIORITY_LABEL) as RushPriority[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </EditorSection>

      <EditorSection title="Money">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimated amount (₹)" htmlFor="ro-amount" error={errors.estimatedAmount}>
            <Input id="ro-amount" type="number" inputMode="decimal" min={0} step="0.01" value={form.estimatedAmount} onChange={(e) => set("estimatedAmount", e.target.value)} className="num" aria-invalid={!!errors.estimatedAmount} />
          </Field>
          <Field
            label="Advance paid (₹)"
            htmlFor="ro-advance"
            error={errors.advancePaid}
            hint={Number(form.estimatedAmount) > 0 ? `Balance ${formatINR(Math.max(0, balance))}` : undefined}
          >
            <Input id="ro-advance" type="number" inputMode="decimal" min={0} step="0.01" value={form.advancePaid} onChange={(e) => set("advancePaid", e.target.value)} placeholder="0" className="num" aria-invalid={!!errors.advancePaid} />
          </Field>
        </div>
      </EditorSection>

      <EditorSection title="Notes">
        <Textarea id="ro-notes" aria-label="Notes" rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Optional" />
      </EditorSection>
    </EditorSheet>
  );
}
