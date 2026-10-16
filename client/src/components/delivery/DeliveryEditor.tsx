import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EditorSection, EditorSheet } from "@/components/users/EditorSheet";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deliveriesApi, type Delivery, type DeliveryInput, type DeliveryItem, type DeliveryPayment, type DeliveryPriority, type TimeSlot } from "@/lib/api/deliveries";
import { RecordPicker, type PickerOption } from "./RecordPicker";
import { INDIAN_STATES, PRIORITY_LABEL, TIME_SLOTS, isPhone, jobIdOf, localToday, parseAddress } from "./deliveryMeta";

interface JobOption {
  _id: string;
  title: string;
  status?: string;
  priority?: DeliveryPriority;
  customerId?: { _id: string; name: string; phone?: string; company?: string } | string | null;
  items?: { itemName: string; quantity?: number }[];
  printSpecs?: { quantity?: number };
}

interface CustomerRecord {
  _id: string;
  name: string;
  phone?: string;
  address?: string;
}

interface Form {
  jobId: string;
  street: string;
  city: string;
  state: string;
  pincode: string;
  landmark: string;
  contactName: string;
  contactPhone: string;
  deliveryDate: string;
  deliveryTimeSlot: TimeSlot;
  priority: DeliveryPriority;
  items: { description: string; quantity: string }[];
  driverName: string;
  driverPhone: string;
  vehicleNumber: string;
  deliveryFee: string;
  paymentMethod: DeliveryPayment;
  codAmount: string;
  deliveryNotes: string;
}

type Errors = Partial<Record<keyof Form | "itemsList", string>>;

const emptyForm = (): Form => ({
  jobId: "",
  street: "",
  city: "",
  state: "Kerala",
  pincode: "",
  landmark: "",
  contactName: "",
  contactPhone: "",
  deliveryDate: localToday(),
  deliveryTimeSlot: "Flexible",
  priority: "medium",
  items: [{ description: "", quantity: "1" }],
  driverName: "",
  driverPhone: "",
  vehicleNumber: "",
  deliveryFee: "",
  paymentMethod: "Prepaid",
  codAmount: "",
  deliveryNotes: ""
});

const formFrom = (d: Delivery): Form => ({
  jobId: jobIdOf(d),
  street: d.deliveryAddress?.street || "",
  city: d.deliveryAddress?.city || "",
  state: d.deliveryAddress?.state || "Kerala",
  pincode: d.deliveryAddress?.pincode || "",
  landmark: d.deliveryAddress?.landmark || "",
  contactName: d.contactInfo?.name || "",
  contactPhone: d.contactInfo?.phone || "",
  deliveryDate: d.deliveryDate.slice(0, 10),
  deliveryTimeSlot: d.deliveryTimeSlot || "Flexible",
  priority: d.priority || "medium",
  items: d.items?.length ? d.items.map((i) => ({ description: i.description, quantity: String(i.quantity || 1) })) : [{ description: "", quantity: "1" }],
  driverName: d.driverInfo?.name || "",
  driverPhone: d.driverInfo?.phone || "",
  vehicleNumber: d.driverInfo?.vehicleNumber || "",
  deliveryFee: d.charges?.deliveryFee ? String(d.charges.deliveryFee) : "",
  paymentMethod: d.paymentMethod === "COD" ? "COD" : "Prepaid",
  codAmount: d.codAmount ? String(d.codAmount) : "",
  deliveryNotes: d.deliveryNotes || ""
});

function check(f: Form): Errors {
  const e: Errors = {};
  if (!f.jobId) e.jobId = "Choose the job this delivery is for";
  if (!f.contactPhone.trim()) e.contactPhone = "Enter a phone number for the delivery";
  else if (!isPhone(f.contactPhone)) e.contactPhone = "Enter a valid phone number";
  if (!f.street.trim()) e.street = "Enter the street address";
  if (!f.city.trim()) e.city = "Enter the city";
  if (!f.state.trim()) e.state = "Choose the state";
  if (!/^\d{6}$/.test(f.pincode.trim())) e.pincode = "Pincode must be 6 digits";
  if (!f.deliveryDate) e.deliveryDate = "Choose the delivery date";
  const items = f.items.filter((i) => i.description.trim() || i.quantity !== "1");
  if (!items.length) e.itemsList = "Add at least one package";
  else if (items.some((i) => !i.description.trim())) e.itemsList = "Describe each package";
  else if (items.some((i) => !(Number.isInteger(Number(i.quantity)) && Number(i.quantity) >= 1))) e.itemsList = "Each package needs a quantity of at least 1";
  if (f.driverPhone.trim() && !isPhone(f.driverPhone)) e.driverPhone = "Enter a valid phone number";
  if (f.deliveryFee && !(Number(f.deliveryFee) >= 0)) e.deliveryFee = "Enter zero or more";
  if (f.paymentMethod === "COD" && !(Number(f.codAmount) > 0)) e.codAmount = "Enter the amount to collect";
  return e;
}

