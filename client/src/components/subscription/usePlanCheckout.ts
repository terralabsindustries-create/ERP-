import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  cancelOrder, createPlanOrder, fetchPlans, fetchSubscription, openRazorpayPayment, syncOrder, verifyPayment,
  type PlanPack, type PurchaseRecord, type SettleResult, type SubscriptionStatus,
} from "@/lib/razorpay";

/**
 * Plan state and the Razorpay checkout flow, shared by the Plan & billing page
 * and the plan prompt shown when the app opens. Selecting a pack opens Razorpay
 * straight away; the server prices the order and confirms the payment.
 */
export function usePlanCheckout(enabled = true) {
  const { toast } = useToast();
  const { refreshUser } = useAuth();
  const [packs, setPacks] = useState<PlanPack[]>([]);
  const [status, setStatus] = useState<SubscriptionStatus>();
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [canPurchase, setCanPurchase] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyPack, setBusyPack] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const synced = useRef(false);
  const paidListeners = useRef<Array<() => void>>([]);

  const load = useCallback(async () => {
    const [plans, sub] = await Promise.all([fetchPlans(), fetchSubscription()]);
    setPacks(plans.packs);
    setStatus(sub.subscription);
    setPurchases(sub.purchases);
    setCanPurchase(sub.canPurchase);
    return sub;
  }, []);

  const afterSettled = useCallback(async (result: SettleResult) => {
    await load();
    if (result.state === "paid") {
      await refreshUser();
      toast({ title: "Payment confirmed", description: "Your plan is active for everyone in your business." });
      paidListeners.current.forEach((fn) => fn());
    }
  }, [load, refreshUser, toast]);

  // Orders left open (closed tab, refresh, lost callback): ask Razorpay once on load.
  useEffect(() => {
    if (!enabled) return;
    (async () => {
      try {
        const sub = await load();
        if (synced.current) return;
        synced.current = true;
        const recent = sub.purchases
          .filter((p) => ["created", "failed", "cancelled"].includes(p.status) && Date.now() - new Date(p.createdAt).getTime() < 48 * 3600 * 1000)
          .slice(0, 3);
        for (const p of recent) {
          const r = await syncOrder(p.orderId).catch(() => null);
          if (r?.state === "paid") await afterSettled(r);
        }
      } catch (e: any) {
        toast({ title: "Could not load plan details", description: e.message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [enabled, load, afterSettled, toast]);

  // The payment may be captured moments after the callback; poll a few times.
  const confirmWithServer = async (orderId: string) => {
    setConfirming(orderId);
    try {
      for (let i = 0; i < 6; i++) {
        const r = await syncOrder(orderId).catch(() => null);
        if (r?.state === "paid") return afterSettled(r);
        if (r?.state === "failed") break;
        await new Promise((res) => setTimeout(res, 3000));
      }
      await load();
      toast({ title: "Payment not confirmed yet", description: "If you were charged, your plan will activate automatically. You can also press “Check payment status”." });
    } finally {
      setConfirming(null);
    }
  };

  const buy = async (pack: PlanPack) => {
    setBusyPack(pack.id);
    let finished = false;
    try {
      const { keyId, order } = await createPlanOrder(pack.id);
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
              cancelOrder(order.id).then(load).catch(() => undefined);
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

  return { packs, status, purchases, canPurchase, loading, busyPack, confirming, buy, checkOrder, onPaid };
}
