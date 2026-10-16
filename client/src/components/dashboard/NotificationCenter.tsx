import { Link, useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, BellOff, CircleAlert, CheckCheck, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { useNotifications } from "@/hooks/useNotifications";
import { cn } from "@/lib/utils";

/**
 * Dashboard panel: live alerts the login's permissions cover, then their
 * latest messages (assignments, comments, status changes). Same data as the
 * header bell.
 */
export function NotificationCenter({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { items, unreadCount, alerts, loading, markRead, markAllRead } = useNotifications();
  const recent = items.slice(0, 6);

  return (
    <Panel
      className={className}
      title="Notifications"
      count={loading ? undefined : unreadCount}
      countTone={unreadCount > 0 ? "danger" : "default"}
      description={unreadCount ? `${unreadCount} unread` : "Assignments, comments and alerts"}
      action={
        unreadCount > 0 && (
          <Button variant="ghost" size="xs" onClick={markAllRead}>
            <CheckCheck />
            Mark all read
          </Button>
        )
      }
    >
      {loading ? (
        <div className="space-y-2 p-4 sm:p-5">
          {[0, 1].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : alerts.length === 0 && recent.length === 0 ? (
        <EmptyState compact icon={BellOff} title="You're all caught up" description="New task assignments, comments and alerts appear here." />
      ) : (
        <ul className="max-h-[22rem] divide-y overflow-y-auto">
          {alerts.map((a) => (
            <li key={a.id}>
              <Link to={a.link} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-5">
                {a.severity === "danger" ? (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive-strong" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-strong" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{a.title}</span>
                  {a.message && <span className="block text-xs text-muted-foreground">{a.message}</span>}
                </span>
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
          {recent.map((n) => (
            <li key={n._id}>
              <button
                type="button"
                onClick={() => {
                  if (!n.readAt) markRead(n._id);
                  if (n.link) navigate(n.link);
                }}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-5"
              >
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.readAt ? "bg-border" : "bg-primary")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm", !n.readAt && "font-semibold")}>{n.title}</span>
                  {n.message && <span className="line-clamp-2 block text-xs text-muted-foreground">{n.message}</span>}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                    {!n.readAt && <span className="sr-only"> (unread)</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
