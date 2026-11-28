import type { PillTone } from "@/components/data";
import { daysUntil } from "@/lib/format";

/** The fields that decide how an invoice's state reads in lists. */
export interface InvoiceStateFields {
  status: string;
  paymentStatus: string;
  dueDate?: string;
  /** What is still due. When given, an invoice still owing money never reads as Paid. */
  balanceAmount?: number;
}

/**
 * Marked paid with nothing left due. Older invoices could be marked paid with
 * no money recorded against them; those still owe their balance.
 */
export const isInvoiceSettled = (i: InvoiceStateFields) =>
  i.paymentStatus === "paid" && !((i.balanceAmount ?? 0) > 0.005);

/** Issued, not paid, and its due date has passed. */
export const isInvoiceOverdue = (i: InvoiceStateFields) =>
  !["draft", "cancelled"].includes(i.status) && !isInvoiceSettled(i) && (daysUntil(i.dueDate) ?? 0) < 0;

/** One label for an invoice: Draft, Paid, Overdue, Part paid, Unpaid… */
export function invoiceState(i: InvoiceStateFields): { label: string; tone: PillTone } {
  if (i.status === "draft") return { label: "Draft", tone: "neutral" };
  if (i.status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  if (i.status === "refunded") return { label: "Refunded", tone: "neutral" };
  if (isInvoiceSettled(i)) return { label: "Paid", tone: "success" };
  if (isInvoiceOverdue(i)) return { label: "Overdue", tone: "danger" };
  // Part-paid is amber; an unpaid invoice is red even before its due date.
  if (i.paymentStatus === "partial") return { label: "Part paid", tone: "warning" };
  return { label: "Unpaid", tone: "danger" };
}
