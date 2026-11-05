import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { gstByRate, type GstTotals } from "@/lib/billing";
import { formatINR } from "@/lib/format";

interface BillingTotalsProps {
  totals: GstTotals;
  idPrefix: string;
  /** Typed text, so the field can be cleared. */
  designCharge: string;
  onDesignChargeChange: (value: string) => void;
  /** The design charge's GST %, typed text. */
  designChargeGstRate: string;
  onDesignChargeGstRateChange: (value: string) => void;
  /** Leave out on documents without a discount (quotations). */
  discount?: string;
  onDiscountChange?: (value: string) => void;
  /** Shown under the discount field, e.g. a suggested discount. */
  discountHint?: ReactNode;
  isInterState: boolean;
  onInterStateChange: (value: boolean) => void;
  totalLabel?: string;
}

const pct = (n: number) => `${Number.isInteger(n) ? n : Number(n.toFixed(4))}%`;

/**
 * The totals of an invoice or quotation: the lines, the design charge as its
 * own editable line with its GST %, the discount, the taxable amount, the GST
 * by rate (CGST + SGST, or IGST for another state), and the total with GST.
 * The figures are lib/billing.ts gstTotals — what the server will store.
 */
export function BillingTotals({
  totals,
  idPrefix,
  designCharge,
  onDesignChargeChange,
  designChargeGstRate,
  onDesignChargeGstRateChange,
  discount,
  onDiscountChange,
  discountHint,
  isInterState,
  onInterStateChange,
  totalLabel = "Total"
}: BillingTotalsProps) {
  const rates = gstByRate([...totals.lines, totals.design]);
  return (
    <dl className="space-y-2 text-sm">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Items subtotal</dt>
        <dd className="num">{formatINR(totals.subtotal)}</dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt>
          <Label htmlFor={`${idPrefix}-design`} className="font-normal">
            Design charge (₹)
          </Label>
        </dt>
        <dd className="flex items-center gap-2">
          <Input
            id={`${idPrefix}-design`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            className="h-8 w-28 text-right"
            value={designCharge}
            placeholder="0.00"
            onChange={(e) => onDesignChargeChange(e.target.value)}
          />
          <Label htmlFor={`${idPrefix}-design-gst`} className="sr-only">
            Design charge GST %
          </Label>
          <Input
            id={`${idPrefix}-design-gst`}
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="any"
            className="h-8 w-16 text-right"
            value={designChargeGstRate}
            placeholder="GST %"
            title="GST % on the design charge"
            onChange={(e) => onDesignChargeGstRateChange(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </dd>
      </div>
      {onDiscountChange && (
        <div className="flex items-center justify-between gap-3">
          <dt>
            <Label htmlFor={`${idPrefix}-discount`} className="font-normal">
              Discount (₹)
            </Label>
          </dt>
          <dd>
            <Input
              id={`${idPrefix}-discount`}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              className="h-8 w-32 text-right"
              value={discount ?? ""}
              placeholder="0.00"
              onChange={(e) => onDiscountChange(e.target.value)}
            />
          </dd>
        </div>
      )}
      {discountHint}
      <Separator />
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Taxable amount</dt>
        <dd className="num">{formatINR(totals.taxableAmount)}</dd>
      </div>
      {rates.map((r) =>
        isInterState ? (
          <div key={r.rate} className="flex justify-between">
            <dt className="text-muted-foreground">IGST @ {pct(r.rate)}</dt>
            <dd className="num">{formatINR(r.igst)}</dd>
          </div>
        ) : (
          <div key={r.rate} className="space-y-1">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">CGST @ {pct(r.rate / 2)}</dt>
              <dd className="num">{formatINR(r.cgst)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">SGST @ {pct(r.rate / 2)}</dt>
              <dd className="num">{formatINR(r.sgst)}</dd>
            </div>
          </div>
        )
      )}
      {rates.length > 1 && (
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Total GST</dt>
          <dd className="num">{formatINR(totals.gst)}</dd>
        </div>
      )}
      {rates.length === 0 && (
        <div className="flex justify-between">
          <dt className="text-muted-foreground">GST</dt>
          <dd className="num">{formatINR(0)}</dd>
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Checkbox id={`${idPrefix}-interstate`} checked={isInterState} onCheckedChange={(v) => onInterStateChange(v === true)} />
        <Label htmlFor={`${idPrefix}-interstate`} className="text-xs font-normal text-muted-foreground">
          Supply to another state (IGST instead of CGST + SGST)
        </Label>
      </div>
      <Separator />
      <div className="flex justify-between text-base font-semibold">
        <dt>{totalLabel} (incl. GST)</dt>
        <dd className="num">{formatINR(totals.total)}</dd>
      </div>
      {totals.discount > totals.gross && <p className="text-xs text-destructive-strong">The discount is more than the {totalLabel.toLowerCase()} before discount.</p>}
    </dl>
  );
}
