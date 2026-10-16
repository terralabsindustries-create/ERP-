import { useEffect, useMemo, useState } from "react";
import { Check, Link2, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EditorSection, EditorSheet } from "@/components/users/EditorSheet";
import { useToast } from "@/hooks/use-toast";
import {
  counterJobsApi,
  customersApi,
  phoneKey,
  type ColorMode,
  type CounterJob,
  type CounterJobInput,
  type CounterJobType,
  type CounterPaymentMethod,
  type CounterPriority,
  type CustomerLite,
  type Finishing,
  type Sides
} from "@/lib/api/walkIn";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { COLOR_LABEL, FINISHING_LABEL, JOB_TYPE_LABEL, METHOD_LABEL, PRIORITY_META, SIDES_LABEL, errorText, fmtPhone } from "./counterJobMeta";

interface Form {
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  jobType: CounterJobType;
  description: string;
  quantity: string;
  copies: string;
  paperSize: string;
  paperType: string;
  colorMode: ColorMode;
  sides: Sides;
  finishing: Finishing[];
  specialInstructions: string;
  priority: CounterPriority;
  promisedAt: string;
  estimatedCost: string;
  advancePaid: string;
  advanceMethod: CounterPaymentMethod;
  notes: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A Date as the value of a datetime-local input, in local time. */
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const inMinutes = (m: number) => {
  const d = new Date(Date.now() + m * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return toLocalInput(d);
};
const tomorrowAt = (h: number) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  return toLocalInput(d);
};

const emptyForm = (): Form => ({
  customerId: "",
  customerName: "",
  customerPhone: "",
  customerEmail: "",
  jobType: "printing",
  description: "",
  quantity: "1",
  copies: "1",
  paperSize: "",
  paperType: "",
  colorMode: "black_white",
  sides: "single",
  finishing: [],
  specialInstructions: "",
  priority: "medium",
  promisedAt: inMinutes(60),
  estimatedCost: "",
  advancePaid: "",
  advanceMethod: "cash",
  notes: ""
});

const fromJob = (j: CounterJob): Form => ({
  customerId: j.customerId || "",
  customerName: j.customerName,
  customerPhone: fmtPhone(j.customerPhone),
  customerEmail: j.customerEmail || "",
  jobType: j.jobType,
  description: j.description,
  quantity: String(j.specifications.quantity || 1),
  copies: String(j.specifications.copies || 1),
  paperSize: j.specifications.paperSize || "",
  paperType: j.specifications.paperType || "",
  colorMode: j.specifications.colorMode || "black_white",
  sides: j.specifications.sides || "single",
  finishing: j.specifications.finishing || [],
  specialInstructions: j.specifications.specialInstructions || "",
  priority: j.timeline.priority,
  promisedAt: toLocalInput(new Date(j.timeline.estimatedCompletion)),
  estimatedCost: j.pricing.estimatedCost ? String(j.pricing.estimatedCost) : "",
  advancePaid: j.pricing.advancePaid ? String(j.pricing.advancePaid) : "",
  advanceMethod: j.pricing.advanceMethod || "cash",
  notes: j.notes || ""
});

const PAPER_SIZES = ["A4", "A3", "A5", "Letter", "Legal", "12 × 18 in", "Visiting card", "ID card"];

/** Problems that would make the server refuse the job, in the order of the form. */
function problems(f: Form) {
  if (!f.customerName.trim()) return "Enter the customer's name.";
  if (!/^[6-9]\d{9}$/.test(phoneKey(f.customerPhone)) || f.customerPhone.replace(/\D/g, "").length > 12) return "Enter a 10-digit mobile number.";
  if (f.customerEmail.trim() && !/^\S+@\S+\.\S+$/.test(f.customerEmail.trim())) return "Enter a valid email address.";
  if (!f.description.trim()) return "Describe the job.";
  if (!(Number(f.quantity) >= 1) || !Number.isInteger(Number(f.quantity))) return "Quantity must be a whole number, at least 1.";
  if (f.copies && (!(Number(f.copies) >= 1) || !Number.isInteger(Number(f.copies)))) return "Copies must be a whole number, at least 1.";
  if (!f.promisedAt || Number.isNaN(new Date(f.promisedAt).getTime())) return "Choose when the job is promised.";
  if (f.estimatedCost && !(Number(f.estimatedCost) >= 0)) return "Price must be 0 or more.";
  if (f.advancePaid && !(Number(f.advancePaid) >= 0)) return "Advance must be 0 or more.";
  if (Number(f.advancePaid || 0) > Number(f.estimatedCost || 0)) return "The advance can't be more than the price.";
  return "";
}

const toInput = (f: Form): CounterJobInput => ({
  customerId: f.customerId || undefined,
  customerName: f.customerName.trim(),
  customerPhone: phoneKey(f.customerPhone),
  customerEmail: f.customerEmail.trim() || undefined,
  jobType: f.jobType,
  description: f.description.trim(),
  specifications: {
    quantity: Number(f.quantity),
    copies: Number(f.copies) || 1,
    paperSize: f.paperSize.trim(),
    paperType: f.paperType.trim(),
    colorMode: f.colorMode,
    sides: f.sides,
    finishing: f.finishing,
    specialInstructions: f.specialInstructions.trim()
  },
  timeline: { estimatedCompletion: new Date(f.promisedAt).toISOString(), priority: f.priority },
  pricing: { estimatedCost: Number(f.estimatedCost) || 0, advancePaid: Number(f.advancePaid) || 0, advanceMethod: f.advanceMethod },
  notes: f.notes.trim()
});

/** Take a new counter job, or edit one. */
export function CounterJobEditor({
  open,
  job,
  onOpenChange,
  onSaved
}: {
  open: boolean;
  /** The job to edit; leave out to take a new one. */
  job?: CounterJob | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (job: CounterJob, created: boolean) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form>(emptyForm);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(job ? fromJob(job) : emptyForm());
    setError("");
    customersApi
      .all()
      .then(setCustomers)
      .catch(() => setCustomers([]));
  }, [open, job]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError("");
  };

