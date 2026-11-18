import { Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageShell } from "@/components/layout/PageShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { PlanPackCards } from "@/components/subscription/PlanPackCards";
import { usePlanCheckout } from "@/components/subscription/usePlanCheckout";
import { formatPaise, type PurchaseRecord, type SubscriptionStatus } from "@/lib/razorpay";

const IST = { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" } as const;
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", IST) : "—");

const STATUS_LABEL: Record<PurchaseRecord["status"], string> = {
  created: "Not completed", failed: "Failed", cancelled: "Cancelled",
  paid: "Paid", refunded: "Refunded", dispute_lost: "Reversed (dispute)",
};

const planSummary = (s?: SubscriptionStatus) => {
  if (!s) return "";
  if (s.status === "paid") return "Paid plan";
  if (s.status === "trial") return "Free trial";
  if (s.status === "legacy") return "Previous plan";
  return "No active plan";
};

export default function Subscription() {
  const { packs, status, purchases, canPurchase, loading, busyPack, confirming, buy, checkOrder } = usePlanCheckout();

  return (
    <PageShell width="narrow">
      <PageHeader
        title="Plan & billing"
        description={<p className="text-muted-foreground">Prepaid packs. You pay once for the period you choose — nothing renews automatically.</p>}
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <CardDescription>Applies to every login in your business.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <div>
                <div className="text-lg font-semibold">{planSummary(status)}</div>
                {status?.status === "paid" && status.months && <div className="text-sm text-muted-foreground">Last pack: {status.months} month{status.months > 1 ? "s" : ""}</div>}
              </div>
              <div className="text-sm">
                {status?.isActive ? "Access until" : status?.endDate ? "Expired on" : "Access"}{" "}
                <span className="font-medium">{status?.endDate ? fmtDate(status.endDate) : "—"}</span>
              </div>
              <Badge variant={status?.isActive ? "default" : "destructive"}>{status?.isActive ? "Active" : "Not active"}</Badge>
              <span className="text-sm text-muted-foreground">Auto-renew: off</span>
            </div>
          )}
        </CardContent>
      </Card>

      <h2 className="mb-1 text-lg font-semibold">{status?.status === "paid" ? "Extend your plan" : "Choose a pack"}</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {canPurchase
          ? "Buying while your plan is running adds the months after your current end date. Prices are final amounts in INR."
          : "Only your business admin can buy or renew a plan."}
      </p>
      <div className="mb-8">
        <PlanPackCards packs={packs} canPurchase={canPurchase} busyPack={busyPack} disabled={!!confirming} onSelect={buy} />
      </div>

      <Card>
        <CardHeader><CardTitle>Purchase history</CardTitle></CardHeader>
        <CardContent>
          {purchases.length === 0 ? <p className="text-sm text-muted-foreground">No purchases yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Date</th><th className="pr-4 font-medium">Pack</th>
                  <th className="pr-4 font-medium">Amount</th><th className="pr-4 font-medium">Status</th>
                  <th className="pr-4 font-medium">Reference</th><th />
                </tr></thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">{fmtDate(p.paidAt || p.createdAt)}</td>
                      <td className="pr-4">{p.months} month{p.months > 1 ? "s" : ""}</td>
                      <td className="pr-4">{formatPaise(p.amountPaise)}</td>
                      <td className="pr-4">{STATUS_LABEL[p.status]}{p.disputeStatus === "open" ? " (dispute open)" : ""}</td>
                      <td className="pr-4 font-mono text-xs">{p.paymentId || p.orderId}</td>
                      <td className="text-right">
                        {["created", "failed", "cancelled"].includes(p.status) && canPurchase && (
                          <Button size="sm" variant="ghost" disabled={confirming === p.orderId} onClick={() => checkOrder(p.orderId)}>
                            {confirming === p.orderId ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}Check payment status
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-muted-foreground">Charged and not activated? Press “Check payment status”, or contact support with the reference above.</p>
        </CardContent>
      </Card>
    </PageShell>
  );
}
