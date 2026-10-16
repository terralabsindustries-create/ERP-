import { Link } from "react-router-dom";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface PanelProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** A count shown next to the title, e.g. the number of rows */
  count?: number;
  /** Highlights the count when the panel holds something urgent */
  countTone?: "default" | "danger" | "warning";
  /** Buttons or a PanelLink on the right of the header */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}

const COUNT_TONES = {
  default: "bg-muted text-muted-foreground",
  danger: "bg-destructive-soft text-destructive-strong",
  warning: "bg-warning-soft text-warning-strong",
};

/** A titled card: the building block of the dashboard and summary screens. */
export function Panel({
  title,
  description,
  icon: Icon,
  count,
  countTone = "default",
  action,
  children,
  className,
  bodyClassName,
  id,
}: PanelProps) {
  return (
    <section id={id} className={cn("flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-card", className)}>
      <header className="flex min-h-[52px] items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold leading-tight">
              <span className="truncate">{title}</span>
              {typeof count === "number" && (
                <span className={cn("num rounded-full px-1.5 py-px text-[11px] font-semibold leading-4", COUNT_TONES[countTone])}>
                  {count}
                </span>
              )}
            </h2>
            {description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
          </div>
        </div>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </header>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/** The "View all →" link in a panel header. */
export function PanelLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}
