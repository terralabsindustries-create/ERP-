import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CUSTOMER_TYPES, QUICK_CUSTOMER_TYPES } from "@/lib/customerTypes";
import { cn } from "@/lib/utils";

const HINT: Record<string, string> = {
  "Walk-in": "Comes to the counter and orders for themselves",
  Agency: "Orders on behalf of its own clients"
};

/**
 * Walk-in customer or agency, as two buttons. A customer already saved as one
 * of the older types shows that type instead, in a list of all of them.
 */
export function CustomerTypePicker({ value, onChange, id = "customerType", compact }: { value: string; onChange: (value: string) => void; id?: string; compact?: boolean }) {
  const quick = QUICK_CUSTOMER_TYPES.some((t) => t.value === value);

  return (
    <div className="space-y-2">
      <Label id={`${id}-label`} className={compact ? "text-xs" : undefined}>
        Customer type
      </Label>
      {quick ? (
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-labelledby={`${id}-label`}>
          {QUICK_CUSTOMER_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={value === t.value}
              onClick={() => onChange(t.value)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-[13px] transition-colors",
                value === t.value ? "border-primary bg-primary-soft/40 font-medium" : "hover:bg-muted"
              )}
            >
              {t.label}
              {!compact && <span className="block text-xs font-normal text-muted-foreground">{HINT[t.value]}</span>}
            </button>
          ))}
        </div>
      ) : (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} aria-labelledby={`${id}-label`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CUSTOMER_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
