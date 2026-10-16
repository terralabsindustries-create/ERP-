import { cn } from "@/lib/utils";

export interface ViewTab<V extends string = string> {
  value: V;
  label: string;
  count?: number;
  /** Highlights the count, e.g. overdue items. */
  tone?: "default" | "danger" | "warning";
  icon?: React.ComponentType<{ className?: string }>;
}

const COUNT_TONE = {
  default: "bg-muted text-muted-foreground",
  danger: "bg-destructive-soft text-destructive-strong",
  warning: "bg-warning-soft text-warning-strong"
};

/**
 * An underlined row of views over one list (All / Unpaid / Overdue…) or of a
 * page's sections. Scrolls sideways on narrow screens instead of wrapping.
 */
export function ViewTabs<V extends string>({
  tabs,
  value,
  onChange,
  className,
  trailing
}: {
  tabs: ViewTab<V>[];
  value: V;
  onChange: (v: V) => void;
  className?: string;
  /** Something on the right of the row, e.g. a secondary control. */
  trailing?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4 border-b", className)}>
      <div role="tablist" className="-mb-px flex min-w-0 gap-5 overflow-x-auto [scrollbar-width:none] sm:gap-6 [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = t.value === value;
          const Icon = t.icon;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.value)}
              className={cn(
                "relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {t.label}
              {typeof t.count === "number" && (
                <span className={cn("num rounded-full px-1.5 py-px text-[11px] font-semibold leading-4", COUNT_TONE[t.tone && t.count ? t.tone : "default"])}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {trailing && <div className="hidden shrink-0 pb-1.5 sm:block">{trailing}</div>}
    </div>
  );
}
