import { formatDistanceToNow, isPast } from "date-fns";
import { type UserState } from "@/lib/userAdmin";
import { initialsOf as initials, tintFor } from "@/lib/avatar";
import { cn } from "@/lib/utils";

const SIZES = { xs: "h-6 w-6 text-[10px]", sm: "h-7 w-7 text-[11px]", md: "h-9 w-9 text-xs" };

/** Initials in a circle; the owner's is solid. */
export function UserAvatar({ name, owner, size = "md", className }: { name: string; owner?: boolean; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        SIZES[size],
        owner ? "bg-primary text-primary-foreground" : tintFor(name),
        className
      )}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Up to `max` overlapping avatars, then "+n". */
export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  if (names.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="flex items-center" title={names.join(", ")}>
      {names.slice(0, max).map((n, i) => (
        <UserAvatar key={`${n}-${i}`} name={n} size="sm" className={cn("ring-2 ring-card", i > 0 && "-ml-2")} />
      ))}
      {names.length > max && (
        <span className="-ml-2 inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground ring-2 ring-card">
          +{names.length - max}
        </span>
      )}
    </span>
  );
}

const DOTS: Record<UserState, { label: string; dot: string }> = {
  owner: { label: "Active", dot: "bg-success" },
  active: { label: "Active", dot: "bg-success" },
  invited: { label: "Invited", dot: "bg-warning" },
  inactive: { label: "Deactivated", dot: "bg-muted-foreground/50" }
};

/** A coloured dot and label; invitations also show when the link runs out. */
export function StatusIndicator({ state, expiresAt }: { state: UserState; expiresAt?: string }) {
  const expiry = state === "invited" && expiresAt ? new Date(expiresAt) : null;
  const expired = !!expiry && isPast(expiry);
  const meta = DOTS[state];
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", expired ? "bg-destructive" : meta.dot)} aria-hidden />
        <span className={cn(state === "inactive" && "text-muted-foreground")}>{expired ? "Invite expired" : meta.label}</span>
      </span>
      {expiry && !expired && (
        <span className="pl-4 text-xs text-muted-foreground">Link expires {formatDistanceToNow(expiry, { addSuffix: true })}</span>
      )}
    </span>
  );
}

export { DataCard } from "@/components/data/DataTable";
