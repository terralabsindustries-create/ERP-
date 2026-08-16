import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  AlertTriangle,
  Clock,
  Download,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { format } from "date-fns";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

interface ActivityEntry {
  _id: string;
  action: string;
  description: string;
  entityType: string;
  entityId: string;
  entityName?: string;
  performedBy?: { _id: string; fullName?: string; email?: string } | null;
  performedByName: string;
  actionType: string;
  changes?: { before?: unknown; after?: unknown; fields?: string[] };
  severity: "low" | "medium" | "high" | "critical";
  tags?: string[];
  createdAt: string;
}

interface ActivityStats {
  totalActivities: number;
  activitiesByType: { _id: string; count: number }[];
  activitiesByUser: { _id: string; userName: string; count: number }[];
  criticalActivities: number;
}

const ENTITY_TYPES = ["customer", "job", "invoice", "payment", "inventory", "vendor", "staff", "task", "delivery", "emergency_order", "walk_in_job", "proof", "time_entry", "event", "discount_rule", "customer_pricing", "hsn_code", "account_transaction", "cheque", "cost", "user", "system"];
const ACTION_TYPES = ["create", "read", "update", "delete", "login", "logout", "export", "import", "approve", "reject", "assign", "complete", "cancel", "start", "pause", "stop", "upload", "download", "send", "receive"];
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

