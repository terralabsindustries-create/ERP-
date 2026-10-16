import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { format, isBefore, addHours, differenceInCalendarDays } from "date-fns";
import { CheckCircle2, ListChecks, RotateCw, User, Calendar, Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import apiClient from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Task {
  _id: string;
  id?: string;
  title: string;
  status: string;
  description?: string;
  priority: string;
  due_date?: string;
  dueDate?: string;
  jobId?: { title?: string } | null;
  jobTitle?: string;
  createdAt?: string;
  updatedAt?: string;
  assignedTo?: any;
  jobs?: any;
  staff?: any;
}

interface TaskWidgetProps {
  onRefresh?: () => void;
}

export function TaskWidget({ onRefresh }: TaskWidgetProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchTasks();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchTasks, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchTasks = async () => {
    try {
      const response = await apiClient.getTasks();
      console.log('📋 Tasks response:', response);
      setTasks(response as Task[]);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      toast({
        title: "Error",
        description: "Failed to load tasks",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const isTaskCompleted = (task: Task) => {
    return task.status === 'completed';
  };

  // The API sends dueDate / assignedTo / jobId; older records used the snake_case names.
  const dueOf = (task: Task) => task.dueDate || task.due_date || null;
  const assigneeOf = (task: Task) => task.assignedTo?.fullName || task.staff?.name;
  const jobOf = (task: Task) => task.jobId?.title || task.jobTitle || task.jobs?.title;

  type Urgency = { rank: number; label: string; tone: "danger" | "warning" | "info" | "muted" };

  const getTaskUrgency = (dueDate: string | null, priority: string): Urgency => {
    if (!dueDate) return { rank: 4, label: "No deadline", tone: "muted" };

    const due = new Date(dueDate);
    const now = new Date();
    const urgent = addHours(now, 4); // Next 4 hours
    const soon = addHours(now, 24); // Next 24 hours

    // Overdue once the due day has ended (the team overview's rule); earlier
    // the same day it is still "due today".
    if (differenceInCalendarDays(due, now) < 0) {
      return { rank: 0, label: "Overdue", tone: "danger" };
    } else if (isBefore(due, urgent)) {
      return { rank: 1, label: isBefore(due, now) ? "Due today" : "Urgent", tone: "danger" };
    } else if (isBefore(due, soon)) {
      return { rank: 2, label: "Due soon", tone: "warning" };
    } else if (priority === 'high') {
      return { rank: 3, label: "High priority", tone: "warning" };
    } else {
      return { rank: 4, label: "On track", tone: "info" };
    }
  };

  const updateTaskStatus = async (taskId: string, newStatus: string) => {
    try {
      await apiClient.updateTaskStatus(taskId, newStatus);
      
      toast({
        title: "Success",
        description: `Task marked as ${newStatus}`,
      });
      
      await fetchTasks();
      onRefresh?.();
    } catch (error) {
      console.error('Error updating task:', error);
      toast({
        title: "Error",
        description: "Failed to update task",
        variant: "destructive",
      });
    }
  };

  const completeTask = async (taskId: string) => {
    setCompleting(taskId);
    await updateTaskStatus(taskId, 'completed');
    setCompleting(null);
  };

  const list = Array.isArray(tasks) ? tasks : [];
  const rows = list
    .map((task) => ({ task, done: isTaskCompleted(task), urgency: getTaskUrgency(dueOf(task), task.priority) }))
    // Open work first, most urgent at the top; finished tasks sink to the bottom.
    .sort((a, b) => Number(a.done) - Number(b.done) || a.urgency.rank - b.urgency.rank);
  const openCount = rows.filter((r) => !r.done).length;
  const lateCount = rows.filter((r) => !r.done && r.urgency.tone === "danger").length;

  const DOT = { danger: "bg-destructive", warning: "bg-warning", info: "bg-info", muted: "bg-muted-foreground/40" };
  const BADGE = { danger: "destructive", warning: "warning", info: "info", muted: "secondary" } as const;

  return (
    <Panel
      title="Active tasks"
      icon={ListChecks}
      count={loading ? undefined : openCount}
      countTone={lateCount > 0 ? "danger" : "default"}
      description={loading ? "Loading…" : lateCount > 0 ? `${lateCount} overdue or due within 4 hours` : "Assigned work across the team"}
      action={
        <Button variant="ghost" size="icon-xs" onClick={fetchTasks} aria-label="Refresh tasks" className="text-muted-foreground">
          <RotateCw />
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2 p-4 sm:p-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState compact tone="success" icon={CheckCircle2} title="All tasks completed!" description="Nothing is waiting on the team right now." />
      ) : (
        <ul className="max-h-[22rem] divide-y overflow-y-auto">
          {rows.map(({ task, done, urgency }) => {
            const due = dueOf(task);
            const job = jobOf(task);
            const assignee = assigneeOf(task);
            const id = task._id || task.id;
            return (
              <li key={id} className={cn("flex items-start gap-3 px-4 py-3 sm:px-5", done && "bg-muted/30")}>
                {done ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[urgency.tone])} />
                )}
                <div className="min-w-0 flex-1">
                  <Link to={`/tasks/${id}`} className={cn("block truncate text-sm font-medium hover:underline", done && "text-muted-foreground line-through")}>
                    {task.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {job && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <Ticket className="h-3 w-3 shrink-0" />
                        <span className="truncate">{job}</span>
                      </span>
                    )}
                    {assignee && (
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {assignee}
                      </span>
                    )}
                    {due && (
                      <span className={cn("inline-flex items-center gap-1", !done && urgency.tone === "danger" && "font-medium text-destructive-strong")}>
                        <Calendar className="h-3 w-3" />
                        {format(new Date(due), 'd MMM, HH:mm')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Badge variant={done ? "success" : BADGE[urgency.tone]}>{done ? "Completed" : urgency.label}</Badge>
                  {!done && (
                    <Button size="xs" variant="outline" loading={completing === id} onClick={() => completeTask(id)}>
                      {completing !== id && <CheckCircle2 />}
                      Complete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
