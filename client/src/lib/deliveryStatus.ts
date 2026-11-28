import type { PillTone } from "../components/data/StatusPill";

/**
 * A job ticket's delivery state for the list, next to its payment state.
 * Comes from the job's latest delivery (GET /api/jobs populates `deliveries`,
 * newest first, cancelled ones left out) and, without one, from the job's
 * own stage. Returns null when there is nothing worth showing yet.
 */
export interface JobDelivery {
  _id?: string;
  deliveryId?: string;
  status: "scheduled" | "in_transit" | "delivered" | "failed" | "cancelled" | string;
  deliveryDate?: string;
  dispatchedAt?: string;
  deliveryProof?: { deliveredAt?: string };
}

export interface DeliveryState {
  label: string;
  tone: PillTone;
  /** e.g. the challan number and date, for a tooltip. */
  detail?: string;
}

const day = (d?: string) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "";

export function deliveryState(job: { status?: string; deliveries?: JobDelivery[] }, opts: { billed?: boolean } = {}): DeliveryState | null {
  const latest = (job.deliveries || []).find((d) => d.status !== "cancelled");
  const ref = latest?.deliveryId ? `Delivery ${latest.deliveryId}` : "Delivery";
  if (latest) {
    switch (latest.status) {
      case "delivered": {
        const when = latest.deliveryProof?.deliveredAt || latest.deliveryDate;
        return { label: when ? `Delivered ${day(when)}` : "Delivered", tone: "success", detail: `${ref} delivered${when ? ` on ${day(when)}` : ""}` };
      }
      case "in_transit":
        return { label: "Out for delivery", tone: "info", detail: `${ref} dispatched${latest.dispatchedAt ? ` on ${day(latest.dispatchedAt)}` : ""}` };
      case "failed":
        return { label: "Delivery failed", tone: "danger", detail: `${ref} could not be delivered` };
      case "scheduled":
        return { label: latest.deliveryDate ? `Delivery ${day(latest.deliveryDate)}` : "Delivery scheduled", tone: "warning", detail: `${ref} scheduled` };
    }
  }
  if (job.status === "delivered") return { label: "Delivered", tone: "success", detail: "Job marked delivered" };
  if (job.status === "cancelled") return null;
  // No deliveries in the response (an older server, or a login without the
  // Delivery permission): we can't tell, so say nothing rather than "Not delivered".
  if (!Array.isArray(job.deliveries)) return null;
  // Only billed or finished work is expected to go out; earlier stages say nothing.
  if (opts.billed || job.status === "completed") return { label: "Not delivered", tone: "neutral", detail: "No delivery recorded for this job yet" };
  return null;
}
