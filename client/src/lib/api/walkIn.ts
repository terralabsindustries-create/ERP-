import apiClient from "@/lib/apiClient";

/** Counter jobs (walk-in jobs): `/api/walk-in-jobs`, plus the invoice and payment calls billing makes. */

export type CounterStatus = "waiting" | "in_progress" | "quality_check" | "ready" | "collected" | "cancelled";
export type CounterJobType = "printing" | "photocopy" | "large_format" | "design" | "binding" | "lamination" | "cutting" | "scanning" | "other";
export type CounterPriority = "low" | "medium" | "high" | "urgent";
export type ColorMode = "black_white" | "color";
export type Sides = "single" | "double";
export type Finishing = "lamination" | "cutting" | "folding" | "creasing" | "stapling" | "spiral_binding" | "binding" | "perforation";
export type CounterPaymentMethod = "cash" | "upi" | "card" | "bank_transfer" | "cheque";
export type InvoicePaymentStatus = "pending" | "partial" | "paid" | "overdue";

export interface CounterSpecs {
  quantity: number;
  copies?: number;
  paperSize?: string;
  paperType?: string;
  colorMode?: ColorMode;
  sides?: Sides;
  finishing?: Finishing[];
  specialInstructions?: string;
}

export interface CounterInvoiceRef {
  _id: string;
  invoiceNumber: string;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: InvoicePaymentStatus;
  status: string;
}

export interface CounterHistoryEntry {
  status?: CounterStatus;
  event?: "created" | "status" | "assigned" | "qc_passed" | "qc_failed" | "billed";
  note?: string;
  at: string;
  byName?: string;
}

