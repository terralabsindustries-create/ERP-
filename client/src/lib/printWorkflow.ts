/**
 * The print job lifecycle, in shop-floor language.
 *
 * Each stage is one of the backend's Job `status` values (backend/src/models/Job.js),
 * in the order a job moves through the shop. Labels and phases live here so the
 * dashboard, production board and job list all describe a job the same way.
 */

export type JobStatus =
  | "inquiry"
  | "quotation_sent"
  | "quotation_approved"
  | "design_in_progress"
  | "design_approved"
  | "production_ready"
  | "ready_for_print"
  | "quality_check"
  | "completed"
  | "delivered"
  | "cancelled";

export type Phase = "sales" | "prepress" | "press" | "postpress" | "dispatch";

export interface Stage {
  status: JobStatus;
  label: string;
  short: string;
  description: string;
  phase: Phase;
  /** Tailwind classes for the stage's dot / accent bar */
  dot: string;
}

export const PHASES: Record<Phase, { label: string; className: string }> = {
  sales: { label: "Sales", className: "text-slate-600 dark:text-slate-400" },
  prepress: { label: "Pre-press", className: "text-sky-700 dark:text-sky-400" },
  press: { label: "Press", className: "text-fuchsia-700 dark:text-fuchsia-400" },
  postpress: { label: "Post-press", className: "text-amber-700 dark:text-amber-400" },
  dispatch: { label: "Dispatch", className: "text-emerald-700 dark:text-emerald-400" },
};

export const STAGES: Stage[] = [
  { status: "inquiry", label: "Enquiry", short: "Enquiry", description: "New requirement received", phase: "sales", dot: "bg-slate-400" },
  { status: "quotation_sent", label: "Quote Sent", short: "Quoted", description: "Estimate shared with customer", phase: "sales", dot: "bg-slate-500" },
  { status: "quotation_approved", label: "Order Confirmed", short: "Confirmed", description: "Customer approved the quote", phase: "sales", dot: "bg-indigo-500" },
  { status: "design_in_progress", label: "Design / Pre-press", short: "Pre-press", description: "Artwork, layout and imposition", phase: "prepress", dot: "bg-sky-500" },
  { status: "design_approved", label: "Proof Approved", short: "Proof OK", description: "Customer signed off the proof", phase: "prepress", dot: "bg-cyan-500" },
  { status: "production_ready", label: "Plates & Make-ready", short: "Make-ready", description: "Plates, paper and press set-up", phase: "press", dot: "bg-violet-500" },
  { status: "ready_for_print", label: "On Press", short: "Printing", description: "Running on the press", phase: "press", dot: "bg-fuchsia-500" },
  { status: "quality_check", label: "Finishing & QC", short: "Finishing", description: "Cutting, binding, lamination, QC", phase: "postpress", dot: "bg-amber-500" },
  { status: "completed", label: "Ready to Dispatch", short: "Ready", description: "Packed and waiting for dispatch", phase: "dispatch", dot: "bg-emerald-500" },
  { status: "delivered", label: "Delivered", short: "Delivered", description: "Handed over to customer", phase: "dispatch", dot: "bg-emerald-700" },
];

export const CANCELLED_STAGE: Stage = {
  status: "cancelled",
  label: "Cancelled",
  short: "Cancelled",
  description: "Job cancelled",
  phase: "sales",
  dot: "bg-red-500",
};

const BY_STATUS = new Map<string, Stage>([...STAGES, CANCELLED_STAGE].map((s) => [s.status, s]));

export const getStage = (status?: string): Stage =>
  BY_STATUS.get(status || "") || { ...STAGES[0], status: (status as JobStatus) || "inquiry", label: status || "Unknown", short: status || "Unknown" };

export const stageIndex = (status?: string) => STAGES.findIndex((s) => s.status === status);

/** The stage after this one, or null at the end of the line. */
export const nextStage = (status?: string): Stage | null => {
  const i = stageIndex(status);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
};

/** Statuses where the job is physically in the shop (confirmed, not yet out). */
export const SHOP_FLOOR_STATUSES: JobStatus[] = [
  "quotation_approved",
  "design_in_progress",
  "design_approved",
  "production_ready",
  "ready_for_print",
  "quality_check",
  "completed",
];

export const CLOSED_STATUSES: JobStatus[] = ["delivered", "cancelled"];

export const isOpen = (status?: string) => !CLOSED_STATUSES.includes(status as JobStatus) && status !== "completed";

/** Due-date state for an open job: overdue, due today, or neither. */
export const dueState = (dueDate?: string | Date | null, status?: string): "overdue" | "today" | "soon" | null => {
  if (!dueDate || !isOpen(status)) return null;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 864e5);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 2) return "soon";
  return null;
};

export const PRIORITY_STYLES: Record<string, { label: string; className: string; bar: string }> = {
  low: { label: "Low", className: "border-border bg-muted text-muted-foreground", bar: "bg-muted-foreground/40" },
  medium: { label: "Normal", className: "border-info/25 bg-info-soft text-info-strong", bar: "bg-info" },
  high: { label: "High", className: "border-warning/30 bg-warning-soft text-warning-strong", bar: "bg-warning" },
  urgent: { label: "Rush", className: "border-destructive/25 bg-destructive-soft text-destructive-strong", bar: "bg-destructive" },
};

export const formatINR = (amount: number, opts: { compact?: boolean } = {}) => {
  const n = Number(amount) || 0;
  if (opts.compact) {
    if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
    if (Math.abs(n) >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  }
  const paise = Math.round(n * 100) % 100 !== 0;
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: paise ? 2 : 0, maximumFractionDigits: 2 })}`;
};
