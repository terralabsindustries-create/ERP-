import { CheckCircle2, Pencil, Printer, RotateCcw, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusPill, Tag } from "@/components/data";
import { dueLabel, fmtDate, formatINR, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import type { Delivery } from "@/lib/api/deliveries";
import type { StatusMode } from "./DeliveryStatusDialog";
import { PRIORITY_LABEL, STATUS_META, addressLine, dateOnly, fmtPhone, isOpen, jobTitleOf, slotLabel, totalQty } from "./deliveryMeta";

const fmtTime = (iso?: string) => (iso ? format(new Date(iso), "d MMM yyyy, h:mm a") : "—");

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

/** Everything about one delivery, its history and the next step. */
export function DeliveryDetail({
  delivery,
  onOpenChange,
  canEdit,
  canStatus,
  onStatus,
  onEdit,
  onPrint
}: {
  delivery: Delivery | null;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  canStatus: boolean;
  onStatus: (d: Delivery, mode: StatusMode) => void;
  onEdit: (d: Delivery) => void;
  onPrint: (d: Delivery) => void;
}) {
  const d = delivery;
  const due = d && isOpen(d) ? dueLabel(dateOnly(d.deliveryDate)) : "";
  const overdue = due.includes("overdue");

  return (
    <Sheet open={!!d} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        {d && (
          <>
            <SheetHeader className="border-b px-5 py-4">
              <SheetTitle>{d.customerName}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{d.deliveryId}</span>
                <StatusPill tone={STATUS_META[d.status].tone}>{STATUS_META[d.status].label}</StatusPill>
                {(d.priority === "urgent" || d.priority === "high") && <Tag>{PRIORITY_LABEL[d.priority]}</Tag>}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <Block title="When">
                <div className="font-medium">
                  {fmtDate(dateOnly(d.deliveryDate))} · {slotLabel(d.deliveryTimeSlot)}
                </div>
                {due && <div className={cn("text-xs", overdue ? "text-destructive-strong" : "text-muted-foreground")}>{due}</div>}
                {(d.attempts || 0) > 0 && <div className="text-xs text-muted-foreground">Attempt {(d.attempts || 0) + 1} · last failed: {d.rescheduleReason || "—"}</div>}
              </Block>

              <Block title="Deliver to">
                <div>{addressLine(d.deliveryAddress)}</div>
                {d.deliveryAddress?.landmark && <div className="text-muted-foreground">Landmark: {d.deliveryAddress.landmark}</div>}
                <div className="mt-1">
                  {d.contactInfo?.name && <span>{d.contactInfo.name} · </span>}
                  <a href={`tel:${d.contactInfo?.phone}`} className="text-primary underline-offset-4 hover:underline">
                    {fmtPhone(d.contactInfo?.phone)}
                  </a>
                </div>
              </Block>

              <Block title="Job">
                <Link to={`/jobs?q=${encodeURIComponent(jobTitleOf(d))}`} className="text-primary underline-offset-4 hover:underline">
                  {jobTitleOf(d) || "—"}
                </Link>
              </Block>

              <Block title={`Packages · ${plural(totalQty(d), "piece")}`}>
                <ul className="divide-y rounded-md border">
                  {(d.items || []).map((i, n) => (
                    <li key={n} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 truncate">{i.description}</span>
                      <span className="num shrink-0 text-muted-foreground">× {i.quantity}</span>
                    </li>
                  ))}
                </ul>
              </Block>

              <div className="grid grid-cols-2 gap-4">
                <Block title="Driver">
                  {d.driverInfo?.name ? (
                    <>
                      <div>{d.driverInfo.name}</div>
                      <div className="text-xs text-muted-foreground">{[fmtPhone(d.driverInfo.phone), d.driverInfo.vehicleNumber].filter(Boolean).join(" · ") || "—"}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not assigned</span>
                  )}
                </Block>
                <Block title="Payment">
                  <div>{d.paymentMethod === "COD" ? `Collect ${formatINR(d.codAmount || 0)}` : "Prepaid"}</div>
                  <div className="text-xs text-muted-foreground">Delivery charge {formatINR(d.charges?.deliveryFee || 0)}</div>
                </Block>
              </div>

              {d.deliveryNotes && (
                <Block title="Notes">
                  <p className="whitespace-pre-wrap">{d.deliveryNotes}</p>
                </Block>
              )}

              {d.status === "delivered" && d.deliveryProof && (
                <Block title="Proof of delivery">
                  <div>Received by {d.deliveryProof.receivedBy}</div>
                  <div className="text-xs text-muted-foreground">{fmtTime(d.deliveryProof.deliveredAt)}</div>
                  {d.deliveryProof.note && <div className="mt-1 text-muted-foreground">{d.deliveryProof.note}</div>}
                </Block>
              )}
              {d.status === "failed" && d.failureReason && (
                <Block title="Why it failed">
                  <div className="text-destructive-strong">{d.failureReason}</div>
                </Block>
              )}
              {d.status === "cancelled" && (
                <Block title="Cancelled">
                  <div>{d.cancelReason || "No reason given"}</div>
                  <div className="text-xs text-muted-foreground">{fmtTime(d.cancelledAt)}</div>
                </Block>
              )}

              {!!d.history?.length && (
                <Block title="History">
                  <ol className="space-y-2.5 border-l pl-4">
                    {[...d.history].reverse().map((h, n) => (
                      <li key={n} className="relative">
                        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border ring-2 ring-card" aria-hidden />
                        <div className="font-medium">{STATUS_META[h.status]?.label || h.status}</div>
                        {h.note && h.note !== STATUS_META[h.status]?.label && <div className="text-muted-foreground">{h.note}</div>}
                        <div className="text-xs text-muted-foreground">
                          {fmtTime(h.at)}
                          {h.byName ? ` · ${h.byName}` : ""}
                        </div>
                      </li>
                    ))}
                  </ol>
                </Block>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 border-t bg-card px-5 py-3 sm:flex-row sm:flex-wrap sm:justify-end">
              <Button variant="outline" onClick={() => onPrint(d)}>
                <Printer />
                Print challan
              </Button>
              {canEdit && d.status !== "delivered" && d.status !== "cancelled" && (
                <Button variant="outline" onClick={() => onEdit(d)}>
                  <Pencil />
                  Edit
                </Button>
              )}
              {canStatus && d.status === "scheduled" && (
                <Button onClick={() => onStatus(d, "dispatch")}>
                  <Truck />
                  Dispatch
                </Button>
              )}
              {canStatus && d.status === "in_transit" && (
                <Button onClick={() => onStatus(d, "deliver")}>
                  <CheckCircle2 />
                  Mark delivered
                </Button>
              )}
              {canStatus && (d.status === "failed" || (d.status === "cancelled" && canEdit)) && (
                <Button onClick={() => onStatus(d, "reschedule")}>
                  <RotateCcw />
                  Reschedule
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
