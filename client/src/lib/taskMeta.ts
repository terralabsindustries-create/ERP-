/** Labels and shapes for tasks (backend/src/models/Task.js, routes/tasks.js). */

export type TaskStatus = "pending" | "in_progress" | "on_hold" | "completed" | "cancelled";

export const TASK_STATUS: Record<TaskStatus, { label: string; variant: "secondary" | "info" | "warning" | "success" | "destructive" }> = {
  pending: { label: "To do", variant: "secondary" },
  in_progress: { label: "In progress", variant: "info" },
  on_hold: { label: "On hold", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" }
};

export const TASK_PRIORITY: Record<string, { label: string; className: string }> = {
  low: { label: "Low", className: "border-border bg-muted text-muted-foreground" },
  medium: { label: "Normal", className: "border-info/25 bg-info-soft text-info-strong" },
  high: { label: "High", className: "border-warning/30 bg-warning-soft text-warning-strong" },
  urgent: { label: "Urgent", className: "border-destructive/25 bg-destructive-soft text-destructive-strong" }
};

export const statusLabel = (s?: string) => TASK_STATUS[(s || "pending") as TaskStatus]?.label || s || "";

export interface TaskPerson {
  _id: string;
  fullName: string;
  role?: string;
}

export interface TaskComment {
  _id: string;
  text: string;
  author?: TaskPerson | string;
  authorName?: string;
  createdAt: string;
}

export interface TaskHistoryEntry {
  _id?: string;
  type: "created" | "reassigned" | "status" | "progress" | "updated" | "comment";
  from?: string;
  to?: string;
  note?: string;
  byName?: string;
  at: string;
}

export interface TaskDetail {
  _id: string;
  title: string;
  description?: string;
  notes?: string;
  status: TaskStatus;
  priority: string;
  dueDate?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  progress?: number;
  assignedTo?: TaskPerson;
  userId?: TaskPerson;
  jobId?: { _id: string; title: string; status: string } | null;
  jobTitle?: string;
  comments: TaskComment[];
  history: TaskHistoryEntry[];
  access?: { canManage: boolean; canWorkOn: boolean };
}

/** Human description of one hand-off trail entry. */
export function describeHistory(h: TaskHistoryEntry): string {
  switch (h.type) {
    case "created":
      return `created the task${h.to ? ` and assigned it to ${h.to}` : ""}`;
    case "reassigned":
      return `reassigned it to ${h.to}`;
    case "status":
      return `changed the status from ${statusLabel(h.from)} to ${statusLabel(h.to)}`;
    case "progress":
      return `set progress to ${h.to}`;
    default:
      return "edited the task";
  }
}
