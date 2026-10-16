import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import {
  ArrowRight,
  CircleAlert,
  GripVertical,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { cn } from "@/lib/utils";
import {
  dueState,
  getStage,
  nextStage,
  PHASES,
  PRIORITY_STYLES,
  SHOP_FLOOR_STATUSES,
  STAGES,
  type Stage,
} from "@/lib/printWorkflow";

type View = "floor" | "all";

const jobId = (job: any) => job._id || job.id;

export default function ProductionBoard() {
  const [searchParams] = useSearchParams();
  const focusStage = searchParams.get("stage");
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const canMove = hasPermission("Jobs: Change Status");

  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("all");
  const [view, setView] = useState<View>(() =>
    focusStage && !SHOP_FLOOR_STATUSES.includes(focusStage as any) ? "all" : "floor"
  );
  const [dragOver, setDragOver] = useState<string | null>(null);
  const draggedId = useRef<string | null>(null);
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const fetchJobs = async () => {
    try {
      const response: any = await apiClient.getJobs({ limit: 500 });
      setJobs(response?.jobs || (Array.isArray(response) ? response : []));
    } catch (error) {
      console.error("Error fetching jobs:", error);
      toast({ title: "Error", description: "Failed to load jobs", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 60000);
    return () => clearInterval(interval);
  }, []);

  // Bring the stage linked from the dashboard into view.
  useEffect(() => {
    if (!loading && focusStage) {
      columnRefs.current[focusStage]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [loading, focusStage, view]);

  const columns: Stage[] = useMemo(
    () => (view === "floor" ? STAGES.filter((s) => SHOP_FLOOR_STATUSES.includes(s.status)) : STAGES),
    [view]
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return jobs.filter((job) => {
      if (priority !== "all" && job.priority !== priority) return false;
      if (!term) return true;
      return [job.title, job.customerId?.name, job.customerName, job.customerId?.company, job.printSpecs?.paperType]
        .filter(Boolean)
        .some((v: string) => v.toLowerCase().includes(term));
    });
  }, [jobs, search, priority]);

  const byStage = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const s of STAGES) map[s.status] = [];
    for (const job of filtered) {
      if (map[job.status]) map[job.status].push(job);
    }
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const pa = rank[a.priority] ?? 2;
        const pb = rank[b.priority] ?? 2;
        if (pa !== pb) return pa - pb;
        const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        return da - db;
      });
    }
    // Delivered work piles up forever; the board only needs the latest.
    map.delivered = map.delivered.slice(0, 15);
    return map;
  }, [filtered]);

  const openJobs = jobs.filter((j) => !["delivered", "cancelled"].includes(j.status));
  const overdue = openJobs.filter((j) => dueState(j.dueDate, j.status) === "overdue").length;
  const dueToday = openJobs.filter((j) => dueState(j.dueDate, j.status) === "today").length;
  const rush = openJobs.filter((j) => j.priority === "urgent").length;

  const moveJob = async (job: any, status: string) => {
    if (!canMove || job.status === status) return;
    const previous = job.status;
    setJobs((list) => list.map((j) => (jobId(j) === jobId(job) ? { ...j, status } : j)));
    try {
      await apiClient.updateJobStatus(jobId(job), status, `Moved to ${getStage(status).label} on the production board`);
      toast({ title: "Job moved", description: `${job.title} → ${getStage(status).label}` });
    } catch (error: any) {
      setJobs((list) => list.map((j) => (jobId(j) === jobId(job) ? { ...j, status: previous } : j)));
      toast({
        title: "Could not move job",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    }
  };

  const onDrop = (status: string) => {
    setDragOver(null);
    const id = draggedId.current;
    draggedId.current = null;
    const job = jobs.find((j) => jobId(j) === id);
    if (job) moveJob(job, status);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-4 px-4 pb-3 pt-5 sm:px-6 md:pb-4 md:pt-6">
        <PageHeader
          eyebrow="Production"
          title="Production Board"
          description={
            canMove
              ? "Every job ticket by stage. Drag a card, or use its arrow, to move it along."
              : "Every job ticket by stage."
          }
          actions={
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setLoading(true); fetchJobs(); }}>
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                Refresh
              </Button>
              {hasPermission("Jobs: Create & Edit") && (
                <Button size="sm" className="gap-1.5" onClick={() => navigate("/jobs?new=1")}>
                  <Plus className="h-4 w-4" />
                  New Job Ticket
                </Button>
              )}
            </>
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border bg-muted/70 p-0.5">
            {([
              ["floor", "Shop floor"],
              ["all", "All stages"],
            ] as [View, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                className={cn(
                  "rounded-md px-3 py-1 text-[13px] font-medium transition-colors",
                  view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by job, customer or paper…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-9"
            />
          </div>

          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              <SelectItem value="urgent">Rush</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Normal</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-md border bg-card px-2 py-1 text-muted-foreground">
              <span className="num font-semibold text-foreground">{openJobs.length}</span> open
            </span>
            <span className="rounded-md border border-destructive/25 bg-destructive-soft px-2 py-1 text-destructive-strong">
              <span className="num font-semibold">{rush}</span> rush
            </span>
            <span className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1 text-warning-strong">
              <span className="num font-semibold">{dueToday}</span> due today
            </span>
            <span className={cn("rounded-md border px-2 py-1", overdue ? "border-destructive/25 bg-red-600 text-white" : "bg-card text-muted-foreground")}>
              <span className="num font-semibold">{overdue}</span> overdue
            </span>
          </div>
        </div>
      </div>

      {/* The board */}
      <div className="min-h-0 flex-1 overflow-x-auto px-4 pb-4 md:px-6 md:pb-6">
        <div className="flex h-full min-h-[420px] gap-3">
          {columns.map((stage, i) => {
            const items = byStage[stage.status] || [];
            const firstOfPhase = i === 0 || columns[i - 1].phase !== stage.phase;
            return (
              <div
                key={stage.status}
                ref={(el) => (columnRefs.current[stage.status] = el)}
                onDragOver={(e) => {
                  if (!canMove) return;
                  e.preventDefault();
                  setDragOver(stage.status);
                }}
                onDragLeave={() => setDragOver((s) => (s === stage.status ? null : s))}
                onDrop={() => onDrop(stage.status)}
                className={cn(
                  "flex w-[280px] shrink-0 flex-col rounded-xl border bg-muted/50 transition-colors",
                  dragOver === stage.status && "border-primary/50 bg-primary/5",
                  focusStage === stage.status && "ring-2 ring-primary/30"
                )}
              >
                <div className="px-3 pb-2 pt-3">
                  <div className={cn("mb-1 h-3.5 text-[10px] font-semibold uppercase tracking-[0.1em]", PHASES[stage.phase].className)}>
                    {firstOfPhase ? PHASES[stage.phase].label : ""}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", stage.dot)} />
                    <span className="text-[13px] font-semibold">{stage.label}</span>
                    <span className="num ml-auto rounded-md bg-card px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
                      {items.length}
                    </span>
                  </div>
                </div>

                <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {loading && jobs.length === 0 ? (
                    [0, 1].map((n) => <div key={n} className="h-24 animate-pulse rounded-lg bg-card" />)
                  ) : items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/80 px-3 py-6 text-center text-xs text-muted-foreground">
                      {canMove ? "Drop a job here" : "No jobs"}
                    </div>
                  ) : (
                    items.map((job) => (
                      <JobCard
                        key={jobId(job)}
                        job={job}
                        canMove={canMove}
                        onDragStart={() => (draggedId.current = jobId(job))}
                        onMove={(status) => moveJob(job, status)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function JobCard({
  job,
  canMove,
  onDragStart,
  onMove,
}: {
  job: any;
  canMove: boolean;
  onDragStart: () => void;
  onMove: (status: string) => void;
}) {
  const due = dueState(job.dueDate, job.status);
  const next = nextStage(job.status);
  const pr = PRIORITY_STYLES[job.priority] || PRIORITY_STYLES.medium;
  const specs = [
    job.printSpecs?.quantity > 1 ? `${Number(job.printSpecs.quantity).toLocaleString("en-IN")} pcs` : null,
    job.printSpecs?.printSize,
    job.printSpecs?.paperType,
  ].filter(Boolean);

  return (
    <div
      draggable={canMove}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-card p-3 pl-3.5 shadow-card transition-shadow hover:shadow-elevated",
        canMove && "cursor-grab active:cursor-grabbing"
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", pr.bar)} aria-hidden />

      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13px] font-medium leading-snug">{job.title}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {job.customerId?.name || job.customerName || "Walk-in customer"}
          </div>
        </div>
        {canMove && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="-mr-1 -mt-1 rounded p-1 text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100"
                aria-label="Move job"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Move to stage</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {STAGES.map((s) => (
                <DropdownMenuItem
                  key={s.status}
                  disabled={s.status === job.status}
                  onClick={() => onMove(s.status)}
                  className="gap-2 text-[13px]"
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                  {s.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onMove("cancelled")} className="text-[13px] text-destructive focus:text-destructive">
                Cancel job
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {specs.length > 0 && (
        <div className="mt-2 truncate rounded bg-muted/70 px-1.5 py-1 font-mono text-[10.5px] text-muted-foreground">
          {specs.join(" · ")}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        {job.priority === "urgent" || job.priority === "high" ? (
          <span className={cn("rounded border px-1.5 py-px text-[10.5px] font-medium", pr.className)}>{pr.label}</span>
        ) : null}
        {job.dueDate && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-medium",
              due === "overdue" ? "bg-destructive/10 text-destructive" : due === "today" ? "bg-warning/10 text-[hsl(30_90%_32%)]" : "text-muted-foreground"
            )}
          >
            {due === "overdue" && <CircleAlert className="h-3 w-3" />}
            {due === "today" ? "Due today" : `Due ${format(new Date(job.dueDate), "d MMM")}`}
          </span>
        )}
        <span className="flex-1" />
        {canMove && <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40" />}
        {canMove && next && (
          <button
            type="button"
            onClick={() => onMove(next.status)}
            className="inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            title={`Move to ${next.label}`}
          >
            {next.short} <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
