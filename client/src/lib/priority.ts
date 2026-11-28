/**
 * The one priority scale for job tickets, counter jobs, rush orders,
 * deliveries and tasks. Stored values are the keys (backend enums are
 * ['low', 'medium', 'high', 'urgent']); every form, table, filter and board
 * shows the same label for each.
 */
export type Priority = "low" | "medium" | "high" | "urgent";

export const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

/** Older records or imports may say "normal" or "rush"; they read as Medium and Urgent. */
export const normalizePriority = (value?: string | null): Priority => {
  const v = String(value || "").toLowerCase();
  if (v === "normal" || v === "") return "medium";
  if (v === "rush" || v === "critical") return "urgent";
  return (["low", "medium", "high", "urgent"] as string[]).includes(v) ? (v as Priority) : "medium";
};

export const priorityLabel = (value?: string | null) => PRIORITY_LABEL[normalizePriority(value)];
