import { CheckCircle2, PackageX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { qtyText, unitText, type StockItem } from "./stock";

/**
 * "In stock: 120 reams", or a warning when the line needs more than there is.
 * `blocking` says the document cannot be saved short (an invoice takes the
 * stock); otherwise it is a heads-up (a job ticket only plans to use it).
 */
export function StockAvailability({ item, needed, blocking, className }: { item: StockItem; needed: number; blocking?: boolean; className?: string }) {
  const available = Number(item.quantity) || 0;
  const unit = unitText(item.unit);
  const short = needed > available;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs",
        short ? (blocking ? "font-medium text-destructive-strong" : "font-medium text-warning-strong") : "text-muted-foreground",
        className
      )}
    >
      {short ? <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success-strong" />}
      <span>
        {short
          ? `Only ${qtyText(available)} ${unit} in stock; this needs ${qtyText(needed)}.${blocking ? " Add stock before saving the invoice." : ""}`
          : `In stock: ${qtyText(available)} ${unit}${needed > 0 ? ` · this uses ${qtyText(needed)}` : ""}`}
      </span>
    </p>
  );
}

export interface StockCheckRow {
  key: string | number;
  name: string;
  needed: number;
  /** Undefined when the line is not a stock item. */
  item?: StockItem;
}

/** Each stock item a document uses, what it needs and what is on hand. */
export function StockCheckList({ rows, blocking }: { rows: StockCheckRow[]; blocking?: boolean }) {
  const byStock = new Map<string, StockCheckRow>();
  for (const row of rows) {
    if (!row.item) continue;
    const id = row.item._id || row.item.id || row.item.name;
    const previous = byStock.get(id);
    byStock.set(id, previous ? { ...previous, needed: previous.needed + row.needed } : row);
  }
  const stocked = [...byStock.values()];
  if (!stocked.length) return null;
  return (
    <ul className="divide-y rounded-md border bg-card text-sm">
      {stocked.map((r) => {
        const available = Number(r.item!.quantity) || 0;
        const unit = unitText(r.item!.unit);
        const short = r.needed > available;
        return (
          <li key={r.key} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate font-medium">{r.name}</span>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", short ? (blocking ? "text-destructive-strong" : "text-warning-strong") : "text-muted-foreground")}>
              {short ? <PackageX className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5 text-success-strong" />}
              <span className="num">
                {qtyText(available)} {unit} in stock{r.needed > 0 ? ` · needs ${qtyText(r.needed)}` : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
