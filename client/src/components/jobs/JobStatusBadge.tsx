import { cn } from "@/lib/utils";
import { getStage, PRIORITY_STYLES } from "@/lib/printWorkflow";

export function JobStatusBadge({ status, className }: { status?: string; className?: string }) {
  const stage = getStage(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground",
        className
      )}
      title={stage.description}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", stage.dot)} />
      {stage.label}
    </span>
  );
}

export function PriorityBadge({ priority, className }: { priority?: string; className?: string }) {
  const p = PRIORITY_STYLES[priority || "medium"] || PRIORITY_STYLES.medium;
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium",
        p.className,
        className
      )}
    >
      {p.label}
    </span>
  );
}
