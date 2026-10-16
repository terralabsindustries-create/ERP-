import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UNITS_OF_MEASUREMENT } from "@/components/inventory/CreateItemDialog";
import { AREA_UNITS, describeArea, isAreaUnit, type AreaUnit } from "@/lib/billing";
import { formatINR } from "@/lib/format";
import { lineAmount, lineInput, withPricing, type LineDraft, type PricingMode } from "./lineDraft";

const PER_UNIT = UNITS_OF_MEASUREMENT.filter((u) => !isAreaUnit(u.value));

/**
 * The pricing half of a line: per unit (quantity, unit, rate) or by area
 * (length × width in ft or m, pieces, rate per sq ft / sq m), and the amount.
 * Item name and description stay with each dialog, which has its own
 * inventory picker.
 */
export function LinePricingFields({ line, onChange, idPrefix }: { line: LineDraft; onChange: (patch: Partial<LineDraft>) => void; idPrefix: string }) {
  const area = line.pricing !== "unit";
  const dim = area ? AREA_UNITS[line.pricing as AreaUnit].dimension : "";
  const amount = lineAmount(line);
  const summary = area ? describeArea(lineInput(line)) : "";
  // A unit not in the list (e.g. "nos" on an older invoice) stays selectable.
  const units = PER_UNIT.some((u) => u.value === line.unit) || area ? PER_UNIT : [...PER_UNIT, { value: line.unit, label: line.unit }];
  const id = (f: string) => `${idPrefix}-${f}`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
        <div className="col-span-2 space-y-1 sm:col-span-1 lg:col-span-1">
          <Label htmlFor={id("pricing")} className="text-xs">
            Priced
          </Label>
          <Select value={line.pricing} onValueChange={(v) => onChange(withPricing(line, v as PricingMode))}>
            <SelectTrigger id={id("pricing")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unit">Per unit</SelectItem>
              <SelectItem value="sqft">Per sq ft</SelectItem>
              <SelectItem value="sqm">Per sq m</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {area ? (
          <>
            <div className="space-y-1">
              <Label htmlFor={id("length")} className="text-xs">
                Length ({dim})
              </Label>
              <Input id={id("length")} type="number" inputMode="decimal" min="0" step="any" value={line.length} placeholder="6" onChange={(e) => onChange({ length: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id("width")} className="text-xs">
                Width ({dim})
              </Label>
              <Input id={id("width")} type="number" inputMode="decimal" min="0" step="any" value={line.width} placeholder="4" onChange={(e) => onChange({ width: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id("qty")} className="text-xs">
                Pieces
              </Label>
              <Input id={id("qty")} type="number" inputMode="decimal" min="0" step="any" value={line.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor={id("qty")} className="text-xs">
                Quantity
              </Label>
              <Input id={id("qty")} type="number" inputMode="decimal" min="0" step="any" value={line.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
            </div>
            <div className="space-y-1 lg:col-span-2">
              <Label htmlFor={id("unit")} className="text-xs">
                Unit
              </Label>
              <Select value={line.unit} onValueChange={(v) => onChange({ unit: v })}>
                <SelectTrigger id={id("unit")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {units.map((u) => (
                    <SelectItem key={u.value} value={u.value}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}

        <div className="space-y-1">
          <Label htmlFor={id("rate")} className="text-xs">
            {area ? `Rate (₹ / ${AREA_UNITS[line.pricing as AreaUnit].label})` : "Rate (₹)"}
          </Label>
          <Input id={id("rate")} type="number" inputMode="decimal" min="0" step="0.01" value={line.unitPrice} placeholder="0.00" onChange={(e) => onChange({ unitPrice: e.target.value })} />
        </div>
        <div className="space-y-1 text-right">
          <span className="block text-xs text-muted-foreground">Amount</span>
          <span className="num block py-2 text-sm font-medium">{formatINR(amount)}</span>
        </div>
      </div>
      {summary && <p className="rounded-md bg-info-soft px-2.5 py-1.5 text-xs text-info-strong">{summary}</p>}
    </div>
  );
}
