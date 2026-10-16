import { useQuery, useQueryClient } from "@tanstack/react-query";
import apiClient from "@/lib/apiClient";

/** A message to one person, e.g. "Ravi commented on …" (backend/src/models/Notification.js). */
export interface AppNotification {
  _id: string;
  type: "task_assigned" | "task_reassigned" | "task_status" | "task_comment" | "job_assigned";
  title: string;
  message?: string;
  link?: string;
  actorName?: string;
  readAt?: string | null;
  createdAt: string;
}

/** A live condition computed from the records, e.g. "3 jobs past the delivery date". */
export interface LiveAlert {
  id: string;
  severity: "danger" | "warning" | "info";
  title: string;
  message?: string;
  link: string;
  count: number;
}

interface NotificationsData {
  items: AppNotification[];
  unreadCount: number;
  alerts: LiveAlert[];
}

/**
 * Notifications shared by the header bell and the dashboard (one request,
 * refreshed every minute and when the window regains focus).
 */
export function useNotifications() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: () => apiClient.getNotifications() as Promise<NotificationsData>,
    refetchInterval: 60_000,
    staleTime: 20_000
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["notifications"] });

  const markRead = async (id: string) => {
    queryClient.setQueryData<NotificationsData>(["notifications"], (old) =>
      old
        ? {
            ...old,
            unreadCount: Math.max(0, old.unreadCount - (old.items.find((n) => n._id === id && !n.readAt) ? 1 : 0)),
            items: old.items.map((n) => (n._id === id ? { ...n, readAt: new Date().toISOString() } : n))
          }
        : old
    );
    await apiClient.markNotificationRead(id).catch(refresh);
  };

  const markAllRead = async () => {
    await apiClient.markAllNotificationsRead();
    refresh();
  };

  return {
    items: query.data?.items || [],
    unreadCount: query.data?.unreadCount || 0,
    alerts: query.data?.alerts || [],
    loading: query.isLoading,
    error: query.error as Error | null,
    refresh,
    markRead,
    markAllRead
  };
}