const toInput = (f: Form): DeliveryInput => ({
  jobId: f.jobId,
  deliveryAddress: { street: f.street.trim(), city: f.city.trim(), state: f.state.trim(), pincode: f.pincode.trim(), landmark: f.landmark.trim() || undefined },
  contactInfo: { name: f.contactName.trim() || undefined, phone: f.contactPhone.trim() },
  deliveryDate: f.deliveryDate,
  deliveryTimeSlot: f.deliveryTimeSlot,
  priority: f.priority,
  items: f.items.filter((i) => i.description.trim()).map((i): DeliveryItem => ({ description: i.description.trim(), quantity: Number(i.quantity) })),
  driverInfo: { name: f.driverName.trim() || undefined, phone: f.driverPhone.trim() || undefined, vehicleNumber: f.vehicleNumber.trim() || undefined },
  charges: { deliveryFee: Number(f.deliveryFee) || 0 },
  paymentMethod: f.paymentMethod,
  codAmount: f.paymentMethod === "COD" ? Number(f.codAmount) || 0 : 0,
  deliveryNotes: f.deliveryNotes.trim() || undefined
});

const customerOf = (j?: JobOption) => (j?.customerId && typeof j.customerId === "object" ? j.customerId : null);

function Field({ label, htmlFor, error, hint, className, children }: { label: string; htmlFor?: string; error?: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive-strong">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Schedule a delivery for a job, or edit one. Customer, phone and address come from the job's customer. */
export function DeliveryEditor({
  open,
  onOpenChange,
  delivery,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this delivery; leave out to schedule a new one. */
  delivery?: Delivery | null;
  onSaved: (d: Delivery) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(emptyForm);
  const [errors, setErrors] = useState<Errors>({});
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const customersRef = useRef<Promise<CustomerRecord[]> | null>(null);
  const editing = !!delivery;

  useEffect(() => {
    if (!open) return;
    setForm(delivery ? formFrom(delivery) : emptyForm());
    setErrors({});
    setJobsLoading(true);
    apiClient
      .listAll<JobOption>("/jobs", "jobs")
      .then((rows) => setJobs(rows.filter((j) => j.status !== "cancelled" || j._id === (delivery ? jobIdOf(delivery) : ""))))
      .catch((error) => {
        setJobs([]);
        toast({ title: "Jobs could not be loaded", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
      })
      .finally(() => setJobsLoading(false));
  }, [open, delivery, toast]);

  const jobOptions: PickerOption[] = useMemo(
    () =>
      jobs.map((j) => {
        const c = customerOf(j);
        return { id: j._id, title: j.title, subtitle: [c?.name, j.status && humanize(j.status)].filter(Boolean).join(" · "), keywords: [c?.company, c?.phone].filter(Boolean).join(" ") };
      }),
    [jobs]
  );
  const job = jobs.find((j) => j._id === form.jobId);
  const customer = customerOf(job);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  /** Fill the customer's details, address and the job's items in once a job is picked. */
  const pickJob = async (jobId: string) => {
    const j = jobs.find((x) => x._id === jobId);
    setForm((f) => ({ ...f, jobId }));
    setErrors((e) => ({ ...e, jobId: undefined }));
    if (!j || editing) return;
    const c = customerOf(j);
    const items = j.items?.length
      ? j.items.map((i) => ({ description: i.itemName, quantity: String(Math.max(1, Math.round(Number(i.quantity) || 1))) }))
      : [{ description: j.title, quantity: String(Math.max(1, j.printSpecs?.quantity || 1)) }];
    setForm((f) => ({ ...f, jobId, items, priority: j.priority || f.priority, contactName: c?.name || f.contactName, contactPhone: c?.phone || f.contactPhone }));
    if (!c?._id) return;
    setPrefilling(true);
    try {
      // The address used last time for this customer, else the one on their record.
      const last = await deliveriesApi.lastForCustomer(c._id);
      let address = last?.deliveryAddress;
      const contactName = last?.contactInfo?.name;
      let contactPhone = last?.contactInfo?.phone;
      if (!address) {
        // GET /customers/:id fails on the server today, so read the customer from the list.
        customersRef.current = customersRef.current || apiClient.listAll<CustomerRecord>("/customers", "customers", { status: "all" });
        const rec = (await customersRef.current).find((x) => x._id === c._id);
        address = parseAddress(rec?.address);
        contactPhone = rec?.phone || contactPhone;
      }
      setForm((f) =>
        f.jobId !== jobId
          ? f
          : {
              ...f,
              street: address?.street || "",
              city: address?.city || "",
              state: address?.state || "Kerala",
              pincode: address?.pincode || "",
              landmark: address?.landmark || "",
              contactName: contactName || f.contactName,
              contactPhone: contactPhone || f.contactPhone
            }
      );
    } catch {
      // Prefill is a convenience; the person can type the address.
      customersRef.current = null;
    } finally {
      setPrefilling(false);
    }
  };

  const setItem = (i: number, patch: Partial<Form["items"][number]>) => {
    setForm((f) => ({ ...f, items: f.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));
    if (errors.itemsList) setErrors((e) => ({ ...e, itemsList: undefined }));
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
      const saved = editing && delivery ? await deliveriesApi.update(delivery._id, toInput(form)) : await deliveriesApi.create(toInput(form));
      toast({ title: editing ? "Delivery updated" : "Delivery scheduled", description: `${saved.deliveryId} · ${saved.customerName}` });
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      toast({ title: editing ? "Not updated" : "Not scheduled", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const qty = form.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      wide
      title={editing ? `Edit ${delivery?.deliveryId}` : "Schedule a delivery"}
      description={editing ? `${delivery?.customerName}` : "Pick the job; the customer's phone and address are filled in for you."}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {editing ? "Save changes" : "Schedule delivery"}
          </Button>
        </>
      }
    >
      <EditorSection title="Job" description={editing ? undefined : "The job this delivery is for."}>
        <RecordPicker
          id="dl-job"
          options={jobOptions}
          value={form.jobId}
          onChange={pickJob}
          loading={jobsLoading}
          placeholder="Search jobs by title or customer"
          emptyText={jobs.length ? "No job matches" : "No jobs yet — create a job first"}
          invalid={!!errors.jobId}
        />
        {errors.jobId && <p className="text-xs text-destructive-strong">{errors.jobId}</p>}
        {customer && (
          <p className="text-sm text-muted-foreground">
            For <span className="font-medium text-foreground">{customer.name}</span>
            {prefilling && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" />
                Filling in the address…
              </span>
            )}
          </p>
        )}
      </EditorSection>

      <EditorSection title="Deliver to">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Contact person" htmlFor="dl-contact">
            <Input id="dl-contact" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} placeholder="Who receives it" autoComplete="off" />
          </Field>
          <Field label="Phone" htmlFor="dl-phone" error={errors.contactPhone}>
            <Input id="dl-phone" type="tel" inputMode="tel" value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} placeholder="+91 98470 00000" aria-invalid={!!errors.contactPhone} />
          </Field>
        </div>
        <Field label="Street address" htmlFor="dl-street" error={errors.street}>
          <Input id="dl-street" value={form.street} onChange={(e) => set("street", e.target.value)} placeholder="Building, street, area" aria-invalid={!!errors.street} />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="City" htmlFor="dl-city" error={errors.city}>
            <Input id="dl-city" value={form.city} onChange={(e) => set("city", e.target.value)} aria-invalid={!!errors.city} />
          </Field>
          <Field label="Pincode" htmlFor="dl-pin" error={errors.pincode}>
            <Input
              id="dl-pin"
              inputMode="numeric"
              maxLength={6}
              value={form.pincode}
              onChange={(e) => set("pincode", e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="682011"
              aria-invalid={!!errors.pincode}
            />
          </Field>
          <Field label="State" htmlFor="dl-state" error={errors.state} className="col-span-2 sm:col-span-1">
            <Select value={form.state} onValueChange={(v) => set("state", v)}>
              <SelectTrigger id="dl-state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(INDIAN_STATES.includes(form.state) ? INDIAN_STATES : [form.state, ...INDIAN_STATES]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Landmark" htmlFor="dl-landmark">
          <Input id="dl-landmark" value={form.landmark} onChange={(e) => set("landmark", e.target.value)} placeholder="Optional, e.g. opposite the bus stand" />
        </Field>
      </EditorSection>

      <EditorSection title="When">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Date" htmlFor="dl-date" error={errors.deliveryDate}>
            <Input id="dl-date" type="date" value={form.deliveryDate} onChange={(e) => set("deliveryDate", e.target.value)} aria-invalid={!!errors.deliveryDate} />
          </Field>
          <Field label="Time slot" htmlFor="dl-slot">
            <Select value={form.deliveryTimeSlot} onValueChange={(v) => set("deliveryTimeSlot", v as TimeSlot)}>
              <SelectTrigger id="dl-slot">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_SLOTS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Priority" htmlFor="dl-priority" className="col-span-2 sm:col-span-1">
            <Select value={form.priority} onValueChange={(v) => set("priority", v as DeliveryPriority)}>
              <SelectTrigger id="dl-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRIORITY_LABEL) as DeliveryPriority[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </EditorSection>

      <EditorSection title="Packages" description="What goes out with this delivery. It's listed on the challan.">
        <div className="space-y-2">
          {form.items.map((it, i) => (
            <div key={i} className="flex items-start gap-2">
              <Input
                aria-label={`Package ${i + 1} description`}
                value={it.description}
                onChange={(e) => setItem(i, { description: e.target.value })}
                placeholder="e.g. Visiting cards, 2 boxes"
                className="min-w-0 flex-1"
              />
              <Input
                aria-label={`Package ${i + 1} quantity`}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={it.quantity}
                onChange={(e) => setItem(i, { quantity: e.target.value })}
                className="num w-20 shrink-0 sm:w-24"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground"
                aria-label={`Remove package ${i + 1}`}
                disabled={form.items.length === 1}
                onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }))}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="subtle" size="sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, { description: "", quantity: "1" }] }))}>
            <Plus />
            Add package
          </Button>
          <span className="num text-xs text-muted-foreground">{qty > 0 ? `${qty.toLocaleString("en-IN")} in total` : ""}</span>
        </div>
        {errors.itemsList && <p className="text-xs text-destructive-strong">{errors.itemsList}</p>}
      </EditorSection>

      <EditorSection title="Driver" description="Optional now — you can add the driver when you dispatch.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" htmlFor="dl-driver">
            <Input id="dl-driver" value={form.driverName} onChange={(e) => set("driverName", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Phone" htmlFor="dl-driver-phone" error={errors.driverPhone}>
            <Input id="dl-driver-phone" type="tel" inputMode="tel" value={form.driverPhone} onChange={(e) => set("driverPhone", e.target.value)} aria-invalid={!!errors.driverPhone} />
          </Field>
          <Field label="Vehicle no." htmlFor="dl-vehicle">
            <Input id="dl-vehicle" value={form.vehicleNumber} onChange={(e) => set("vehicleNumber", e.target.value.toUpperCase())} placeholder="KL 07 AB 1234" />
          </Field>
        </div>
      </EditorSection>

      <EditorSection title="Charges and payment">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Delivery charge (₹)" htmlFor="dl-fee" error={errors.deliveryFee}>
            <Input id="dl-fee" type="number" inputMode="decimal" min={0} step="0.01" value={form.deliveryFee} onChange={(e) => set("deliveryFee", e.target.value)} placeholder="0" className="num" />
          </Field>
          <Field label="Payment" htmlFor="dl-pay">
            <Select value={form.paymentMethod} onValueChange={(v) => set("paymentMethod", v as DeliveryPayment)}>
              <SelectTrigger id="dl-pay">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Prepaid">Prepaid</SelectItem>
                <SelectItem value="COD">Cash on delivery</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.paymentMethod === "COD" && (
            <Field label="Collect on delivery (₹)" htmlFor="dl-cod" error={errors.codAmount} hint={Number(form.codAmount) > 0 ? `Driver collects ${formatINR(Number(form.codAmount))}` : undefined} className="col-span-2 sm:col-span-1">
              <Input id="dl-cod" type="number" inputMode="decimal" min={0} step="0.01" value={form.codAmount} onChange={(e) => set("codAmount", e.target.value)} className="num" aria-invalid={!!errors.codAmount} />
            </Field>
          )}
        </div>
      </EditorSection>

      <EditorSection title="Notes">
        <Textarea id="dl-notes" aria-label="Notes" rows={3} value={form.deliveryNotes} onChange={(e) => set("deliveryNotes", e.target.value)} placeholder="Optional — directions, gate code, who to ask for" />
      </EditorSection>
    </EditorSheet>
  );
}
