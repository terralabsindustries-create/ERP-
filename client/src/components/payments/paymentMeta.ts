/** Shapes and labels for /api/payments (backend/src/models/Payment.js). */

export type PaymentMethod = "cash" | "upi" | "bank_transfer" | "cheque" | "card" | "wallet";
export type PaymentStatus = "pending" | "completed" | "failed" | "cancelled" | "refunded";

/** One invoice a payment pays, and how much of the payment goes to it. */
export interface PaymentAllocation {
  invoiceId: string;
  invoiceNumber?: string;
  amount: number;
  allocatedAt?: string;
}

export interface PaymentRecord {
  _id: string;
  __v?: number;
  paymentId: string;
  customerId?: { _id: string; name: string; phone?: string; email?: string } | string | null;
  customerName: string;
  invoiceId?: { _id: string; invoiceNumber: string; totalAmount: number; balanceAmount?: number } | string | null;
  invoiceNumber?: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentDate: string;
  status: PaymentStatus;
  referenceNumber?: string;
  notes?: string;
  collectedByName?: string;
  createdAt: string;
  /** The invoices it pays (older records included, as the API returns them). */
  allocations?: PaymentAllocation[];
  allocatedAmount?: number;
  /** Received but not yet applied to an invoice: an advance on account. */
  unallocatedAmount?: number;
  /** On an invoice's payment history: the part of this payment applied to that invoice. */
  appliedAmount?: number;
}

/**
 * A key for one submission of a payment form. Sent with it, so a retry of the
 * same submission (a double click, a dropped connection) returns the payment
 * already recorded instead of recording it twice. Make a new one per form.
 */
export const newIdempotencyKey = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/** The invoices a payment is applied to, for a list cell: "INV-1", "INV-1 +2". */
export const appliedToLabel = (p: Pick<PaymentRecord, "allocations" | "invoiceNumber" | "invoiceId">) => {
  const numbers = (p.allocations || []).map((a) => a.invoiceNumber).filter(Boolean) as string[];
  if (!numbers.length) return invoiceNumberOf(p);
  return numbers.length === 1 ? numbers[0] : `${numbers[0]} +${numbers.length - 1}`;
};

/**
 * The invoice a payment was set against. Payments recorded through this page
 * carry invoiceNumber; older ones may only have the populated invoiceId.
 */
export const invoiceNumberOf = (p: Pick<PaymentRecord, "invoiceNumber" | "invoiceId">) =>
  p.invoiceNumber || (p.invoiceId && typeof p.invoiceId === "object" ? p.invoiceId.invoiceNumber : undefined);

export type PaymentSummary = Record<PaymentStatus | "all", { count: number; amount: number }> & {
  /** Received payments with an unallocated part (advances), and that part's total. */
  onAccount?: { count: number; amount: number };
};

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  wallet: "Wallet"
};

export const STATUS_META: Record<PaymentStatus, { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "info" }> = {
  completed: { label: "Completed", variant: "success" },
  pending: { label: "Pending", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
  refunded: { label: "Refunded", variant: "info" }
};
