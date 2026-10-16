import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { Bell, AlertTriangle, CircleAlert, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useNotifications } from "@/hooks/useNotifications";
import { cn } from "@/lib/utils";

/** Header bell: your unread messages plus live alerts your permissions cover. */
export function NotificationBell() {
  const navigate = useNavigate();
  const { items, unreadCount, alerts, loading, markRead, markAllRead } = useNotifications();
  const recent = items.slice(0, 8);
  const badge = unreadCount > 0 ? (unreadCount > 9 ? "9+" : String(unreadCount)) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9 text-muted-foreground hover:text-foreground">
          <Bell className="h-[18px] w-[18px]" />
          {badge ? (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {badge}
            </span>
          ) : alerts.length > 0 ? (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-warning ring-2 ring-card" aria-hidden />
          ) : null}
          <span className="sr-only">
            Notifications{unreadCount ? `, ${unreadCount} unread` : ""}
            {alerts.length ? `, ${alerts.length} alerts` : ""}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unreadCount > 0 && (
            <Button variant="ghost" size="xs" onClick={(e) => { e.preventDefault(); markAllRead(); }}>
              <CheckCheck />
              Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator className="m-0" />

        <div className="max-h-[26rem] overflow-y-auto p-1">
          {alerts.length > 0 && (
            <>
              <p className="section-label px-2 pb-1 pt-2">Needs attention</p>
              {alerts.map((a) => (
                <DropdownMenuItem key={a.id} onClick={() => navigate(a.link)} className="items-start gap-2.5 py-2">
                  {a.severity === "danger" ? (
                    <CircleAlert className="mt-0.5 !text-destructive-strong" />
                  ) : (
                    <AlertTriangle className="mt-0.5 !text-warning-strong" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{a.title}</span>
                    {a.message && <span className="block text-xs text-muted-foreground">{a.message}</span>}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          <p className="section-label px-2 pb-1 pt-2">Messages</p>
          {loading ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">Loading…</div>
          ) : recent.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">No messages yet. Task assignments, comments and status changes show up here.</div>
          ) : (
            recent.map((n) => (
              <DropdownMenuItem
                key={n._id}
                onClick={() => {
                  if (!n.readAt) markRead(n._id);
                  if (n.link) navigate(n.link);
                }}
                className="items-start gap-2.5 py-2"
              >
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-primary")} aria-hidden />
                <span className="min-w-0">
                  <span className={cn("block text-sm", !n.readAt && "font-semibold")}>{n.title}</span>
                  {n.message && <span className="line-clamp-2 block text-xs text-muted-foreground">{n.message}</span>}
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                    {!n.readAt && <span className="sr-only"> (unread)</span>}
                  </span>
                </span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
