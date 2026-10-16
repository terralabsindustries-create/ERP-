import { MessageCircle, Pencil, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusPill } from "@/components/data";
import type { CounterHistoryEntry, CounterJob } from "@/lib/api/walkIn";
import { formatINR } from "@/lib/format";
import type { PrimaryAction } from "./JobQueueBoard";
import {
  COLOR_LABEL,
  FINISHING_LABEL,
  INVOICE_PAYMENT_META,
  JOB_TYPE_LABEL,
  METHOD_LABEL,
  PRIORITY_META,
  SIDES_LABEL,
  STATUS_META,
  fmtDuration,
  fmtPhone,
  fmtWhen,
  operatorName,
  promiseLabel,
  readyWhatsAppLink,
  telLink
} from "./counterJobMeta";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <dl className="divide-y">{children}</dl>
    </section>
  );
}

function historyText(h: CounterHistoryEntry) {
  switch (h.event) {
    case "created":
      return "Job taken";
    case "assigned":
      return h.note === "Unassigned" ? "Operator removed" : `Assigned to ${h.note}`;
    case "qc_passed":
      return "Passed quality check";
    case "qc_failed":
      return "Failed quality check";
    case "billed":
      return `Billed on ${h.note}`;
    default:
      return h.status ? `Moved to ${STATUS_META[h.status].label.toLowerCase()}` : "Updated";
  }
}

/** Everything about one counter job, with its next step. */
export function JobDetailSheet({
  job,
  onOpenChange,
  primary,
  onEdit,
  businessName
}: {
  job: CounterJob | null;
  onOpenChange: (open: boolean) => void;
  primary: PrimaryAction | null;
  onEdit?: () => void;
  businessName?: string;
}) {
  const s = job?.specifications;
  const invoice = job?.billing?.invoice;
  return (
    <Sheet open={!!job} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        {job && s && (
          <>
            <SheetHeader className="border-b px-5 py-4 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="font-mono text-base">{job.jobNumber}</SheetTitle>
                <StatusPill tone={STATUS_META[job.status].tone}>{STATUS_META[job.status].label}</StatusPill>
                {job.isOverdue && <StatusPill tone="danger">Overdue</StatusPill>}
              </div>
              <SheetDescription>{job.description}</SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <Block title="Customer">
                <Row label="Name">{job.customerName}</Row>
                <Row label="Mobile">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {fmtPhone(job.customerPhone)}
                    <a href={telLink(job.customerPhone)} className="inline-flex items-center gap-1 text-primary hover:underline">
                      <Phone className="h-3.5 w-3.5" />
                      Call
                    </a>
                    <a href={readyWhatsAppLink(job, businessName)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <MessageCircle className="h-3.5 w-3.5" />
                      WhatsApp
                    </a>
                  </span>
                </Row>
                {job.customerEmail && <Row label="Email">{job.customerEmail}</Row>}
              </Block>

              <Block title="Job">
                <Row label="Type">{JOB_TYPE_LABEL[job.jobType]}</Row>
                <Row label="Quantity">
                  {s.quantity}
                  {s.copies && s.copies > 1 ? ` × ${s.copies} copies` : ""}
                </Row>
                {s.paperSize && <Row label="Size">{s.paperSize}</Row>}
                {s.paperType && <Row label="Paper">{s.paperType}</Row>}
                <Row label="Print">
                  {s.colorMode ? COLOR_LABEL[s.colorMode] : "—"} · {s.sides ? SIDES_LABEL[s.sides] : "—"}
                </Row>
                {s.finishing && s.finishing.length > 0 && <Row label="Finishing">{s.finishing.map((f) => FINISHING_LABEL[f] || f).join(", ")}</Row>}
                {s.specialInstructions && <Row label="Instructions">{s.specialInstructions}</Row>}
                {job.notes && <Row label="Notes">{job.notes}</Row>}
              </Block>

              <Block title="Progress">
                <Row label="Promised">
                  {fmtWhen(job.timeline.estimatedCompletion)}
                  {promiseLabel(job) && <span className={job.isOverdue ? "block text-xs text-destructive-strong" : "block text-xs text-muted-foreground"}>{promiseLabel(job)}</span>}
                </Row>
                <Row label="Priority">{PRIORITY_META[job.timeline.priority].label}</Row>
                <Row label="Operator">{operatorName(job) || "Not assigned"}</Row>
                <Row label="Taken">{fmtWhen(job.createdAt)}</Row>
                {job.timeline.readyAt && (
                  <Row label="Ready">
                    {fmtWhen(job.timeline.readyAt)}
                    {job.turnaroundMinutes !== null && <span className="block text-xs text-muted-foreground">Turnaround {fmtDuration(job.turnaroundMinutes)}</span>}
                  </Row>
                )}
                {job.timeline.collectedAt && <Row label="Collected">{fmtWhen(job.timeline.collectedAt)}</Row>}
                {job.qualityCheck?.checked && (
                  <Row label="Quality check">
                    <StatusPill tone={job.qualityCheck.approved ? "success" : "danger"}>{job.qualityCheck.approved ? "Passed" : "Failed"}</StatusPill>
                    <span className="block text-xs text-muted-foreground">
                      {[job.qualityCheck.checkedByName, job.qualityCheck.notes].filter(Boolean).join(" · ")}
                    </span>
                  </Row>
                )}
                {job.status === "cancelled" && <Row label="Cancelled">{job.cancelReason || "No reason given"}</Row>}
              </Block>

              <Block title="Money">
                <Row label="Estimate">{job.pricing.estimatedCost ? formatINR(job.pricing.estimatedCost) : "Not priced"}</Row>
                {job.pricing.advancePaid > 0 && (
                  <Row label="Advance">
                    {formatINR(job.pricing.advancePaid)} · {METHOD_LABEL[job.pricing.advanceMethod] || job.pricing.advanceMethod}
                  </Row>
                )}
                <Row label="Invoice">
                  {invoice ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{invoice.invoiceNumber}</span>
                      <StatusPill tone={INVOICE_PAYMENT_META[invoice.paymentStatus]?.tone || "neutral"}>{INVOICE_PAYMENT_META[invoice.paymentStatus]?.label || invoice.paymentStatus}</StatusPill>
                      <span className="w-full text-xs text-muted-foreground">
                        {formatINR(invoice.totalAmount)}
                        {invoice.balanceAmount > 0 ? ` · ${formatINR(invoice.balanceAmount)} due` : ""}
                      </span>
                    </span>
                  ) : job.billing?.invoiceNumber ? (
                    <span className="font-mono">{job.billing.invoiceNumber}</span>
                  ) : (
                    "Not billed"
                  )}
                </Row>
              </Block>

              {job.history.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">History</h3>
                  <ol className="space-y-2.5 border-l pl-4">
                    {[...job.history].reverse().map((h, i) => (
                      <li key={`${h.at}-${i}`} className="relative text-sm">
                        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border" aria-hidden />
                        <div>{historyText(h)}</div>
                        <div className="text-xs text-muted-foreground">
                          {[fmtWhen(h.at), h.byName, h.event !== "assigned" && h.event !== "billed" ? h.note : undefined].filter(Boolean).join(" · ")}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 border-t bg-card px-5 py-3 sm:flex-row sm:justify-end">
              {onEdit && (
                <Button variant="outline" onClick={onEdit}>
                  <Pencil />
                  Edit
                </Button>
              )}
              {primary && (
                <Button variant={primary.variant === "outline" ? "default" : primary.variant || "default"} onClick={primary.run}>
                  <primary.icon />
                  {primary.label}
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
