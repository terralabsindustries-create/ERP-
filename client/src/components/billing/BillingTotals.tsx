import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { DocumentTotals } from "@/lib/billing";
import { formatINR } from "@/lib/format";

interface BillingTotalsProps {
  totals: DocumentTotals;
  idPrefix: string;
  /** Typed text, so the field can be cleared. */
  designCharge: string;
  onDesignChargeChange: (value: string) => void;
  /** Leave out on documents without a discount (quotations). */
  discount?: string;
  onDiscountChange?: (value: string) => void;
  /** Shown under the discount field, e.g. a suggested discount. */
  discountHint?: ReactNode;
  totalLabel?: string;
}

/**
 * The totals of an invoice or quotation: the lines, the design charge as its
 * own editable line, the discount, and the total. No GST is added.
 */
export function BillingTotals({ totals, idPrefix, designCharge, onDesignChargeChange, discount, onDiscountChange, discountHint, totalLabel = "Total" }: BillingTotalsProps) {
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
        <dd>
          <Input
            id={`${idPrefix}-design`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            className="h-8 w-32 text-right"
            value={designCharge}
            placeholder="0.00"
            onChange={(e) => onDesignChargeChange(e.target.value)}
          />
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
      <div className="flex justify-between text-base font-semibold">
        <dt>{totalLabel}</dt>
        <dd className="num">{formatINR(totals.total)}</dd>
      </div>
      {totals.discount > totals.gross && <p className="text-xs text-destructive-strong">The discount is more than the {totalLabel.toLowerCase()} before discount.</p>}
    </dl>
  );
}