  const linked = customers.find((c) => c._id === form.customerId) || null;
  // A customer already in the list with the phone typed, offered for linking.
  const match = useMemo(() => {
    const key = phoneKey(form.customerPhone);
    if (form.customerId || key.length !== 10) return null;
    return customers.find((c) => phoneKey(c.phone) === key) || null;
  }, [customers, form.customerPhone, form.customerId]);

  const link = (c: CustomerLite) => {
    setForm((f) => ({ ...f, customerId: c._id, customerName: c.name, customerPhone: c.phone ? fmtPhone(c.phone) : f.customerPhone, customerEmail: c.email || f.customerEmail }));
    setPickerOpen(false);
    setError("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = problems(form);
    if (problem) return setError(problem);
    setSaving(true);
    try {
      const saved = job ? await counterJobsApi.update(job._id, toInput(form)) : await counterJobsApi.create(toInput(form));
      toast({ title: job ? "Job updated" : `Job ${saved.jobNumber} taken`, description: job ? undefined : "It's waiting in the queue." });
      onSaved(saved, !job);
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err) || "The job could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const balance = Math.max(0, (Number(form.estimatedCost) || 0) - (Number(form.advancePaid) || 0));
  const billed = !!(job?.billing?.invoice || job?.billing?.invoiceNumber);

  return (
    <EditorSheet
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={job ? `Edit ${job.jobNumber}` : "New counter job"}
      description={job ? "Changes keep the job where it is in the queue." : "Taken at the counter. It joins the queue as waiting."}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {job ? "Save changes" : "Take job"}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive-strong sm:order-first sm:mr-auto">
              {error}
            </p>
          )}
        </>
      }
    >
      <EditorSection title="Customer">
        <div className="flex flex-wrap items-center gap-2">
          {linked ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                Linked to <span className="font-medium">{linked.name}</span> in Customers
              </span>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => set("customerId", "")} aria-label="Unlink customer">
                <X />
              </Button>
            </div>
          ) : (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen} modal>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={!customers.length}>
                  <UserRound />
                  {customers.length ? "Pick an existing customer" : "No saved customers"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search name or phone" />
                  <CommandList>
                    <CommandEmpty>No customer found.</CommandEmpty>
                    <CommandGroup>
                      {customers.map((c) => (
                        <CommandItem key={c._id} value={`${c.name} ${c.phone || ""} ${c._id}`} onSelect={() => link(c)}>
                          <div className="min-w-0">
                            <div className="truncate">{c.name}</div>
                            {c.phone && <div className="truncate text-xs text-muted-foreground">{fmtPhone(c.phone)}</div>}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cj-name">Name</Label>
            <Input id="cj-name" value={form.customerName} onChange={(e) => set("customerName", e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-phone">Mobile</Label>
            <Input id="cj-phone" type="tel" inputMode="tel" value={form.customerPhone} onChange={(e) => set("customerPhone", e.target.value)} placeholder="98470 00000" autoComplete="off" />
          </div>
        </div>
        {match && (
          <button
            type="button"
            onClick={() => link(match)}
            className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-left text-sm hover:bg-muted/40"
          >
            <Link2 className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              This number belongs to <span className="font-medium">{match.name}</span>. Link the job to them
            </span>
          </button>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="cj-email">Email</Label>
          <Input id="cj-email" type="email" value={form.customerEmail} onChange={(e) => set("customerEmail", e.target.value)} placeholder="Optional" />
        </div>
      </EditorSection>

      <EditorSection title="Job">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cj-type">Type</Label>
            <Select value={form.jobType} onValueChange={(v) => set("jobType", v as CounterJobType)}>
              <SelectTrigger id="cj-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(JOB_TYPE_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-priority">Priority</Label>
            <Select value={form.priority} onValueChange={(v) => set("priority", v as CounterPriority)}>
              <SelectTrigger id="cj-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["urgent", "high", "medium", "low"] as CounterPriority[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRIORITY_META[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cj-desc">What to make</Label>
          <Textarea id="cj-desc" rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Visiting cards, 2 names" />
        </div>
      </EditorSection>

      <EditorSection title="Specifications">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cj-qty">Quantity</Label>
            <Input id="cj-qty" type="number" inputMode="numeric" min={1} step={1} value={form.quantity} onChange={(e) => set("quantity", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-copies">Copies / sets</Label>
            <Input id="cj-copies" type="number" inputMode="numeric" min={1} step={1} value={form.copies} onChange={(e) => set("copies", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-size">Size</Label>
            <Input id="cj-size" list="cj-sizes" value={form.paperSize} onChange={(e) => set("paperSize", e.target.value)} placeholder="A4" />
            <datalist id="cj-sizes">
              {PAPER_SIZES.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-paper">Paper / material</Label>
            <Input id="cj-paper" value={form.paperType} onChange={(e) => set("paperType", e.target.value)} placeholder="e.g. 300 GSM art card" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-colour">Colour</Label>
            <Select value={form.colorMode} onValueChange={(v) => set("colorMode", v as ColorMode)}>
              <SelectTrigger id="cj-colour">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(COLOR_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-sides">Sides</Label>
            <Select value={form.sides} onValueChange={(v) => set("sides", v as Sides)}>
              <SelectTrigger id="cj-sides">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SIDES_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Finishing</span>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
            {(Object.keys(FINISHING_LABEL) as Finishing[]).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.finishing.includes(f)}
                  onCheckedChange={(on) => set("finishing", on ? [...form.finishing, f] : form.finishing.filter((x) => x !== f))}
                />
                {FINISHING_LABEL[f]}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cj-instructions">Instructions for the operator</Label>
          <Textarea id="cj-instructions" rows={2} value={form.specialInstructions} onChange={(e) => set("specialInstructions", e.target.value)} placeholder="Optional" />
        </div>
      </EditorSection>

      <EditorSection title="Promise" description="When the customer was told it would be ready.">
        <Input id="cj-promised" aria-label="Promised time" type="datetime-local" value={form.promisedAt} onChange={(e) => set("promisedAt", e.target.value)} />
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: "In 30 min", value: () => inMinutes(30) },
            { label: "In 1 hour", value: () => inMinutes(60) },
            { label: "In 3 hours", value: () => inMinutes(180) },
            { label: "Tomorrow 11 am", value: () => tomorrowAt(11) }
          ].map((q) => {
            const v = q.value();
            return (
              <Button key={q.label} type="button" size="xs" variant={form.promisedAt === v ? "subtle" : "outline"} onClick={() => set("promisedAt", v)}>
                {form.promisedAt === v && <Check />}
                {q.label}
              </Button>
            );
          })}
        </div>
      </EditorSection>

      <EditorSection title="Price" description="What the job is billed at. Bills carry no GST.">
        {billed && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Billed on {job?.billing?.invoiceNumber}. The price and advance can't change.</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cj-price">Estimated price (₹)</Label>
            <Input id="cj-price" type="number" inputMode="decimal" min={0} step="0.01" value={form.estimatedCost} onChange={(e) => set("estimatedCost", e.target.value)} placeholder="0" disabled={billed} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cj-advance">Advance taken (₹)</Label>
            <Input id="cj-advance" type="number" inputMode="decimal" min={0} step="0.01" value={form.advancePaid} onChange={(e) => set("advancePaid", e.target.value)} placeholder="0" disabled={billed} />
          </div>
        </div>
        {Number(form.advancePaid) > 0 && (
          <div className="grid grid-cols-2 items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cj-advance-method">Advance paid by</Label>
              <Select value={form.advanceMethod} onValueChange={(v) => set("advanceMethod", v as CounterPaymentMethod)} disabled={billed}>
                <SelectTrigger id="cj-advance-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METHOD_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="pb-2 text-sm">
              <span className="text-muted-foreground">Balance </span>
              <span className={cn("num font-semibold")}>{formatINR(balance)}</span>
            </p>
          </div>
        )}
        {Number(form.advancePaid) > 0 && <p className="text-xs text-muted-foreground">The advance is recorded as a payment on the invoice when you bill the job.</p>}
      </EditorSection>

      <EditorSection title="Notes">
        <Textarea id="cj-notes" aria-label="Notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Optional — only seen by your team" />
      </EditorSection>
    </EditorSheet>
  );
}
