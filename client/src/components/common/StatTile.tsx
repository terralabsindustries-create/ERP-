import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "danger" | "warning" | "success" | "info";

/** Icon chip, hint text and edge accent for each tone. */
const TONES: Record<StatTone, { chip: string; hint: string; accent: string; border: string }> = {
  default: { chip: "bg-muted text-muted-foreground", hint: "text-muted-foreground", accent: "", border: "" },
  danger: {
    chip: "bg-destructive-soft text-destructive-strong",
    hint: "text-destructive-strong",
    accent: "bg-destructive",
    border: "border-destructive/30",
  },
  warning: {
    chip: "bg-warning-soft text-warning-strong",
    hint: "text-warning-strong",
    accent: "bg-warning",
    border: "border-warning/35",
  },
  success: { chip: "bg-success-soft text-success-strong", hint: "text-success-strong", accent: "", border: "" },
  info: { chip: "bg-info-soft text-info-strong", hint: "text-info-strong", accent: "", border: "" },
};

interface KpiTileProps {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  hint?: React.ReactNode;
  /** danger / warning tiles get a coloured edge so they stand out in a row */
  tone?: StatTone;
  /** 0–100; draws a thin progress bar under the value */
  progress?: number;
  href?: string;
  loading?: boolean;
  action?: React.ReactNode;
}

/** One headline number on the dashboard. */
export function KpiTile({ label, value, icon: Icon, hint, tone = "default", progress, href, loading, action }: KpiTileProps) {
  const t = TONES[tone];
  const body = (
    <div
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-xl border bg-card p-3.5 shadow-card sm:p-4",
        t.border,
        href && "transition-[border-color,box-shadow] duration-150 group-hover:border-primary/40 group-hover:shadow-elevated"
      )}
    >
      {t.accent && <span className={cn("absolute inset-y-0 left-0 w-1", t.accent)} aria-hidden />}
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium leading-tight text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {action}
          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", t.chip)}>
            <Icon className="h-4 w-4" />
          </span>
        </div>
      </div>
      <div className="num mt-1.5 text-2xl font-semibold leading-none tracking-tight text-foreground sm:text-[26px]">
        {loading ? <span className="inline-block h-6 w-16 animate-pulse rounded bg-muted" /> : value}
      </div>
      {typeof progress === "number" && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-500", progress >= 100 ? "bg-success" : "bg-primary")}
            style={{ width: `${Math.max(0, Math.min(progress, 100))}%` }}
          />
        </div>
      )}
      {hint && <div className={cn("mt-auto pt-2 text-xs font-medium leading-snug", t.hint)}>{hint}</div>}
    </div>
  );

  return href ? (
    <Link
      to={href}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {body}
    </Link>
  ) : (
    body
  );
}

interface StatCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: LucideIcon;
  hint?: React.ReactNode;
  tone?: StatTone;
  className?: string;
  onClick?: () => void;
}

/** A compact summary number for the stat row at the top of list pages. */
export function StatCard({ label, value, icon: Icon, hint, tone = "default", className, onClick }: StatCardProps) {
  const t = TONES[tone];
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3.5 text-left shadow-card sm:p-4",
        onClick && "transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {Icon && (
        <span className={cn("hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:flex", t.chip)}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
        <div className="num mt-0.5 truncate text-lg font-semibold leading-tight tracking-tight text-foreground sm:text-xl">{value}</div>
        {hint && (
          <div className={cn("mt-0.5 truncate text-xs", tone === "danger" || tone === "warning" ? t.hint : "text-muted-foreground")}>
            {hint}
          </div>
        )}
      </div>
    </Comp>
  );
}
