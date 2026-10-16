/** Shapes and labels for /api/payments (backend/src/models/Payment.js). */

export type PaymentMethod = "cash" | "upi" | "bank_transfer" | "cheque" | "card" | "wallet";
export type PaymentStatus = "pending" | "completed" | "failed" | "cancelled" | "refunded";

export interface PaymentRecord {
  _id: string;
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
}

/**
 * The invoice a payment was set against. Payments recorded through this page
 * carry invoiceNumber; older ones may only have the populated invoiceId.
 */
export const invoiceNumberOf = (p: Pick<PaymentRecord, "invoiceNumber" | "invoiceId">) =>
  p.invoiceNumber || (p.invoiceId && typeof p.invoiceId === "object" ? p.invoiceId.invoiceNumber : undefined);

export type PaymentSummary = Record<PaymentStatus | "all", { count: number; amount: number }>;

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
