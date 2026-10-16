// Design time: typed calls to /api/time-entries, plus the job and task lists
// the timer's pickers need.
import apiClient from "@/lib/apiClient";

export type TimeEntryStatus = "running" | "paused" | "completed";

export interface TimeBreak {
  startTime: string;
  endTime?: string | null;
}

export interface TimeEntry {
  _id: string;
  jobId: string;
  jobTitle: string;
  taskId: string | null;
  /** The task's title, or what the person was doing when no task was picked. */
  taskName: string;
  description: string;
  billable: boolean;
  source: "timer" | "manual";
  staffId: string;
  staffName: string;
  startTime: string;
  /** Empty while the timer runs, and for time added as a duration only. */
  endTime: string | null;
  /** Minutes worked; set when the entry is stopped or added. */
  duration: number;
  status: TimeEntryStatus;
  isActive: boolean;
  breaks: TimeBreak[];
  /** Minutes worked when the server answered, running timers included. */
  minutesSoFar: number;
  createdAt: string;
  updatedAt: string;
}

export interface TimeTotals {
  count: number;
  minutes: number;
  billableMinutes: number;
}

export interface TimeEntryList {
  timeEntries: TimeEntry[];
  pagination: { current: number; pages: number; total: number };
  /** Over every entry matching the filters, not only this page. */
  totals: TimeTotals;
  serverTime: string;
}

export interface OnClock {
  _id: string;
  staffId: string;
  staffName: string;
  status: TimeEntryStatus;
  jobTitle: string;
  taskName: string;
  startTime: string;
  minutesSoFar: number;
}

export interface TimeStats {
  me: {
    todayMinutes: number;
    weekMinutes: number;
    billableWeekMinutes: number;
    todayEntries: number;
    weekEntries: number;
    topJob: { jobId: string; jobTitle: string; minutes: number } | null;
  };
  /** Only for the admin and logins that see all staff data. */
  team: {
    todayMinutes: number;
    weekMinutes: number;
    billableWeekMinutes: number;
    onClock: OnClock[];
  } | null;
}

export interface Person {
  _id: string;
  fullName: string;
  role: string;
}

export type ListParams = {
  /** Inclusive. */
  from?: string;
  /** Exclusive: the start of the day after the last one. */
  to?: string;
  jobId?: string;
  staffId?: string;
  status?: TimeEntryStatus | "open";
  billable?: "true" | "false";
  search?: string;
  page?: number;
  limit?: number;
};

export type WorkInput = {
  jobId: string;
  taskId?: string | null;
  description?: string;
  billable?: boolean;
};

export type ManualInput = WorkInput & {
  startTime: string;
  endTime?: string | null;
  duration?: number | null;
};

export type EntryUpdate = Partial<ManualInput>;

interface EntryResult {
  timeEntry: TimeEntry;
  serverTime?: string;
}

const BASE = "/time-entries";

export const timeEntriesApi = {
  list: (params: ListParams) => apiClient.get<TimeEntryList>(BASE, params),
  active: () => apiClient.get<{ activeTimer: TimeEntry | null; serverTime: string }>(`${BASE}/active`),
  stats: (dayStart: Date, weekStart: Date) =>
    apiClient.get<{ stats: TimeStats; serverTime: string }>(`${BASE}/stats/summary`, { dayStart: dayStart.toISOString(), weekStart: weekStart.toISOString() }),
  people: () => apiClient.get<{ people: Person[]; canSeeTeam: boolean }>(`${BASE}/people`),
  /** Starts the caller's timer; a timer already going is stopped and returned as `stopped`. */
  start: (input: WorkInput) => apiClient.post<EntryResult & { stopped: TimeEntry | null }>(`${BASE}/start`, input),
  pause: (id: string) => apiClient.post<EntryResult>(`${BASE}/${id}/pause`),
  resume: (id: string) => apiClient.post<EntryResult>(`${BASE}/${id}/resume`),
  stop: (id: string) => apiClient.post<EntryResult>(`${BASE}/${id}/stop`),
  create: (input: ManualInput) => apiClient.post<EntryResult>(BASE, input),
  update: (id: string, input: EntryUpdate) => apiClient.put<EntryResult>(`${BASE}/${id}`, input),
  remove: (id: string) => apiClient.delete<{ id: string }>(`${BASE}/${id}`)
};

// ---- pickers

type Ref = { _id: string; title?: string; name?: string } | string | null | undefined;

export interface JobOption {
  _id: string;
  title: string;
  status: string;
  customerName?: string;
  customerId?: Ref;
}

export interface TaskOption {
  _id: string;
  title: string;
  status: string;
  jobId?: Ref;
  jobTitle?: string;
  dueDate?: string;
}

export const refId = (r: Ref): string => (r && typeof r === "object" ? r._id : typeof r === "string" ? r : "");

export const customerOf = (j: JobOption) => j.customerName || (j.customerId && typeof j.customerId === "object" ? j.customerId.name : "") || "";

/** Every job in the business, most recently changed first. */
export const loadJobs = () => apiClient.listAll<JobOption>("/jobs", "jobs", { sortBy: "updatedAt", sortOrder: "desc" });

/** The tasks assigned to this login. */
export const loadMyTasks = (userId: string) => apiClient.listAll<TaskOption>("/tasks", undefined, { assignedTo: userId, sortBy: "updatedAt", sortOrder: "desc" });
