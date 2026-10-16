import { cn } from "@/lib/utils";

export type PillTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";

const TONES: Record<PillTone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" },
  success: { pill: "bg-success-soft text-success-strong", dot: "bg-success" },
  warning: { pill: "bg-warning-soft text-warning-strong", dot: "bg-warning" },
  danger: { pill: "bg-destructive-soft text-destructive-strong", dot: "bg-destructive" },
  info: { pill: "bg-info-soft text-info-strong", dot: "bg-info" },
  primary: { pill: "bg-primary-soft text-primary-strong", dot: "bg-primary" }
};

/** A status as a soft pill with a coloured dot: "● Paid", "● Overdue". */
export function StatusPill({ tone = "neutral", children, className }: { tone?: PillTone; children: React.ReactNode; className?: string }) {
  const t = TONES[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", t.pill, className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.dot)} aria-hidden />
      {children}
    </span>
  );
}

/** A quiet tag, e.g. a category or a team name. */
export function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs", className)}>{children}</span>;
}
