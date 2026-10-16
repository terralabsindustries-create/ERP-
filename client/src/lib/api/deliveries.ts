import apiClient from "@/lib/apiClient";

/** Dispatch & delivery: typed calls to /api/deliveries. */

export type DeliveryStatus = "scheduled" | "in_transit" | "delivered" | "failed" | "cancelled";
export type DeliveryPriority = "low" | "medium" | "high" | "urgent";
export type TimeSlot = "Morning (9AM-12PM)" | "Afternoon (12PM-3PM)" | "Evening (3PM-6PM)" | "Flexible";
export type DeliveryView = "today" | "upcoming" | "in_transit" | "delivered" | "failed" | "all";
export type DeliveryPayment = "Prepaid" | "COD";

export interface DeliveryAddress {
  street: string;
  city: string;
  state: string;
  pincode: string;
  landmark?: string;
  instructions?: string;
}

export interface DeliveryItem {
  description: string;
  quantity: number;
}

export interface DriverInfo {
  name?: string;
  phone?: string;
  vehicleNumber?: string;
}

export interface DeliveryHistoryEntry {
  status: DeliveryStatus;
  at: string;
  byName?: string;
  note?: string;
}

export interface DeliveryJobRef {
  _id: string;
  title: string;
  status?: string;
}

export interface DeliveryCustomerRef {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  company?: string;
}

export interface Delivery {
  _id: string;
  deliveryId: string;
  jobId: DeliveryJobRef | string | null;
  jobTitle?: string;
  customerId: DeliveryCustomerRef | string | null;
  customerName: string;
  deliveryAddress: DeliveryAddress;
  contactInfo: { name?: string; phone: string };
  /** A calendar date at midnight UTC: read it with `dateOnly`. */
  deliveryDate: string;
  deliveryTimeSlot: TimeSlot;
  status: DeliveryStatus;
  priority: DeliveryPriority;
  driverInfo?: DriverInfo;
  items: DeliveryItem[];
  trackingNumber?: string;
  deliveryNotes?: string;
  dispatchedAt?: string;
  deliveryProof?: { receivedBy?: string; deliveredAt?: string; deliveredBy?: string; note?: string };
  failureReason?: string;
  cancelledAt?: string;
  cancelReason?: string;
  charges?: { deliveryFee?: number; totalCharges?: number };
  paymentMethod: DeliveryPayment | "Partial";
  codAmount?: number;
  attempts?: number;
  lastAttemptDate?: string;
  rescheduleReason?: string;
  history?: DeliveryHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Counts behind the views and the summary strip (over the search and priority filter). */
export interface DeliverySummary {
  all: number;
  today: number;
  overdue: number;
  upcoming: number;
  in_transit: number;
  delivered: number;
  deliveredThisWeek: number;
  failed: number;
  cancelled: number;
}

export interface DeliveryList {
  deliveries: Delivery[];
  summary: DeliverySummary;
  pagination: { current: number; total: number; count: number; totalDeliveries: number };
}

export interface DeliveryListParams {
  view?: DeliveryView;
  search?: string;
  priority?: string;
  customerId?: string;
  jobId?: string;
  /** The viewer's local date, YYYY-MM-DD: decides what "today" means. */
  today?: string;
  /** Start of the viewer's week, as an ISO time. */
  weekStart?: string;
  page?: number;
  limit?: number;
}

/** What the delivery editor sends to create or edit a delivery. */
export interface DeliveryInput {
  jobId: string;
  deliveryAddress: DeliveryAddress;
  contactInfo: { name?: string; phone: string };
  deliveryDate: string;
  deliveryTimeSlot: TimeSlot;
  priority: DeliveryPriority;
  items: DeliveryItem[];
  driverInfo: DriverInfo;
  charges: { deliveryFee: number };
  paymentMethod: DeliveryPayment;
  codAmount: number;
  deliveryNotes?: string;
}

export type DeliveryStatusChange =
  | { status: "in_transit"; driverInfo: DriverInfo; note?: string }
  | { status: "delivered"; receivedBy: string; deliveredAt?: string; note?: string }
  | { status: "failed"; reason: string }
  | { status: "scheduled"; deliveryDate: string; deliveryTimeSlot?: TimeSlot; note?: string; today: string }
  | { status: "cancelled"; reason?: string };

export const deliveriesApi = {
  list: (params: DeliveryListParams) => apiClient.get<DeliveryList>("/deliveries", { ...params }),
  get: async (id: string) => (await apiClient.get<{ delivery: Delivery }>(`/deliveries/${id}`)).delivery,
  create: async (input: DeliveryInput) => (await apiClient.post<{ delivery: Delivery }>("/deliveries", input)).delivery,
  update: async (id: string, input: DeliveryInput) => (await apiClient.put<{ delivery: Delivery }>(`/deliveries/${id}`, input)).delivery,
  setStatus: async (id: string, change: DeliveryStatusChange) => (await apiClient.put<{ delivery: Delivery }>(`/deliveries/${id}/status`, change)).delivery,
  remove: (id: string) => apiClient.delete<unknown>(`/deliveries/${id}`),
  /** The most recent delivery to a customer, to reuse its address. */
  lastForCustomer: async (customerId: string) => (await apiClient.get<DeliveryList>("/deliveries", { customerId, view: "all", limit: 1 })).deliveries[0] || null
};
