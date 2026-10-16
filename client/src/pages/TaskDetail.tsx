import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { format, formatDistanceToNow, startOfDay } from "date-fns";
import { ArrowLeft, CalendarClock, MessageSquare, Send, Ticket, User, ClipboardList, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel } from "@/components/common/Panel";
import { EmptyState } from "@/components/common/EmptyState";
import apiClient from "@/lib/apiClient";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { TASK_PRIORITY, TASK_STATUS, describeHistory, type TaskDetail as Task, type TaskHistoryEntry, type TaskStatus } from "@/lib/taskMeta";

/**
 * One task with its conversation and hand-off trail: who assigned it, who is
 * doing it, every status change and comment with author and time. Anyone who
 * can see the task can open this page; what they can change comes from the
 * server (task.access).
 */
export default function TaskDetail() {
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const [task, setTask] = useState<Task | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [nextStatus, setNextStatus] = useState<TaskStatus | "">("");
  const [statusNote, setStatusNote] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = (await apiClient.getTask(taskId)) as Task;
      setTask(t);
      setNextStatus("");
      setState("ready");
    } catch {
      setState("missing");
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const postComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await apiClient.addTaskComment(taskId, comment.trim());
      setComment("");
      await load();
    } catch (error) {
      toast({ title: "Comment not posted", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setPosting(false);
    }
  };

  const saveStatus = async () => {
    if (!nextStatus) return;
    setSavingStatus(true);
    try {
      await apiClient.updateTaskStatus(taskId, nextStatus, statusNote.trim() || undefined);
      toast({ title: `Marked ${TASK_STATUS[nextStatus].label.toLowerCase()}`, description: "The person who assigned it has been notified." });
      setStatusNote("");
      await load();
    } catch (error) {
      toast({ title: "Status not changed", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setSavingStatus(false);
    }
  };

  if (state === "loading") {
    return (
      <div className="page-frame max-w-5xl">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (state === "missing" || !task) {
    return (
      <div className="page-frame max-w-5xl">
        <div className="rounded-xl border bg-card shadow-card">
          <EmptyState
            icon={ClipboardList}
            title="Task not found"
            description="It may have been deleted, or it isn't assigned to you or by you."
            action={<Button variant="outline" onClick={() => navigate(-1)}>Go back</Button>}
          />
        </div>
      </div>
    );
  }

  const status = TASK_STATUS[task.status] || TASK_STATUS.pending;
  const priority = TASK_PRIORITY[task.priority] || TASK_PRIORITY.medium;
  const open = task.status !== "completed" && task.status !== "cancelled";
  // Overdue once the due day has ended — the rule the team overview uses.
  const overdue = open && task.dueDate && new Date(task.dueDate) < startOfDay(new Date());
  // Due dates picked with a date-only field are stored as UTC midnight; show a time only when one was set.
  const dueHasTime = !!task.dueDate && (new Date(task.dueDate).getUTCHours() !== 0 || new Date(task.dueDate).getUTCMinutes() !== 0);
  const canWork = !!task.access?.canWorkOn;
  const canManage = !!task.access?.canManage;
  const statusChoices = (Object.keys(TASK_STATUS) as TaskStatus[]).filter((s) => s !== task.status && (s !== "cancelled" || canManage));

  // Comments and hand-off events in one time-ordered conversation. Tasks made
  // before the trail was recorded have no "created" entry; show one from the
  // record itself so the conversation still starts with who assigned it.
  const history: TaskHistoryEntry[] = task.history.some((h) => h.type === "created")
    ? task.history
    : [{ type: "created", byName: task.userId?.fullName, to: task.assignedTo?.fullName, at: task.createdAt }, ...task.history];
  const timeline = [
    ...history.filter((h) => h.type !== "comment").map((h) => ({ kind: "event" as const, at: h.at, who: h.byName || "Someone", h })),
    ...task.comments.map((c) => ({
      kind: "comment" as const,
      at: c.createdAt,
      who: c.authorName || (typeof c.author === "object" ? c.author?.fullName : "") || "Someone",
      c
    }))
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <div className="page-frame max-w-5xl">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-2 text-muted-foreground" onClick={() => navigate(-1)}>
          <ArrowLeft />
          Back
        </Button>
        <div className="page-heading-row">
          <div>
            <h1 className="page-title">{task.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", priority.className)}>{priority.label} priority</span>
              {overdue && <Badge variant="destructive">Overdue</Badge>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {(task.description || task.notes) && (
            <Panel title="Details">
              <div className="space-y-3 p-4 text-sm sm:p-5">
                {task.description && <p className="whitespace-pre-wrap">{task.description}</p>}
                {task.notes && (
                  <p className="rounded-md bg-muted/60 px-3 py-2 text-muted-foreground">
                    <span className="font-medium text-foreground">Latest note: </span>
                    {task.notes}
                  </p>
                )}
              </div>
            </Panel>
          )}

          <Panel title="Updates" icon={History} count={timeline.length} description="Status changes and comments, oldest first">
            {timeline.length === 0 ? (
              <EmptyState compact icon={MessageSquare} title="No updates yet" />
            ) : (
              <ol className="divide-y">
                {timeline.map((item, i) => (
                  <li key={i} className="flex gap-3 px-4 py-3 sm:px-5">
                    <span
                      className={cn(
                        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                        item.kind === "comment" ? "bg-primary-soft text-primary-strong" : "bg-muted text-muted-foreground"
                      )}
                      aria-hidden
                    >
                      {item.who.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">
                        <span className="font-medium">{item.who}</span>{" "}
                        {item.kind === "event" ? <span className="text-muted-foreground">{describeHistory(item.h)}</span> : <span className="text-muted-foreground">commented</span>}
                      </div>
                      {item.kind === "comment" && <p className="mt-1 whitespace-pre-wrap text-sm">{item.c.text}</p>}
                      {item.kind === "event" && item.h.note && <p className="mt-1 text-sm italic text-muted-foreground">“{item.h.note}”</p>}
                      <time className="mt-0.5 block text-xs text-muted-foreground" dateTime={item.at} title={format(new Date(item.at), "d MMM yyyy, HH:mm")}>
                        {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {canWork && (
              <form onSubmit={postComment} className="space-y-2 border-t p-4 sm:p-5">
                <Label htmlFor="task-comment" className="sr-only">Add a comment</Label>
                <Textarea
                  id="task-comment"
                  rows={3}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Ask a question or report progress — the other person is notified"
                  maxLength={2000}
                />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" loading={posting} disabled={!comment.trim()}>
                    {!posting && <Send />}
                    Post comment
                  </Button>
                </div>
              </form>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Task">
            <dl className="divide-y text-sm">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                <dt className="flex items-center gap-2 text-muted-foreground"><User className="h-4 w-4" />Assigned to</dt>
                <dd className="font-medium">{task.assignedTo?.fullName || "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                <dt className="flex items-center gap-2 text-muted-foreground"><User className="h-4 w-4" />Assigned by</dt>
                <dd className="font-medium">{task.userId?.fullName || "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                <dt className="flex items-center gap-2 text-muted-foreground"><CalendarClock className="h-4 w-4" />Due</dt>
                <dd className={cn("font-medium", overdue && "text-destructive-strong")}>{task.dueDate ? format(new Date(task.dueDate), dueHasTime ? "d MMM yyyy, HH:mm" : "d MMM yyyy") : "No due date"}</dd>
              </div>
              {task.completedAt && (
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd className="font-medium">{format(new Date(task.completedAt), "d MMM yyyy, HH:mm")}</dd>
                </div>
              )}
              {(task.jobId || task.jobTitle) && (
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                  <dt className="flex items-center gap-2 text-muted-foreground"><Ticket className="h-4 w-4" />Job</dt>
                  <dd className="truncate font-medium">
                    {/* Staff without the Jobs module see the job named but not linked; they reach it from "My jobs". */}
                    {hasPermission("Jobs") ? (
                      <Link to={`/jobs?q=${encodeURIComponent(task.jobId?.title || task.jobTitle || "")}`} className="text-primary hover:underline">
                        {task.jobId?.title || task.jobTitle}
                      </Link>
                    ) : (
                      task.jobId?.title || task.jobTitle
                    )}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                <dt className="text-muted-foreground">Last updated</dt>
                <dd>{formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}</dd>
              </div>
            </dl>
          </Panel>

          {canWork && statusChoices.length > 0 && (
            <Panel title="Update status">
              <div className="space-y-3 p-4 sm:p-5">
                <div className="space-y-1.5">
                  <Label htmlFor="task-status">New status</Label>
                  <Select value={nextStatus} onValueChange={(v: TaskStatus) => setNextStatus(v)}>
                    <SelectTrigger id="task-status">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {statusChoices.map((s) => (
                        <SelectItem key={s} value={s}>
                          {TASK_STATUS[s].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="task-status-note">Note (optional)</Label>
                  <Input id="task-status-note" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} placeholder={nextStatus === "on_hold" ? "What is it waiting on?" : "Anything the other person should know"} />
                </div>
                <Button className="w-full" onClick={saveStatus} disabled={!nextStatus} loading={savingStatus}>
                  Save status
                </Button>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
