import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** "success" for an all-clear message rather than missing data */
  tone?: "default" | "success";
  /** Less padding, for empty panels on the dashboard */
  compact?: boolean;
  className?: string;
}

/** What a list or panel shows when it has nothing in it. */
export function EmptyState({ icon: Icon, title, description, action, tone = "default", compact, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 px-4 py-8" : "gap-2 px-6 py-14",
        className
      )}
    >
      {Icon && (
        <span
          className={cn(
            "mb-1 flex items-center justify-center rounded-full",
            compact ? "h-9 w-9" : "h-11 w-11",
            tone === "success" ? "bg-success-soft text-success-strong" : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} />
        </span>
      )}
      <p className={cn("font-medium text-foreground", compact ? "text-sm" : "text-base")}>{title}</p>
      {description && <p className="max-w-sm text-xs text-muted-foreground sm:text-sm">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
