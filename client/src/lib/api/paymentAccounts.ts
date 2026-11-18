import apiClient from "@/lib/apiClient";

/** Where payments are received: `/api/payment-accounts` (backend/src/routes/paymentAccounts.js). */
export type PaymentAccountKind = "cash" | "bank" | "wallet";

export interface PaymentAccount {
  _id: string;
  kind: PaymentAccountKind;
  nickname: string;
  bankName?: string;
  accountHolderName?: string;
  /** Only the last four digits ("••••4321"); the full number is fetched on request. */
  accountNumberMasked?: string;
  accountNumber?: string;
  ifscCode?: string;
  provider?: string;
  walletId?: string;
  openingBalance: number;
  openingDate: string;
  isActive: boolean;
  notes?: string;
  /** Current balance from the ledger; present for Accounts logins only. */
  balance?: number;
}

export interface PaymentAccountInput {
  kind: PaymentAccountKind;
  nickname: string;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  provider?: string;
  walletId?: string;
  openingBalance?: number;
  openingDate?: string;
  isActive?: boolean;
  notes?: string;
}

export interface ClosingRow {
  _id: string;
  nickname: string;
  kind: PaymentAccountKind;
  kindLabel: string;
  isActive: boolean;
  opening: number;
  received: number;
  receivedCount: number;
  otherIn: number;
  paidOut: number;
  closing: number;
  currentBalance: number;
}

export interface CollectionSummary {
  from: string;
  to: string;
  accounts: ClosingRow[];
  byKind: Record<PaymentAccountKind, { received: number; closing: number; currentBalance: number }>;
  unassigned: { received: number; count: number };
  totals: { opening: number; received: number; otherIn: number; paidOut: number; closing: number; currentBalance: number; collected: number };
}

export interface LedgerEntry {
  _id: string;
  transactionNumber?: string;
  transactionType: string;
  category: string;
  description: string;
  amount: number;
  date: string;
  direction: "in" | "out" | null;
  status: string;
  reference?: string;
  referenceNumber?: string;
  customerId?: { name?: string } | null;
  invoiceId?: { invoiceNumber?: string } | null;
  sourcePaymentId?: string;
  sourceRefundPaymentId?: string;
}

export const KIND_LABEL: Record<PaymentAccountKind, string> = { cash: "Cash", bank: "Bank account", wallet: "Wallet / UPI (Paytm…)" };

/** Cash is received into a cash account; every other method into a bank or wallet account (same rule as the API). */
export const fitsMethod = (kind: PaymentAccountKind, method: string) => (method === "cash" ? kind === "cash" : kind !== "cash");

/** "Today" as the server counts days: the calendar day in India. */
export const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export const paymentAccountsApi = {
  list: (activeOnly = false) =>
    apiClient.get<{ accounts: PaymentAccount[] }>(`/payment-accounts${activeOnly ? "?active=true" : ""}`).then((r) => r?.accounts || []),
  get: (id: string, reveal = false) =>
    apiClient.get<{ account: PaymentAccount }>(`/payment-accounts/${id}${reveal ? "?reveal=true" : ""}`).then((r) => r.account),
  create: (input: PaymentAccountInput) => apiClient.post<{ account: PaymentAccount }>("/payment-accounts", input).then((r) => r.account),
  update: (id: string, input: Partial<PaymentAccountInput>) => apiClient.put<{ account: PaymentAccount }>(`/payment-accounts/${id}`, input).then((r) => r.account),
  remove: (id: string) => apiClient.delete(`/payment-accounts/${id}`),
  adjust: (id: string, input: { actualBalance: number; date: string; note: string }) =>
    apiClient.post<{ recorded: number; difference: number }>(`/payment-accounts/${id}/adjust`, input),
  summary: (params: { from: string; to?: string; accountId?: string }) =>
    apiClient.get<CollectionSummary>("/payment-accounts/summary", params),
  ledger: (id: string, params: { from?: string; to?: string; page?: number; limit?: number }) =>
    apiClient.get<{ entries: LedgerEntry[]; pagination: { page: number; limit: number; total: number; pages: number } }>(`/payment-accounts/${id}/ledger`, params)
};