const prettify = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const severityBadgeVariant = (severity: string) => {
  switch (severity) {
    case "critical":
      return "destructive" as const;
    case "high":
      return "destructive" as const;
    case "medium":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
};

const actionTypeBadgeVariant = (actionType: string) => {
  switch (actionType) {
    case "create":
      return "default" as const;
    case "update":
      return "secondary" as const;
    case "delete":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
};

const EMPTY_FILTERS = {
  search: "",
  entityType: "all",
  actionType: "all",
  severity: "all",
  dateFrom: "",
  dateTo: "",
};

const ActivityLog = () => {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ current: 1, total: 1, totalActivities: 0 });

  const { toast } = useToast();
  const { user, hasPermission } = useAuth();

  const canExport = hasPermission("Activity Log: Export");
  const canDelete = user?.role === "admin";

  const activeFilterParams = useCallback(
    () => ({
      ...(filters.search ? { search: filters.search } : {}),
      ...(filters.entityType !== "all" ? { entityType: filters.entityType } : {}),
      ...(filters.actionType !== "all" ? { actionType: filters.actionType } : {}),
      ...(filters.severity !== "all" ? { severity: filters.severity } : {}),
      ...(filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
      ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
    }),
    [filters]
  );

  const fetchActivities = useCallback(
    async (showSpinner = false) => {
      if (showSpinner) setRefreshing(true);
      try {
        const response = await apiClient.getActivityLog({
          ...activeFilterParams(),
          page,
          limit: 20,
        });
        setActivities(response.data?.activities || []);
        setPagination(response.data?.pagination || { current: 1, total: 1, totalActivities: 0 });
      } catch (error) {
        console.error("Error fetching activities:", error);
        toast({
          title: "Error",
          description: "Failed to fetch activity logs",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeFilterParams, page, toast]
  );

  const fetchStats = useCallback(async () => {
    try {
      const response = await apiClient.getActivityStats(30);
      setStats(response.data?.stats || null);
    } catch (error) {
      console.error("Error fetching activity stats:", error);
    }
  }, []);

  useEffect(() => {
    fetchActivities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filters]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Reset to page 1 whenever filters change
  const updateFilter = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const hasActiveFilters = Object.entries(filters).some(([key, value]) =>
    key === "entityType" || key === "actionType" || key === "severity" ? value !== "all" : value !== ""
  );

  const handleExport = async () => {
    setExporting(true);
    try {
      await apiClient.downloadActivityLog(activeFilterParams());
      toast({ title: "Exported", description: "Activity log exported successfully" });
    } catch (error) {
      console.error("Error exporting activity log:", error);
      toast({
        title: "Export failed",
        description: "Could not export the activity log",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this activity log entry? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await apiClient.deleteActivityLogEntry(id);
      toast({ title: "Deleted", description: "Activity log entry deleted" });
      fetchActivities();
      fetchStats();
    } catch (error) {
      console.error("Error deleting activity entry:", error);
      toast({
        title: "Error",
        description: "Failed to delete activity log entry",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const formatTimeAgo = (timestamp: string) => {
    const diffMs = Date.now() - new Date(timestamp).getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

  const topActionType = stats?.activitiesByType?.[0];
  const topUser = stats?.activitiesByUser?.[0];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Activity Log</h1>
          <p className="text-muted-foreground">Track all system activities and user actions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetchActivities(true);
              fetchStats();
            }}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {canExport && (
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
              <Download className="h-4 w-4 mr-2" />
              {exporting ? "Exporting..." : "Export"}
            </Button>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Total (30d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalActivities ?? "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Critical / High (30d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.criticalActivities ?? "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              Most Active User
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate">{topUser?.userName ?? "—"}</div>
            {topUser && <p className="text-xs text-muted-foreground">{topUser.count} actions</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top Action</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold capitalize">{topActionType?._id ?? "—"}</div>
            {topActionType && <p className="text-xs text-muted-foreground">{topActionType.count} times</p>}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search action, description, entity, user..."
                className="pl-8"
                value={filters.search}
                onChange={(e) => updateFilter("search", e.target.value)}
              />
            </div>
            <Select value={filters.entityType} onValueChange={(v) => updateFilter("entityType", v)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Entity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Entities</SelectItem>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {prettify(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.actionType} onValueChange={(v) => updateFilter("actionType", v)}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                {ACTION_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {prettify(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.severity} onValueChange={(v) => updateFilter("severity", v)}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severities</SelectItem>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {prettify(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground">From</label>
              <Input
                type="date"
                className="w-40"
                value={filters.dateFrom}
                onChange={(e) => updateFilter("dateFrom", e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground">To</label>
              <Input
                type="date"
                className="w-40"
                value={filters.dateTo}
                onChange={(e) => updateFilter("dateTo", e.target.value)}
              />
            </div>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-4 w-4 mr-1" />
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Activity Feed */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            Activities
            {pagination.totalActivities > 0 && (
              <span className="text-muted-foreground font-normal text-sm ml-2">
                ({pagination.totalActivities} total)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : activities.length === 0 ? (
            <p className="text-center text-muted-foreground py-10">No activity found for the selected filters.</p>
          ) : (
            <div className="space-y-3">
              {activities.map((activity) => {
                const isExpanded = expandedId === activity._id;
                const hasChanges = activity.changes && (activity.changes.before || activity.changes.after);
                return (
                  <div key={activity._id} className="rounded-lg border">
                    <div
                      className="flex items-start gap-3 p-3 cursor-pointer hover:bg-muted/40"
                      onClick={() => hasChanges && setExpandedId(isExpanded ? null : activity._id)}
                    >
                      <div className="flex-1 space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{activity.action}</p>
                          <Badge variant={actionTypeBadgeVariant(activity.actionType)}>{activity.actionType}</Badge>
                          <Badge variant="outline">{prettify(activity.entityType)}</Badge>
                          {activity.severity !== "low" && (
                            <Badge variant={severityBadgeVariant(activity.severity)}>{activity.severity}</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{activity.description}</p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{activity.performedByName}</span>
                          {activity.entityName && (
                            <>
                              <span>•</span>
                              <span>{activity.entityName}</span>
                            </>
                          )}
                          <span>•</span>
                          <Clock className="h-3 w-3" />
                          <span title={format(new Date(activity.createdAt), "PPpp")}>
                            {formatTimeAgo(activity.createdAt)}
                          </span>
                        </div>
                      </div>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={deletingId === activity._id}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(activity._id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    {isExpanded && hasChanges && (
                      <div className="border-t bg-muted/20 p-3 text-xs space-y-2">
                        {activity.changes?.fields && activity.changes.fields.length > 0 && (
                          <p className="text-muted-foreground">
                            Changed fields: <span className="font-medium">{activity.changes.fields.join(", ")}</span>
                          </p>
                        )}
                        <div className="grid md:grid-cols-2 gap-3">
                          <div>
                            <p className="font-medium mb-1">Before</p>
                            <pre className="bg-background rounded p-2 overflow-x-auto">
                              {JSON.stringify(activity.changes?.before ?? {}, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <p className="font-medium mb-1">After</p>
                            <pre className="bg-background rounded p-2 overflow-x-auto">
                              {JSON.stringify(activity.changes?.after ?? {}, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!loading && pagination.total > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-sm text-muted-foreground">
                Page {pagination.current} of {pagination.total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.current <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.current >= pagination.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ActivityLog;
