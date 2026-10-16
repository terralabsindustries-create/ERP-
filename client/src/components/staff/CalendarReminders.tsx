import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { differenceInCalendarDays } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Calendar,
  Clock,
  AlertCircle,
  CheckCircle,
  User,
  Bell,
  CalendarDays,
  Filter,
  List,
  Grid3x3
} from "lucide-react";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import { StatCard } from "@/components/common/StatTile";

interface Task {
  _id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string;
  jobId?: string | { _id: string; title: string };
  assignedTo?: string | { _id: string; fullName: string };
}

interface CalendarRemindersProps {
  onTaskUpdate?: () => void;
}

export function CalendarReminders({ onTaskUpdate }: CalendarRemindersProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed' | 'overdue'>('all');
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);

  useEffect(() => {
    fetchTasks();
  }, [user]);

  const fetchTasks = async () => {
    if (!user || !(user as any).id) return;

    try {
      setLoading(true);
      const staffId = (user as any).id;
      const response: any = await apiClient.get(`/tasks/by-staff/${staffId}`);

      let tasksData: Task[] = [];
      if (response?.data) {
        tasksData = response.data;
      } else if (Array.isArray(response)) {
        tasksData = response;
      }

      setTasks(tasksData);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  };

  const updateTaskStatus = async (taskId: string, newStatus: string) => {
    try {
      setUpdatingTaskId(taskId);
      await apiClient.updateTaskStatus(taskId, newStatus);

      toast({
        title: "Task Updated",
        description: `Task status changed to ${newStatus}`,
      });

      fetchTasks();
      onTaskUpdate?.();
    } catch (error: any) {
      console.error('Error updating task:', error);
      toast({
        title: "Error",
        description: error?.message || "Failed to update task",
        variant: "destructive",
      });
    } finally {
      setUpdatingTaskId(null);
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'border-destructive/25 bg-destructive-soft text-destructive-strong';
      case 'high': return 'border-warning/30 bg-warning-soft text-warning-strong';
      case 'medium': return 'border-info/25 bg-info-soft text-info-strong';
      case 'low': return 'border-border bg-muted text-muted-foreground';
      default: return 'border-border bg-muted text-muted-foreground';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'border-success/25 bg-success-soft text-success-strong';
      case 'in_progress': return 'border-info/25 bg-info-soft text-info-strong';
      case 'pending': return 'border-border bg-muted text-muted-foreground';
      case 'overdue': return 'border-destructive/25 bg-destructive-soft text-destructive-strong';
      default: return 'border-border bg-muted text-muted-foreground';
    }
  };

  // Overdue once the due day has ended, the rule the team overview uses.
  const isOverdue = (task: Task) => {
    if (!task.dueDate || task.status === 'completed' || task.status === 'cancelled') return false;
    return differenceInCalendarDays(new Date(task.dueDate), new Date()) < 0;
  };

  const formatDueDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatDueTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getDaysUntilDue = (dateString: string) => {
    return differenceInCalendarDays(new Date(dateString), new Date());
  };

  const filteredTasks = tasks.filter(task => {
    if (filter === 'overdue') return isOverdue(task);
    if (filter === 'all') return true;
    return task.status === filter;
  });

  const taskStats = {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    overdue: tasks.filter(t => isOverdue(t)).length,
  };

  const STATUS_LABEL: Record<string, string> = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

  if (loading) {
    return (
      <Panel title="Calendar & reminders" icon={CalendarDays}>
        <div className="space-y-2 p-4 sm:p-5">
          {[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />)}
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Overview */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total tasks" value={taskStats.total} icon={List} />
        <StatCard label="Pending" value={taskStats.pending} icon={Clock} tone={taskStats.pending > 0 ? "warning" : "default"} />
        <StatCard label="In progress" value={taskStats.inProgress} icon={Bell} tone="info" />
        <StatCard label="Completed" value={taskStats.completed} icon={CheckCircle} tone="success" />
        <StatCard label="Overdue" value={taskStats.overdue} icon={AlertCircle} tone={taskStats.overdue > 0 ? "danger" : "default"} />
      </div>

      {/* Main Calendar & Reminders */}
      <Panel
        title="Calendar & reminders"
        icon={CalendarDays}
        count={filteredTasks.length}
        countTone={taskStats.overdue > 0 ? "danger" : "default"}
        action={
          <Select value={filter} onValueChange={(value: any) => setFilter(value)}>
            <SelectTrigger className="h-8 w-[140px] [&>span]:flex-1" aria-label="Filter tasks">
              <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All Tasks</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        {filteredTasks.length === 0 ? (
          <EmptyState
            compact
            icon={Calendar}
            title="No tasks found"
            description={filter === 'all' ? 'No tasks assigned to you yet.' : `No ${filter.replace('_', ' ')} tasks found.`}
          />
        ) : (
          <ul className="divide-y">
            {filteredTasks.map((task) => {
              const overdue = isOverdue(task);
              const open = task.status !== 'completed' && task.status !== 'cancelled';
              const daysUntilDue = task.dueDate && open ? getDaysUntilDue(task.dueDate) : null;
              // Date-only due dates are stored as UTC midnight; they have no time to show.
              const dueHasTime = !!task.dueDate && (new Date(task.dueDate).getUTCHours() !== 0 || new Date(task.dueDate).getUTCMinutes() !== 0);
              return (
                <li
                  key={task._id}
                  className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:px-5 ${overdue ? 'bg-destructive-soft/40' : ''}`}
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="mr-1 text-sm font-semibold">
                        <Link to={`/tasks/${task._id}`} className="hover:underline">{task.title}</Link>
                      </h4>
                      <Badge className={`capitalize ${getPriorityColor(task.priority)}`}>{task.priority}</Badge>
                      <Badge className={getStatusColor(task.status)}>{STATUS_LABEL[task.status] || task.status}</Badge>
                      {overdue && (
                        <Badge variant="destructive">
                          <AlertCircle />
                          Overdue
                        </Badge>
                      )}
                    </div>

                    {task.description && <p className="text-sm text-muted-foreground">{task.description}</p>}

                    {task.dueDate && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDueDate(task.dueDate)}
                        </span>
                        {dueHasTime && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" />
                            {formatDueTime(task.dueDate)}
                          </span>
                        )}
                        {daysUntilDue !== null && (
                          <span className={`font-semibold ${
                            overdue ? 'text-destructive-strong' :
                            daysUntilDue <= 2 ? 'text-warning-strong' :
                            'text-muted-foreground'
                          }`}>
                            {overdue ? `${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? '' : 's'} overdue` :
                             daysUntilDue === 0 ? 'Due today' :
                             daysUntilDue === 1 ? 'Due tomorrow' :
                             `${daysUntilDue} days left`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {task.status !== 'completed' && (
                    <Select
                      value={task.status}
                      onValueChange={(value) => updateTaskStatus(task._id, value)}
                      disabled={updatingTaskId === task._id}
                    >
                      <SelectTrigger className="h-8 w-full sm:w-36" aria-label={`Status of ${task.title}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
