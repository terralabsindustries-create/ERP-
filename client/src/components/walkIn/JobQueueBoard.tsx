import type { LucideIcon } from "lucide-react";
import { Clock, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RowActions, StatusPill, type RowAction } from "@/components/data";
import type { CounterJob, CounterStatus } from "@/lib/api/walkIn";
import { formatINR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BOARD_STATUSES, INVOICE_PAYMENT_META, PRIORITY_META, STATUS_META, byUrgency, fmtPhone, fmtWhen, operatorName, promiseLabel, specsSummary } from "./counterJobMeta";

export interface PrimaryAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  variant?: "default" | "outline" | "success";
}

const COLUMN_HINT: Record<CounterStatus, string> = {
  waiting: "Taken, not started",
  in_progress: "Being made",
  quality_check: "Checking before handover",
  ready: "Waiting for the customer",
  collected: "",
  cancelled: ""
};

/** One job on the board: who, what, when it's promised, and the next step. */
function JobCard({ job, actions, primary, onOpen }: { job: CounterJob; actions: RowAction[]; primary: PrimaryAction | null; onOpen: () => void }) {
  const op = operatorName(job);
  const invoice = job.billing?.invoice;
  return (
    <li className={cn("rounded-lg border bg-card shadow-sm transition-colors hover:border-foreground/20", job.isOverdue && "border-destructive/50")}>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
        className="block w-full space-y-1.5 px-3 pb-2 pt-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[12px] text-muted-foreground">{job.jobNumber}</span>
          <span className="flex shrink-0 items-center gap-1">
            {job.timeline.priority !== "medium" && job.timeline.priority !== "low" && <StatusPill tone={PRIORITY_META[job.timeline.priority].tone}>{PRIORITY_META[job.timeline.priority].label}</StatusPill>}
            {job.isOverdue && <StatusPill tone="danger">Overdue</StatusPill>}
          </span>
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{job.customerName}</div>
          <div className="truncate text-xs text-muted-foreground">{fmtPhone(job.customerPhone)}</div>
        </div>
        <div className="line-clamp-2 text-sm">{job.description}</div>
        <div className="truncate text-xs text-muted-foreground">{specsSummary(job)}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1", job.isOverdue && "font-medium text-destructive-strong")} title={`Promised ${fmtWhen(job.timeline.estimatedCompletion)}`}>
            <Clock className="h-3.5 w-3.5" />
            {job.status === "ready" ? `Ready ${fmtWhen(job.timeline.readyAt)}` : promiseLabel(job)}
          </span>
          <span className="inline-flex items-center gap-1">
            <UserRound className="h-3.5 w-3.5" />
            {op || "Not assigned"}
          </span>
        </div>
        {job.status === "ready" && (
          <div className="text-xs">
            {invoice ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono">{invoice.invoiceNumber}</span>
                <StatusPill tone={INVOICE_PAYMENT_META[invoice.paymentStatus]?.tone || "neutral"}>{INVOICE_PAYMENT_META[invoice.paymentStatus]?.label || invoice.paymentStatus}</StatusPill>
              </span>
            ) : (
              <span className="text-warning-strong">Not billed{job.pricing.estimatedCost ? ` · est. ${formatINR(job.pricing.estimatedCost)}` : ""}</span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
        {primary ? (
          <Button size="xs" variant={primary.variant || "outline"} onClick={primary.run}>
            <primary.icon />
            {primary.label}
          </Button>
        ) : (
          <span />
        )}
        <RowActions actions={actions} label={`Actions for ${job.jobNumber}`} />
      </div>
    </li>
  );
}

/** The counter's queue: one column per stage, most urgent job on top. */
export function JobQueueBoard({
  jobs,
  loading,
  actions,
  primary,
  onOpen
}: {
  jobs: CounterJob[];
  loading: boolean;
  actions: (job: CounterJob) => RowAction[];
  primary: (job: CounterJob) => PrimaryAction | null;
  onOpen: (job: CounterJob) => void;
}) {
  return (
    <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-4">
      {BOARD_STATUSES.map((status) => {
        const column = jobs.filter((j) => j.status === status).sort(byUrgency);
        return (
          <section key={status} aria-label={STATUS_META[status].label} className="flex min-w-0 flex-col rounded-xl bg-muted/40 p-2">
            <header className="flex items-center justify-between gap-2 px-1.5 pb-2 pt-1">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{STATUS_META[status].label}</h3>
                <p className="truncate text-xs text-muted-foreground">{COLUMN_HINT[status]}</p>
              </div>
              <span className="num rounded-full bg-card px-2 py-0.5 text-xs font-semibold text-muted-foreground">{loading ? "…" : column.length}</span>
            </header>
            {loading ? (
              <div className="space-y-2">
                {[0, 1].map((i) => (
                  <div key={i} className="h-28 animate-pulse rounded-lg bg-card" />
                ))}
              </div>
            ) : column.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">No jobs</p>
            ) : (
              <ul className="space-y-2">
                {column.map((job) => (
                  <JobCard key={job._id} job={job} actions={actions(job)} primary={primary(job)} onOpen={() => onOpen(job)} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
