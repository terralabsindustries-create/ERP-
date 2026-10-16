import type { PillTone } from "@/components/data";
import type { ColorMode, CounterJob, CounterJobType, CounterPaymentMethod, CounterPriority, CounterStatus, Finishing, InvoicePaymentStatus, Sides } from "@/lib/api/walkIn";
import { fmtDate } from "@/lib/format";

export const STATUS_META: Record<CounterStatus, { label: string; tone: PillTone }> = {
  waiting: { label: "Waiting", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  quality_check: { label: "Quality check", tone: "primary" },
  ready: { label: "Ready for pickup", tone: "success" },
  collected: { label: "Collected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "danger" }
};

/** The columns of the queue board, in the order work moves through them. */
export const BOARD_STATUSES: CounterStatus[] = ["waiting", "in_progress", "quality_check", "ready"];
export const QUEUE_STATUSES: CounterStatus[] = ["waiting", "in_progress", "quality_check"];

export const JOB_TYPE_LABEL: Record<CounterJobType, string> = {
  printing: "Printing",
  photocopy: "Photocopy",
  large_format: "Flex / large format",
  design: "Design",
  binding: "Binding",
  lamination: "Lamination",
  cutting: "Cutting",
  scanning: "Scanning",
  other: "Other"
};

export const PRIORITY_META: Record<CounterPriority, { label: string; rank: number; tone: PillTone }> = {
  urgent: { label: "Urgent", rank: 0, tone: "danger" },
  high: { label: "High", rank: 1, tone: "warning" },
  medium: { label: "Normal", rank: 2, tone: "neutral" },
  low: { label: "Low", rank: 3, tone: "neutral" }
};

export const COLOR_LABEL: Record<ColorMode, string> = { color: "Colour", black_white: "Black & white" };
export const SIDES_LABEL: Record<Sides, string> = { single: "Single-sided", double: "Double-sided" };
export const FINISHING_LABEL: Record<Finishing, string> = {
  lamination: "Lamination",
  cutting: "Cutting",
  folding: "Folding",
  creasing: "Creasing",
  stapling: "Stapling",
  spiral_binding: "Spiral binding",
  binding: "Binding",
  perforation: "Perforation"
};

export const METHOD_LABEL: Record<CounterPaymentMethod, string> = { cash: "Cash", upi: "UPI", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque" };

export const INVOICE_PAYMENT_META: Record<InvoicePaymentStatus, { label: string; tone: PillTone }> = {
  paid: { label: "Paid", tone: "success" },
  partial: { label: "Part paid", tone: "warning" },
  pending: { label: "Unpaid", tone: "warning" },
  overdue: { label: "Overdue", tone: "danger" }
};

/** "+91 98470 12345" for a 10-digit Indian mobile number; anything else as stored. */
export function fmtPhone(phone?: string) {
  const d = (phone || "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d;
  return ten.length === 10 ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : phone || "";
}

const tenDigits = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
};

export const telLink = (phone: string) => `tel:+91${tenDigits(phone)}`;

/** WhatsApp chat with the customer, with the "ready for pickup" message filled in. */
export function readyWhatsAppLink(job: CounterJob, businessName?: string) {
  const first = job.customerName.split(" ")[0];
  const text = `Hi ${first}, your job ${job.jobNumber} (${job.description}) is ready for pickup${businessName ? ` at ${businessName}` : ""}. Thank you!`;
  return `https://wa.me/91${tenDigits(job.customerPhone)}?text=${encodeURIComponent(text)}`;
}

/** "45 min", "2 h 10 min", "1 d 3 h". */
export function fmtDuration(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.round((m % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

const time = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });

/** "Today, 4:30 pm", "Tomorrow, 10:00 am", "15 Oct 2026, 11:00 am". */
export function fmtWhen(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = Math.floor((d.getTime() - start.getTime()) / 864e5);
  if (day === 0) return `Today, ${time(d)}`;
  if (day === 1) return `Tomorrow, ${time(d)}`;
  if (day === -1) return `Yesterday, ${time(d)}`;
  return `${fmtDate(d)}, ${time(d)}`;
}

/** "Due in 25 min", "Overdue by 1 h 5 min" for a job still in the queue. */
export function promiseLabel(job: CounterJob) {
  if (!QUEUE_STATUSES.includes(job.status)) return "";
  const mins = Math.round((new Date(job.timeline.estimatedCompletion).getTime() - Date.now()) / 60000);
  return mins >= 0 ? `Due in ${fmtDuration(mins)}` : `Overdue by ${fmtDuration(-mins)}`;
}

/** "200 × A5 · 300 GSM art card · Colour · Double-sided · Lamination, Cutting" */
export function specsSummary(job: Pick<CounterJob, "specifications">) {
  const s = job.specifications || { quantity: 0 };
  const qty = s.copies && s.copies > 1 ? `${s.quantity} × ${s.copies} copies` : `${s.quantity}`;
  return [
    s.paperSize ? `${qty} × ${s.paperSize}` : `Qty ${qty}`,
    s.paperType,
    s.colorMode ? COLOR_LABEL[s.colorMode] : undefined,
    s.sides ? SIDES_LABEL[s.sides] : undefined,
    s.finishing?.length ? s.finishing.map((f) => FINISHING_LABEL[f] || f).join(", ") : undefined
  ]
    .filter(Boolean)
    .join(" · ");
}

export const operatorName = (job: CounterJob) => job.assignedTo?.operator?.fullName || job.assignedTo?.operatorName || "";

export const isBilled = (job: CounterJob) => !!(job.billing?.invoice || job.billing?.invoiceNumber);

/** Board order: overdue first, then by priority, then the earliest promise. */
export function byUrgency(a: CounterJob, b: CounterJob) {
  if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
  const p = PRIORITY_META[a.timeline.priority].rank - PRIORITY_META[b.timeline.priority].rank;
  if (p) return p;
  return new Date(a.timeline.estimatedCompletion).getTime() - new Date(b.timeline.estimatedCompletion).getTime();
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : undefined);
