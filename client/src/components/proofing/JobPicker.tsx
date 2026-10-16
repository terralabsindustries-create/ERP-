import { useMemo, useState } from "react";
import { Briefcase, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { JobOption } from "@/lib/api/proofs";
import { fmtDate, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { jobCustomerName } from "./proofMeta";

const SHOWN = 50;

/**
 * Choose the job a proof belongs to. The list is inline (not a pop-over) so it
 * scrolls naturally inside the side panel and on phones.
 */
export function JobPicker({
  jobs,
  loading,
  value,
  onChange,
  id
}: {
  jobs: JobOption[];
  loading?: boolean;
  value: string;
  onChange: (job: JobOption) => void;
  id?: string;
}) {
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(!value);
  const selected = jobs.find((j) => j._id === value);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? jobs.filter((j) => `${j.title} ${jobCustomerName(j)}`.toLowerCase().includes(q)) : jobs;
    return list;
  }, [jobs, query]);

  if (selected && !browsing) {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Briefcase className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{selected.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {[jobCustomerName(selected), selected.status && humanize(selected.status), selected.dueDate && `Due ${fmtDate(selected.dueDate)}`].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setBrowsing(true)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Input id={id} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search job or customer" autoComplete="off" />
      <div className="max-h-64 overflow-y-auto rounded-lg border" role="listbox" aria-label="Jobs">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading jobs…
          </div>
        ) : matches.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">{jobs.length ? "No job matches this search." : "There are no jobs yet. Create the job first."}</div>
        ) : (
          <ul className="divide-y">
            {matches.slice(0, SHOWN).map((j) => {
              const active = j._id === value;
              return (
                <li key={j._id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(j);
                      setBrowsing(false);
                      setQuery("");
                    }}
                    className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none", active && "bg-primary-soft/40")}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{j.title}</div>
                      <div className="truncate text-xs text-muted-foreground">{[jobCustomerName(j), j.status && humanize(j.status)].filter(Boolean).join(" · ")}</div>
                    </div>
                    {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!loading && matches.length > SHOWN && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            Showing {SHOWN} of {matches.length}. Type to narrow the list.
          </div>
        )}
      </div>
      {selected && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setBrowsing(false)}>
          Keep {selected.title}
        </Button>
      )}
    </div>
  );
}
