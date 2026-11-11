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

/*
  Each phase is one of the process inks (tokens --phase-* in src/index.css).
  `className` colours the phase's name as text, `bar` is its fill (column caps,
  bars), and each stage's `dot` is the phase ink, lighter for earlier stages.
*/
export const PHASES: Record<Phase, { label: string; className: string; bar: string }> = {
  sales: { label: "Sales", className: "text-phase-sales-text", bar: "bg-phase-sales" },
  prepress: { label: "Pre-press", className: "text-phase-prepress-text", bar: "bg-phase-prepress" },
  press: { label: "Press", className: "text-phase-press-text", bar: "bg-phase-press" },
  postpress: { label: "Post-press", className: "text-phase-postpress-text", bar: "bg-phase-postpress" },
  dispatch: { label: "Dispatch", className: "text-phase-dispatch-text", bar: "bg-phase-dispatch" },
};

export const STAGES: Stage[] = [
  { status: "inquiry", label: "Enquiry", short: "Enquiry", description: "New requirement received", phase: "sales", dot: "bg-phase-sales/40" },
  { status: "quotation_sent", label: "Quote Sent", short: "Quoted", description: "Estimate shared with customer", phase: "sales", dot: "bg-phase-sales/70" },
  { status: "quotation_approved", label: "Order Confirmed", short: "Confirmed", description: "Customer approved the quote", phase: "sales", dot: "bg-phase-sales" },
  { status: "design_in_progress", label: "Design / Pre-press", short: "Pre-press", description: "Artwork, layout and imposition", phase: "prepress", dot: "bg-phase-prepress/60" },
  { status: "design_approved", label: "Proof Approved", short: "Proof OK", description: "Customer signed off the proof", phase: "prepress", dot: "bg-phase-prepress" },
  { status: "production_ready", label: "Plates & Make-ready", short: "Make-ready", description: "Plates, paper and press set-up", phase: "press", dot: "bg-phase-press/60" },
  { status: "ready_for_print", label: "On Press", short: "Printing", description: "Running on the press", phase: "press", dot: "bg-phase-press" },
  { status: "quality_check", label: "Finishing & QC", short: "Finishing", description: "Cutting, binding, lamination, QC", phase: "postpress", dot: "bg-phase-postpress" },
  { status: "completed", label: "Ready to Dispatch", short: "Ready", description: "Packed and waiting for dispatch", phase: "dispatch", dot: "bg-phase-dispatch/60" },
  { status: "delivered", label: "Delivered", short: "Delivered", description: "Handed over to customer", phase: "dispatch", dot: "bg-phase-dispatch" },
];

export const CANCELLED_STAGE: Stage = {
  status: "cancelled",
  label: "Cancelled",
  short: "Cancelled",
  description: "Job cancelled",
  phase: "sales",
  dot: "bg-destructive",
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
  low: { label: "Low", className: "border-border bg-muted text-muted-foreground", bar: "bg-ink-3/50" },
  medium: { label: "Normal", className: "border-info/25 bg-info-soft text-info-strong", bar: "bg-info" },
  high: { label: "High", className: "border-primary/20 bg-primary-soft text-primary-strong", bar: "bg-primary" },
  // A rush job is amber: its tag, its edge and (on the board) its card's border
  urgent: { label: "Rush", className: "border-amber/50 bg-warning-soft text-warning-strong", bar: "bg-amber" },
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
