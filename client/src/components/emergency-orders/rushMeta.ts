import { format, formatDistanceToNowStrict } from "date-fns";
import type { PillTone } from "@/components/data";
import type { RushOrder, RushPriority, RushStatus } from "@/lib/api/rushOrders";

export const STATUS_META: Record<RushStatus, { label: string; tone: PillTone }> = {
  pending: { label: "Not started", tone: "warning" },
  in_progress: { label: "In progress", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  converted: { label: "Converted to job", tone: "primary" },
  cancelled: { label: "Cancelled", tone: "neutral" }
};

export const PRIORITY_LABEL: Record<RushPriority, string> = { low: "Low", medium: "Normal", high: "High", urgent: "Urgent" };

export const isOpen = (o: RushOrder) => o.status === "pending" || o.status === "in_progress";

/** "13 Oct, 5:30 pm" (with the year when it isn't this year). */
export function neededBy(o: RushOrder) {
  if (!o.expectedCompletion) return "—";
  const d = new Date(o.expectedCompletion);
  return format(d, d.getFullYear() === new Date().getFullYear() ? "d MMM, h:mm a" : "d MMM yyyy, h:mm a");
}

/** "in 3 hours" / "2 hours overdue" for an open order; empty otherwise. */
export function dueNote(o: RushOrder) {
  if (!isOpen(o) || !o.expectedCompletion) return { text: "", overdue: false, soon: false };
  const d = new Date(o.expectedCompletion);
  const ms = d.getTime() - Date.now();
  if (ms < 0) return { text: `${formatDistanceToNowStrict(d)} overdue`, overdue: true, soon: true };
  return { text: `in ${formatDistanceToNowStrict(d)}`, overdue: false, soon: ms <= 864e5 };
}

export const jobOf = (o: RushOrder) => (o.jobId && typeof o.jobId === "object" ? o.jobId : null);
export const customerIdOf = (o: RushOrder): string => (typeof o.customerId === "string" ? o.customerId : o.customerId?._id || "");

/** The last 10 digits of a phone number, to compare numbers typed in different ways. */
export const phoneKey = (v?: string | null) => (v || "").replace(/\D/g, "").slice(-10);

/** A 10-digit Indian mobile number as digits only, the way customer records store it. */
export function compactPhone(v: string) {
  const d = v.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d.length >= 10 ? d : v.trim();
}

/** A job title from the order details: the first line, kept short. */
export function jobTitleFrom(o: RushOrder) {
  const first = o.orderDetails.split("\n")[0].trim();
  const title = first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
  return title || `Rush order ${o.orderId}`;
}