export interface CounterJob {
  _id: string;
  jobNumber: string;
  customerId?: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  jobType: CounterJobType;
  description: string;
  specifications: CounterSpecs;
  pricing: { estimatedCost: number; advancePaid: number; advanceMethod: CounterPaymentMethod };
  timeline: {
    estimatedCompletion: string;
    priority: CounterPriority;
    startedAt?: string;
    qualityCheckAt?: string;
    readyAt?: string;
    collectedAt?: string;
    cancelledAt?: string;
  };
  status: CounterStatus;
  cancelReason?: string;
  assignedTo?: { operator?: { _id: string; fullName: string; role?: string } | null; operatorName?: string; assignedAt?: string };
  qualityCheck?: { checked?: boolean; approved?: boolean; checkedByName?: string; checkedAt?: string; notes?: string };
  billing?: { invoice?: CounterInvoiceRef | null; invoiceNumber?: string; amount?: number; billedAt?: string; billedByName?: string };
  history: CounterHistoryEntry[];
  notes?: string;
  isOverdue: boolean;
  turnaroundMinutes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CounterStats {
  counts: Record<CounterStatus | "all" | "queue", number>;
  todayJobs: number;
  inQueue: number;
  readyForPickup: number;
  collectedToday: number;
  overdue: number;
  unbilled: number;
  billedToday: number;
  billedTodayCount: number;
  avgTurnaroundMinutes: number | null;
  turnaroundSample: number;
}

export interface CounterJobInput {
  customerId?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  jobType: CounterJobType;
  description: string;
  specifications: CounterSpecs;
  timeline: { estimatedCompletion: string; priority: CounterPriority };
  pricing: { estimatedCost: number; advancePaid: number; advanceMethod: CounterPaymentMethod };
  notes?: string;
}

export interface Operator {
  _id: string;
  fullName: string;
  role?: string;
}

export type CounterView = "all" | "queue" | "active" | "overdue" | "unbilled" | CounterStatus;

export interface CounterListParams {
  view?: CounterView;
  jobType?: string;
  priority?: string;
  operator?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: "createdAt" | "promisedAt" | "jobNumber" | "customerName";
  sortOrder?: "asc" | "desc";
}

export interface CounterListResponse {
  jobs: CounterJob[];
  pagination: { current: number; total: number; count: number; totalJobs: number };
}

const BASE = "/walk-in-jobs";

export const counterJobsApi = {
  list: (params: CounterListParams) => apiClient.get<CounterListResponse>(BASE, { ...params }),
  listAll: (params: CounterListParams) => apiClient.listAll<CounterJob>(BASE, "jobs", { ...params }),
  get: async (id: string) => (await apiClient.get<{ job: CounterJob }>(`${BASE}/${id}`)).job,
  stats: async () => (await apiClient.get<{ stats: CounterStats }>(`${BASE}/stats/summary`)).stats,
  operators: async () => (await apiClient.get<{ operators: Operator[] }>(`${BASE}/operators`)).operators,
  create: async (input: CounterJobInput) => (await apiClient.post<{ job: CounterJob }>(BASE, input)).job,
  update: async (id: string, input: CounterJobInput) => (await apiClient.put<{ job: CounterJob }>(`${BASE}/${id}`, input)).job,
  remove: (id: string) => apiClient.delete<unknown>(`${BASE}/${id}`),
  setStatus: async (id: string, status: CounterStatus, note?: string) => (await apiClient.put<{ job: CounterJob }>(`${BASE}/${id}/status`, { status, note: note || undefined })).job,
  assign: async (id: string, operatorId: string | null) => (await apiClient.put<{ job: CounterJob }>(`${BASE}/${id}/assign`, { operatorId })).job,
  qualityCheck: async (id: string, passed: boolean, notes?: string) =>
    (await apiClient.put<{ job: CounterJob }>(`${BASE}/${id}/quality-check`, { passed, notes: notes || undefined })).job,
  linkInvoice: async (id: string, invoiceId: string) => (await apiClient.put<{ job: CounterJob }>(`${BASE}/${id}/invoice`, { invoiceId })).job
};

// ---------------------------------------------------------------------------
// Customers, invoices and payments used by counter billing
// ---------------------------------------------------------------------------

export interface CustomerLite {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
}

/** Last 10 digits of an Indian number, for comparing phones typed in different ways. */
export const phoneKey = (phone?: string) => {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

export const customersApi = {
  /** Every active customer, for the picker in the job editor. */
  all: () => apiClient.listAll<CustomerLite>("/customers", "customers"),
  /** The customer with this mobile number, if there is one. */
  findByPhone: async (phone: string) => {
    const key = phoneKey(phone);
    if (key.length !== 10) return null;
    const res = await apiClient.get<{ customers: CustomerLite[] }>("/customers", { search: key, limit: 25 });
    return (res.customers || []).find((c) => phoneKey(c.phone) === key) || null;
  },
  create: async (input: { name: string; phone: string; email?: string }) =>
    (await apiClient.post<{ customer: CustomerLite }>("/customers", { ...input, email: input.email || undefined, customerType: "Walk-in" })).customer
};

export interface CounterInvoiceLine {
  itemName: string;
  description?: string;
  quantity: number;
  unitPrice: number;
}

export interface CounterInvoiceInput {
  customerId: string;
  lines: CounterInvoiceLine[];
  discountAmount: number;
  notes: string;
}

export interface CreatedInvoice {
  _id: string;
  invoiceNumber: string;
  totalAmount: number;
  balanceAmount: number;
  paymentStatus: InvoicePaymentStatus;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Issue an invoice through POST /api/invoices, due on receipt. The server recomputes every figure; no GST. */
export async function createCounterInvoice(input: CounterInvoiceInput) {
  const res = await apiClient.post<{ invoice: CreatedInvoice }>("/invoices", {
    customerId: input.customerId,
    invoiceDate: today(),
    dueDate: today(),
    status: "sent",
    paymentTerms: "Due on receipt",
    items: input.lines.map((l) => ({
      itemName: l.itemName,
      description: l.description || undefined,
      quantity: l.quantity,
      unit: "nos",
      unitPrice: l.unitPrice
    })),
    discountAmount: input.discountAmount,
    notes: input.notes
  });
  return res.invoice;
}

export interface CounterPaymentInput {
  customerId: string;
  invoiceId: string;
  amount: number;
  paymentMethod: CounterPaymentMethod;
  paymentDate?: string;
  referenceNumber?: string;
  notes?: string;
}

/** Record money received against the invoice through POST /api/payments. */
export const recordCounterPayment = (input: CounterPaymentInput) =>
  apiClient.post<unknown>("/payments", {
    ...input,
    status: "completed",
    referenceNumber: input.referenceNumber || undefined,
    notes: input.notes || undefined
  });
