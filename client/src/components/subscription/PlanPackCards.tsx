import { Check, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatPaise, type PlanPack } from "@/lib/razorpay";

interface Props {
  packs: PlanPack[];
  canPurchase: boolean;
  busyPack: string | null;
  disabled?: boolean;
  onSelect: (pack: PlanPack) => void;
}

/** The four prepaid packs. Choosing one opens Razorpay checkout. */
export function PlanPackCards({ packs, canPurchase, busyPack, disabled, onSelect }: Props) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {packs.map((pack) => (
        <Card key={pack.id} className={pack.tag === "Recommended" ? "border-primary shadow-md" : undefined}>
          <CardHeader className="pb-2">
            <div className="flex min-h-6 items-center justify-between gap-2">
              <CardTitle className="text-base">{pack.label}</CardTitle>
              {pack.tag && <Badge variant={pack.tag === "Start here" ? "outline" : "default"}>{pack.tag}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-2xl font-bold">{formatPaise(pack.perMonthPaise)}<span className="text-sm font-normal text-muted-foreground"> / month</span></div>
              <div className="text-sm">Pay today: <span className="font-semibold">{formatPaise(pack.amountPaise)}</span></div>
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0" />{pack.months} month{pack.months > 1 ? "s" : ""} of access</li>
              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0" />{pack.savingsPaise > 0 ? `Save ${pack.savingsPercent}% (${formatPaise(pack.savingsPaise)})` : "No commitment beyond 1 month"}</li>
              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0" />One payment, no auto-renewal</li>
            </ul>
            <Button className="w-full" disabled={!canPurchase || !!busyPack || disabled} onClick={() => onSelect(pack)}>
              {busyPack === pack.id ? <Loader2 className="h-4 w-4 animate-spin" /> : `Select & pay ${formatPaise(pack.amountPaise)}`}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
