import { Link } from "react-router-dom";
import { Panel, PanelLink } from "@/components/common/Panel";
import { cn } from "@/lib/utils";
import { PHASES, STAGES, type Phase } from "@/lib/printWorkflow";

interface PipelineStripProps {
  counts: Record<string, number>;
  loading?: boolean;
}

const PHASE_ORDER = Object.keys(PHASES) as Phase[];

/* Each phase takes as many of the ten desktop columns as it has stages. */
const PHASE_SPAN: Record<number, string> = { 1: "xl:col-span-1", 2: "xl:col-span-2", 3: "xl:col-span-3" };
const STAGE_COLS: Record<number, string> = { 1: "xl:grid-cols-1", 2: "xl:grid-cols-2", 3: "xl:grid-cols-3" };

/** Open jobs per stage, left to right in the order work moves through the shop. */
export function PipelineStrip({ counts, loading }: PipelineStripProps) {
  const total = STAGES.reduce((sum, s) => sum + (counts[s.status] || 0), 0);

  return (
    <Panel
      title="Production pipeline"
      description="Every job by stage, enquiry to delivery"
      count={loading ? undefined : total}
      action={<PanelLink to="/production">Open board</PanelLink>}
    >
      {/* Share of jobs at each stage */}
      <div className="px-4 pt-4 sm:px-5">
        <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted" role="img" aria-label="Share of jobs at each stage">
          {total > 0 &&
            STAGES.map((s) =>
              counts[s.status] ? (
                <div
                  key={s.status}
                  className={cn("h-full first:rounded-l-full last:rounded-r-full", s.dot)}
                  style={{ width: `${(counts[s.status] / total) * 100}%` }}
                  title={`${s.label}: ${counts[s.status]}`}
                />
              ) : null
            )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-x-3 gap-y-1 p-3 sm:grid-cols-5 sm:gap-y-0 sm:p-4 xl:grid-cols-10">
        {PHASE_ORDER.map((phase, pi) => {
          const stages = STAGES.filter((s) => s.phase === phase);
          return (
            <div
              key={phase}
              className={cn(
                "flex items-center gap-2 sm:block",
                PHASE_SPAN[stages.length],
                pi > 0 && "border-t pt-1 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0"
              )}
            >
              <div
                className={cn(
                  "w-[76px] shrink-0 whitespace-nowrap px-1 text-[10px] font-semibold uppercase tracking-[0.08em] sm:mb-1 sm:w-auto sm:px-2",
                  PHASES[phase].className
                )}
              >
                {PHASES[phase].label}
              </div>
              <div className={cn("grid flex-1 grid-cols-3 gap-1 sm:grid-cols-1", STAGE_COLS[stages.length])}>
                {stages.map((s) => {
                  const n = counts[s.status] || 0;
                  return (
                    <Link
                      key={s.status}
                      to={`/production?stage=${s.status}`}
                      className="group min-w-0 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:py-2"
                      title={s.description}
                    >
                      <div
                        className={cn(
                          "num text-lg font-semibold leading-none sm:text-2xl",
                          n === 0 ? "text-muted-foreground/50" : "text-foreground"
                        )}
                      >
                        {loading ? <span className="inline-block h-5 w-5 animate-pulse rounded bg-muted sm:h-6 sm:w-6" /> : n}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground group-hover:text-foreground sm:text-xs">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
                        <span className="truncate">{s.short}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
