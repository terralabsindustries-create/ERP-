import apiClient from './apiClient';

/*
  Carbon Print Flow plan purchases. The browser only names a pack; the server
  decides the price and duration and returns the public key id with the order.
*/

export interface PlanPack {
  id: string;
  label: string;
  months: number;
  currency: string;
  amountPaise: number;
  perMonthPaise: number;
  savingsPaise: number;
  savingsPercent: number;
  tag: string | null;
}

export interface PurchaseRecord {
  id: string;
  orderId: string;
  paymentId: string | null;
  packId: string;
  months: number;
  amountPaise: number;
  currency: string;
  status: 'created' | 'failed' | 'cancelled' | 'paid' | 'refunded' | 'dispute_lost';
  disputeStatus: string;
  refundedPaise: number;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface SubscriptionStatus {
  isActive: boolean;
  status: 'paid' | 'trial' | 'legacy' | 'expired';
  plan: string | null;
  packId?: string;
  months?: number;
  startDate?: string | null;
  endDate?: string | null;
  autoRenew: boolean;
}

export interface SettleResult {
  success: boolean;
  state: 'paid' | 'pending' | 'failed' | 'ignored';
  granted: boolean;
  message?: string;
  purchase: PurchaseRecord;
}

interface CheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void;
  modal?: { ondismiss?: () => void };
  prefill?: { name?: string; email?: string; contact?: string };
  theme?: { color?: string };
}

declare global {
  interface Window {
    Razorpay: new (options: CheckoutOptions) => { open: () => void; on: (event: string, cb: (response: any) => void) => void };
  }
}

export const formatPaise = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export const loadRazorpayScript = (): Promise<boolean> =>
  new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

export const openRazorpayPayment = async (
  options: CheckoutOptions,
  onFailed?: (message: string) => void
): Promise<void> => {
  if (!(await loadRazorpayScript()) || !window.Razorpay) {
    throw new Error('Could not load the payment window. Check your connection and try again.');
  }
  if (!options.key) throw new Error('Payments are not available right now.');
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--print-brand').trim();
  const checkout = new window.Razorpay({ ...options, theme: { color: options.theme?.color || brand || undefined } });
  checkout.on('payment.failed', (response: any) =>
    onFailed?.(response?.error?.description || 'The payment failed. You have not been charged.'));
  checkout.open();
};

const call = async <T,>(method: 'get' | 'post', url: string, body?: unknown): Promise<T> => {
  const data: any = method === 'get' ? await apiClient.get(url) : await apiClient.post(url, body ?? {});
  return data as T;
};

export const fetchPlans = () => call<{ packs: PlanPack[]; canPurchase: boolean }>('get', '/razorpay/plans');
export const fetchSubscription = () =>
  call<{ subscription: SubscriptionStatus; purchases: PurchaseRecord[]; canPurchase: boolean }>('get', '/razorpay/subscription');

export const createPlanOrder = (packId: string) =>
  call<{ keyId: string; order: { id: string; amount: number; currency: string }; pack: PlanPack }>('post', '/razorpay/create-order', { packId });

export const verifyPayment = (payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
  call<SettleResult>('post', '/razorpay/verify-payment', payload);

export const cancelOrder = (orderId: string) => call('post', `/razorpay/order/${encodeURIComponent(orderId)}/cancel`);
export const syncOrder = (orderId: string) => call<SettleResult>('post', `/razorpay/order/${encodeURIComponent(orderId)}/sync`);
