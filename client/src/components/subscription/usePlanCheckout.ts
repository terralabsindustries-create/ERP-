import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  cancelOrder, createPlanOrder, fetchPlans, fetchSubscription, openRazorpayPayment, syncOrder, verifyPayment,
  type PlanPack, type SettleResult,
} from "@/lib/razorpay";

/*
  Plan state and the Razorpay checkout flow, shared by the Plan & billing page
  and the plan prompt shown when the app opens.

  Plan data lives in the shared query cache, so the prompt and the page share
  one copy and moving around the app does not ask again:
  - the pack catalogue (`plans`) changes only with a release: kept for hours;
  - the business's plan and purchases (`subscription`) for five minutes, and
    refreshed straight after any payment settles.

  Razorpay is asked about an order only for orders this browser started in
  this session and that are still open (a closed tab or lost callback). Older
  open orders are settled by the server's webhook and reconciler, never by
  re-checking them on every app load.
*/
export const PLAN_KEYS = { plans: ["plans"] as const, subscription: ["subscription"] as const };

const STARTED_KEY = "plan-orders-started";
const readStarted = (): string[] => {
  try { return JSON.parse(sessionStorage.getItem(STARTED_KEY) || "[]"); } catch { return []; }
};
const writeStarted = (ids: string[]) => {
  try { sessionStorage.setItem(STARTED_KEY, JSON.stringify(ids.slice(-5))); } catch { /* private mode */ }
};

export function usePlanCheckout(enabled = true) {
  const { toast } = useToast();
  const { refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const paidListeners = useRef<Array<() => void>>([]);

  const plansQuery = useQuery({ queryKey: PLAN_KEYS.plans, queryFn: fetchPlans, enabled, staleTime: 6 * 3600_000 });
  const subQuery = useQuery({ queryKey: PLAN_KEYS.subscription, queryFn: fetchSubscription, enabled, staleTime: 5 * 60_000 });

  const reload = useCallback(() => queryClient.invalidateQueries({ queryKey: PLAN_KEYS.subscription }), [queryClient]);

  const afterSettled = useCallback(async (result: SettleResult) => {
    await reload();
    if (result.state === "paid") {
      await refreshUser();
      toast({ title: "Payment confirmed", description: "Your plan is active for everyone in your business." });
      paidListeners.current.forEach((fn) => fn());
    }
  }, [reload, refreshUser, toast]);

  // Orders started in this browser session and left open: check each once.
  const resumed = useRef(false);
  const purchases = subQuery.data?.purchases;
  useEffect(() => {
    if (!enabled || resumed.current || !purchases) return;
    resumed.current = true;
    const started = readStarted();
    const open = purchases.filter((p) => p.status === "created" && started.includes(p.orderId));
    if (!open.length) return;
    writeStarted(started.filter((id) => !open.some((p) => p.orderId === id)));
    (async () => {
      for (const p of open) {
        const r = await syncOrder(p.orderId).catch(() => null);
        if (r?.state === "paid") await afterSettled(r);
      }
    })();
  }, [enabled, purchases, afterSettled]);

  // The payment may be captured moments after the callback; poll a few times.
  const confirmWithServer = async (orderId: string) => {
    setConfirming(orderId);
    try {
      for (let i = 0; i < 6; i++) {
        const r = await syncOrder(orderId).catch(() => null);
        if (r?.state === "paid") return afterSettled(r);
        if (r?.state === "failed") break;
        await new Promise((res) => setTimeout(res, 5000));
      }
      await reload();
      toast({ title: "Payment not confirmed yet", description: "If you were charged, your plan will activate automatically. You can also press “Check payment status”." });
    } finally {
      setConfirming(null);
    }
  };

  const buy = async (pack: PlanPack) => {
    if (busyPack) return; // one checkout at a time: no second order from a double click
    setBusyPack(pack.id);
    let finished = false;
    try {
      const { keyId, order } = await createPlanOrder(pack.id);
      writeStarted([...readStarted(), order.id]);
      await openRazorpayPayment(
        {
          key: keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.id,
          name: "Carbon Print Flow",
          description: `${pack.label} plan — one-time payment, no auto-renewal`,
          handler: async (response) => {
            finished = true;
            setBusyPack(null);
            writeStarted(readStarted().filter((id) => id !== order.id));
            try {
              const result = await verifyPayment(response);
              if (result.state === "paid") await afterSettled(result);
              else await confirmWithServer(order.id);
            } catch {
              toast({ title: "Confirming your payment", description: "We could not confirm it instantly; checking again." });
              await confirmWithServer(order.id);
            }
          },
          modal: {
            ondismiss: () => {
              if (finished) return;
              setBusyPack(null);
              writeStarted(readStarted().filter((id) => id !== order.id));
              cancelOrder(order.id).then(reload).catch(() => undefined);
              toast({ title: "Checkout closed", description: "You have not been charged. You can try again any time." });
            },
          },
        },
        (message) => toast({ title: "Payment failed", description: message, variant: "destructive" })
      );
    } catch (e: any) {
      setBusyPack(null);
      toast({ title: "Could not start payment", description: e.message, variant: "destructive" });
    }
  };

  const checkOrder = async (orderId: string) => {
    setConfirming(orderId);
    try {
      const r = await syncOrder(orderId);
      await afterSettled(r);
      if (r.state !== "paid") toast({ title: "Not confirmed", description: r.message });
    } catch (e: any) {
      toast({ title: "Could not check", description: e.message, variant: "destructive" });
    } finally {
      setConfirming(null);
    }
  };

  // Stable, and returns an unsubscribe so effects can clean up.
  const onPaid = useCallback((fn: () => void) => {
    paidListeners.current.push(fn);
    return () => { paidListeners.current = paidListeners.current.filter((f) => f !== fn); };
  }, []);

  return {
    packs: plansQuery.data?.packs || [],
    status: subQuery.data?.subscription,
    purchases: subQuery.data?.purchases || [],
    canPurchase: subQuery.data?.canPurchase ?? plansQuery.data?.canPurchase ?? false,
    loading: enabled && (plansQuery.isPending || subQuery.isPending),
    error: subQuery.error || plansQuery.error,
    retry: () => { plansQuery.refetch(); subQuery.refetch(); },
    busyPack,
    confirming,
    buy,
    checkOrder,
    onPaid,
  };
}
