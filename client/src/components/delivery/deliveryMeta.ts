import { format } from "date-fns";
import type { PillTone } from "@/components/data";
import type { Delivery, DeliveryAddress, DeliveryPriority, DeliveryStatus, TimeSlot } from "@/lib/api/deliveries";

export const STATUS_META: Record<DeliveryStatus, { label: string; tone: PillTone }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  in_transit: { label: "In transit", tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" }
};

export const PRIORITY_LABEL: Record<DeliveryPriority, string> = { low: "Low", medium: "Normal", high: "High", urgent: "Urgent" };

export const TIME_SLOTS: { value: TimeSlot; label: string }[] = [
  { value: "Flexible", label: "Any time" },
  { value: "Morning (9AM-12PM)", label: "Morning, 9 am – 12 pm" },
  { value: "Afternoon (12PM-3PM)", label: "Afternoon, 12 – 3 pm" },
  { value: "Evening (3PM-6PM)", label: "Evening, 3 – 6 pm" }
];
export const slotLabel = (s?: string) => TIME_SLOTS.find((t) => t.value === s)?.label || "Any time";

export const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal"
];

/** Today as the viewer sees it, YYYY-MM-DD. */
export const localToday = () => format(new Date(), "yyyy-MM-dd");

/** A date-only value stored as midnight UTC ("2026-10-13T00:00:00Z") as a local date. */
export const dateOnly = (iso?: string | null) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};

/** "+91 98470 00000" for a 10-digit Indian mobile number; anything else as typed. */
export function fmtPhone(phone?: string | null) {
  if (!phone) return "";
  const d = phone.replace(/\D/g, "");
  const ten = d.length === 10 ? d : d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : null;
  return ten && /^[6-9]/.test(ten) ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : phone;
}

/** True when a phone number has a plausible number of digits (10–13). */
export const isPhone = (v: string) => {
  const n = v.replace(/\D/g, "").length;
  return n >= 10 && n <= 13;
};

/** One line: "12 Market Road, Kochi, Kerala 682011". */
export const addressLine = (a?: Partial<DeliveryAddress> | null) =>
  a ? [a.street, a.city, [a.state, a.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";

/**
 * Splits a customer's free-text address ("12 Market Road, Kochi, Kerala 682011")
 * into street, city, state and pincode, as well as it can. Kerala when no
 * state is named.
 */
export function parseAddress(text?: string | null): DeliveryAddress {
  const out: DeliveryAddress = { street: "", city: "", state: "Kerala", pincode: "" };
  if (!text) return out;
  let parts = text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);

  parts = parts
    .map((p) => {
      const pin = p.match(/\b(\d{3})\s?(\d{3})\b/);
      if (pin && !out.pincode) {
        out.pincode = pin[1] + pin[2];
        return p.replace(pin[0], "").replace(/[-–\s]+$/, "").replace(/^\s*[-–]\s*/, "").trim();
      }
      return p;
    })
    .filter(Boolean)
    .filter((p) => !/^india$/i.test(p));

  for (let i = parts.length - 1; i >= 0; i--) {
    const state = INDIAN_STATES.find((s) => s.toLowerCase() === parts[i].toLowerCase());
    if (state) {
      out.state = state;
      parts.splice(i, 1);
      break;
    }
  }

  if (parts.length > 1) out.city = parts.pop() || "";
  out.street = parts.join(", ");
  return out;
}

export const jobTitleOf = (d: Delivery) => (typeof d.jobId === "object" && d.jobId ? d.jobId.title : "") || d.jobTitle || "";
export const jobIdOf = (d: Delivery): string => (typeof d.jobId === "string" ? d.jobId : d.jobId?._id || "");
export const totalQty = (d: Delivery) => (d.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
export const isOpen = (d: Delivery) => d.status === "scheduled" || d.status === "in_transit";
