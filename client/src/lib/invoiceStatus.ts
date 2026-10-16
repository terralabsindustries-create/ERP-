import type { PillTone } from "@/components/data";
import { daysUntil } from "@/lib/format";

/** The fields that decide how an invoice's state reads in lists. */
export interface InvoiceStateFields {
  status: string;
  paymentStatus: string;
  dueDate?: string;
}

/** Issued, not paid, and its due date has passed. */
export const isInvoiceOverdue = (i: InvoiceStateFields) =>
  !["draft", "cancelled"].includes(i.status) && i.paymentStatus !== "paid" && (daysUntil(i.dueDate) ?? 0) < 0;

/** One label for an invoice: Draft, Paid, Overdue, Part paid, Unpaid… */
export function invoiceState(i: InvoiceStateFields): { label: string; tone: PillTone } {
  if (i.status === "draft") return { label: "Draft", tone: "neutral" };
  if (i.status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  if (i.status === "refunded") return { label: "Refunded", tone: "neutral" };
  if (i.paymentStatus === "paid") return { label: "Paid", tone: "success" };
  if (isInvoiceOverdue(i)) return { label: "Overdue", tone: "danger" };
  if (i.paymentStatus === "partial") return { label: "Part paid", tone: "info" };
  return { label: "Unpaid", tone: "warning" };
}
