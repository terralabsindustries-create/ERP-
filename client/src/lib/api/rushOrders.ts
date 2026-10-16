import apiClient from "@/lib/apiClient";

/** Rush orders: typed calls to /api/emergency-orders, plus the jobs and customers calls that converting one needs. */

export type RushStatus = "pending" | "in_progress" | "completed" | "converted" | "cancelled";
export type RushPriority = "low" | "medium" | "high" | "urgent";
export type RushView = "open" | "due" | "completed" | "cancelled" | "all";

export interface RushOrder {
  _id: string;
  orderId: string;
  customerId?: { _id: string; name: string; phone?: string; email?: string; company?: string } | string | null;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  orderDetails: string;
  estimatedAmount: number;
  advancePaid?: number;
  priority: RushPriority;
  status: RushStatus;
  jobId?: { _id: string; title: string; status?: string; dueDate?: string } | string | null;
  notes?: string;
  specialInstructions?: string;
  /** Needed by. */
  expectedCompletion?: string;
  startedAt?: string;
  actualCompletion?: string;
  cancelledAt?: string;
  cancelReason?: string;
  convertedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RushSummary {
  all: number;
  open: number;
  due: number;
  overdue: number;
  completed: number;
  converted: number;
  completedThisWeek: number;
  cancelled: number;
  openEstimated: number;
  openAdvance: number;
}

export interface RushList {
  emergencyOrders: RushOrder[];
  summary: RushSummary;
  pagination: { current: number; total: number; count: number; totalEmergencyOrders: number };
}

export interface RushListParams {
  view?: RushView;
  search?: string;
  priority?: string;
  weekStart?: string;
  page?: number;
  limit?: number;
}

export interface RushInput {
  customerId?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  orderDetails: string;
  estimatedAmount: number;
  advancePaid: number;
  priority: RushPriority;
  /** ISO time. */
  expectedCompletion: string;
  notes?: string;
}

export interface CustomerOption {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
}

export interface NewJobInput {
  title: string;
  customerId: string;
  description?: string;
  priority: RushPriority;
  dueDate?: string;
  estimatedCost?: number;
  notes?: string;
}

export const rushOrdersApi = {
  list: (params: RushListParams) => apiClient.get<RushList>("/emergency-orders", { ...params }),
  create: async (input: RushInput) => (await apiClient.post<{ emergencyOrder: RushOrder }>("/emergency-orders", input)).emergencyOrder,
  update: async (id: string, input: RushInput) => (await apiClient.put<{ emergencyOrder: RushOrder }>(`/emergency-orders/${id}`, input)).emergencyOrder,
  setStatus: async (id: string, status: "in_progress" | "completed" | "cancelled", reason?: string) =>
    (await apiClient.put<{ emergencyOrder: RushOrder }>(`/emergency-orders/${id}/status`, { status, reason })).emergencyOrder,
  /** Links a job (already created through the jobs API) and closes the order as converted. */
  linkJob: async (id: string, jobId: string) => (await apiClient.post<{ emergencyOrder: RushOrder }>(`/emergency-orders/${id}/convert`, { jobId })).emergencyOrder,
  remove: (id: string) => apiClient.delete<unknown>(`/emergency-orders/${id}`),

  /** Every active customer, for the picker and to find one by phone. */
  customers: () => apiClient.listAll<CustomerOption>("/customers", "customers"),
  createCustomer: async (c: { name: string; phone: string; email?: string }) =>
    (await apiClient.post<{ customer: CustomerOption }>("/customers", { ...c, customerType: "Individual" })).customer,
  createJob: async (job: NewJobInput) => (await apiClient.post<{ job: { _id: string; title: string } }>("/jobs", job)).job
};
