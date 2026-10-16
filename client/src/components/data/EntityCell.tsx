import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { initialsOf, tintFor } from "@/lib/avatar";

/**
 * The first cell of a row: a small avatar (initials or an icon), the record's
 * name and a muted second line.
 */
export function EntityCell({
  title,
  subtitle,
  icon: Icon,
  avatar,
  mono,
  className
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** An icon instead of initials. */
  icon?: LucideIcon;
  /** Name to draw initials from; leave out for no avatar. */
  avatar?: string;
  /** Show the title in a monospace face, for codes and numbers. */
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      {Icon ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
      ) : avatar !== undefined ? (
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", tintFor(avatar))} aria-hidden>
          {initialsOf(avatar)}
        </span>
      ) : null}
      <div className="min-w-0">
        <div className={cn("truncate font-medium text-foreground", mono && "font-mono text-[13px]")}>{title}</div>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
    </div>
  );
}

/** Two stacked lines in a cell: a value and a muted note under it. */
export function Stack({ top, bottom, className }: { top: React.ReactNode; bottom?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate">{top}</div>
      {bottom && <div className="truncate text-xs text-muted-foreground">{bottom}</div>}
    </div>
  );
}
