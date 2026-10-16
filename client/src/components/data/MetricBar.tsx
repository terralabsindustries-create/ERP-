import { cn } from "@/lib/utils";

export type MetricTone = "default" | "success" | "warning" | "danger" | "info";

export interface Metric {
  label: string;
  value: React.ReactNode;
  /** One short line under the value: a count, a period, a comparison. */
  hint?: React.ReactNode;
  tone?: MetricTone;
  /** Makes the cell a button, e.g. to switch the list to that view. */
  onClick?: () => void;
  /** Marks the cell whose view is showing. */
  active?: boolean;
}

const TONE_VALUE: Record<MetricTone, string> = {
  default: "text-foreground",
  success: "text-success-strong",
  warning: "text-warning-strong",
  danger: "text-destructive-strong",
  info: "text-info-strong"
};
const TONE_DOT: Record<MetricTone, string> = {
  default: "bg-muted-foreground/40",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info"
};

const COLS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
};

/**
 * The headline figures of a list page in one connected strip, divided into
 * cells. Every page uses it in the same place, under the title.
 */
export function MetricBar({ metrics, loading, className }: { metrics: Metric[]; loading?: boolean; className?: string }) {
  return (
    <section
      aria-label="Summary"
      className={cn("grid gap-px overflow-hidden rounded-xl border bg-border shadow-card", COLS[metrics.length] || "grid-cols-2 lg:grid-cols-4", className)}
    >
      {metrics.map((m) => {
        const tone = m.tone || "default";
        const Comp = m.onClick ? "button" : "div";
        return (
          <Comp
            key={m.label}
            type={m.onClick ? "button" : undefined}
            onClick={m.onClick}
            aria-pressed={m.onClick ? !!m.active : undefined}
            className={cn(
              "relative min-w-0 bg-card px-4 py-3.5 text-left sm:px-5 sm:py-4",
              m.onClick && "transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              m.active && "bg-primary-soft/40 hover:bg-primary-soft/50"
            )}
          >
            {m.active && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" aria-hidden />}
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[tone])} aria-hidden />
              <span className="truncate">{m.label}</span>
            </div>
            <div className={cn("num mt-1.5 truncate text-xl font-semibold leading-tight tracking-tight sm:text-2xl", TONE_VALUE[tone])}>
              {loading ? <span className="inline-block h-6 w-20 animate-pulse rounded bg-muted align-middle" /> : m.value}
            </div>
            {m.hint !== undefined && !loading && <div className="mt-1 truncate text-xs text-muted-foreground">{m.hint}</div>}
          </Comp>
        );
      })}
    </section>
  );
}
