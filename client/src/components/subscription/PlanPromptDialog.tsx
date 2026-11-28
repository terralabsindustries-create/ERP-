import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { PlanPackCards } from "./PlanPackCards";
import { usePlanCheckout } from "./usePlanCheckout";

const SEEN_KEY = "plan-prompt-seen";
const seenThisSession = () => { try { return sessionStorage.getItem(SEEN_KEY) === "1"; } catch { return false; } };
const markSeen = () => { try { sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode */ } };

/**
 * Shown when the app opens for a business that has no running paid plan: pick a
 * pack and Razorpay opens. Admins can buy; other logins see only a notice when
 * the plan has run out. Closing it never blocks the app, and it appears once
 * per browser session.
 */
export function PlanPromptDialog() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const isAdmin = user?.role === "admin";
  // Whether the business needs a plan is already known from the signed-in
  // profile (/auth/me carries the entitlement), so nothing is fetched for a
  // business with a paid plan. Pack prices load only when the prompt opens.
  const sub = user?.subscription;
  const needsPrompt = !!user && !!sub && sub.status !== "paid" && (isAdmin || sub.isActive === false) && !seenThisSession();
  useEffect(() => {
    if (needsPrompt) setOpen(true);
  }, [needsPrompt]);
  const plan = usePlanCheckout(open && isAdmin);
  const { onPaid } = plan;
  const status = plan.status || sub;

  useEffect(() => onPaid(() => setOpen(false)), [onPaid]);

  const close = () => { markSeen(); setOpen(false); };
  const expired = status && !status.isActive;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="max-w-5xl overflow-y-auto max-h-[90dvh]">
        <DialogHeader>
          <DialogTitle>{expired ? "Your plan has ended" : "Choose your plan"}</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? "Pay once for the period you choose — nothing renews automatically. Select a pack to pay securely with Razorpay."
              : "Your business plan has ended. Please ask your business admin to renew it."}
          </DialogDescription>
        </DialogHeader>
        {isAdmin && (
          <PlanPackCards
            packs={plan.packs}
            canPurchase={plan.canPurchase}
            busyPack={plan.busyPack}
            disabled={!!plan.confirming}
            onSelect={(pack) => { markSeen(); plan.buy(pack); }}
          />
        )}
        <div className="flex justify-end gap-2">
          {isAdmin && <Button variant="ghost" onClick={() => { close(); navigate("/subscription"); }}>View plan & billing</Button>}
          <Button variant="outline" onClick={close}>Maybe later</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
