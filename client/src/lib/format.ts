import { differenceInCalendarDays, format, formatDistanceToNow, isValid } from "date-fns";

export { formatINR } from "@/lib/printWorkflow";

const toDate = (d?: string | number | Date | null) => {
  if (!d) return null;
  const x = new Date(d);
  return isValid(x) ? x : null;
};

/** "2026-10-14" in local (India) time, for date inputs and file names — not UTC. */
export const localDate = (d: string | number | Date = new Date()) => format(new Date(d), "yyyy-MM-dd");

/*
  Dates and times shown to people. One format everywhere — "14 Nov 2026",
  "10:30 AM", "14 Nov 2026, 10:30 AM" — in the business's time zone (India by
  default; setDisplayTimeZone applies a tenant setting). Stored dates are never
  changed by this: it only formats.
*/
let displayTimeZone = "Asia/Kolkata";
let displayLocale = "en-IN";
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (key: string, options: Intl.DateTimeFormatOptions) => {
  const k = `${displayLocale}|${displayTimeZone}|${key}`;
  let f = formatters.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(displayLocale, { ...options, timeZone: displayTimeZone });
    formatters.set(k, f);
  }
  return f;
};

/** Use the business's own time zone and locale (Settings) for every date shown. */
export function setDisplayTimeZone(timeZone?: string | null, locale?: string | null) {
  try {
    if (timeZone) new Intl.DateTimeFormat("en-IN", { timeZone }); // throws on an unknown zone
    displayTimeZone = timeZone || "Asia/Kolkata";
    displayLocale = locale || "en-IN";
  } catch {
    displayTimeZone = "Asia/Kolkata";
  }
}

/** "14 Nov 2026" — the one date format the app uses. */
export const fmtDate = (d?: string | number | Date | null, fallback = "—") => {
  const x = toDate(d);
  return x ? formatter("date", { day: "numeric", month: "short", year: "numeric" }).format(x) : fallback;
};
/** Same as fmtDate. */
export const formatDate = fmtDate;

/** "10:30 AM". */
export const fmtTime = (d?: string | number | Date | null, fallback = "—") => {
  const x = toDate(d);
  return x ? formatter("time", { hour: "numeric", minute: "2-digit", hour12: true }).format(x).replace(/\b(am|pm)\b/, (m) => m.toUpperCase()) : fallback;
};

/** "14 Nov 2026, 10:30 AM". */
export const fmtDateTime = (d?: string | number | Date | null, fallback = "—") => {
  const x = toDate(d);
  return x ? `${fmtDate(x)}, ${fmtTime(x)}` : fallback;
};

/** "13 Oct" for compact cells; adds the year when it isn't this year. */
export const fmtDateShort = (d?: string | number | Date | null, fallback = "—") => {
  const x = toDate(d);
  if (!x) return fallback;
  return format(x, x.getFullYear() === new Date().getFullYear() ? "d MMM" : "d MMM yyyy");
};

/** "3 days ago", "in 2 hours". */
export const fmtRelative = (d?: string | number | Date | null, fallback = "—") => {
  const x = toDate(d);
  return x ? formatDistanceToNow(x, { addSuffix: true }) : fallback;
};

/** Days until a date by the calendar (negative when it has passed). */
export const daysUntil = (d?: string | number | Date | null) => {
  const x = toDate(d);
  return x ? differenceInCalendarDays(x, new Date()) : null;
};

/** "Due today", "Due in 4 days", "6 days overdue". */
export function dueLabel(d?: string | number | Date | null) {
  const n = daysUntil(d);
  if (n === null) return "";
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n > 1) return `Due in ${n} days`;
  return `${-n} day${n === -1 ? "" : "s"} overdue`;
}

/** "1,234" in the Indian grouping. */
export const fmtNumber = (n?: number | null) => (typeof n === "number" ? n.toLocaleString("en-IN") : "—");

/** Capitalise a status like "in_progress" → "In progress". */
export const humanize = (s?: string | null) => (s ? (s.charAt(0).toUpperCase() + s.slice(1)).replace(/[_-]+/g, " ") : "");

/** "1 payment", "3 payments". */
export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? word : many}`;
