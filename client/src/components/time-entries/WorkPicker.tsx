import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { customerOf, refId, type JobOption, type TaskOption } from "@/lib/api/timeEntries";
import { cn } from "@/lib/utils";
import { FINISHED_JOB, OPEN_TASK } from "./timeMeta";

/** A searchable job list: open jobs first, finished ones underneath. */
export function JobPicker({
  id,
  jobs,
  value,
  onChange,
  loading,
  fallbackTitle,
  className
}: {
  id?: string;
  jobs: JobOption[];
  value: string;
  onChange: (jobId: string) => void;
  loading?: boolean;
  /** Shown when the chosen job is not in the list (e.g. it was deleted). */
  fallbackTitle?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = jobs.find((j) => j._id === value);
  const groups = useMemo(
    () => [
      { heading: "Open jobs", rows: jobs.filter((j) => !FINISHED_JOB.includes(j.status)) },
      { heading: "Finished jobs", rows: jobs.filter((j) => FINISHED_JOB.includes(j.status)) }
    ],
    [jobs]
  );

  const label = selected ? selected.title : value && fallbackTitle ? fallbackTitle : loading ? "Loading jobs…" : jobs.length ? "Choose a job" : "No jobs yet";

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={loading && !jobs.length}
          className={cn("w-full justify-between px-3 font-normal", className)}
        >
          <span className={cn("min-w-0 truncate text-left", !selected && !fallbackTitle && "text-muted-foreground")}>
            {label}
            {selected && customerOf(selected) && <span className="text-muted-foreground"> · {customerOf(selected)}</span>}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0">
        <Command>
          <CommandInput placeholder="Search job or customer" />
          <CommandList className="max-h-72">
            <CommandEmpty>No job matches.</CommandEmpty>
            {groups.map(
              (g) =>
                g.rows.length > 0 && (
                  <CommandGroup key={g.heading} heading={g.heading}>
                    {g.rows.map((j) => (
                      <CommandItem
                        key={j._id}
                        value={`${j.title} ${customerOf(j)} ${j._id}`}
                        onSelect={() => {
                          onChange(j._id);
                          setOpen(false);
                        }}
                        className="gap-2"
                      >
                        <Check className={cn("h-4 w-4 shrink-0", j._id === value ? "opacity-100" : "opacity-0")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{j.title}</span>
                          {customerOf(j) && <span className="block truncate text-xs text-muted-foreground">{customerOf(j)}</span>}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const NONE = "none";

/**
 * One of my open tasks, or none. With a job chosen, only that job's tasks and
 * tasks without a job are offered; picking a task that has a job selects it.
 */
export function TaskSelect({
  id,
  tasks,
  jobId,
  value,
  onChange,
  fallbackTitle,
  className
}: {
  id?: string;
  tasks: TaskOption[];
  jobId: string;
  value: string;
  onChange: (taskId: string, task: TaskOption | null) => void;
  /** Title of a task that is no longer open, when editing an entry linked to it. */
  fallbackTitle?: string;
  className?: string;
}) {
  const options = useMemo(
    () => tasks.filter((t) => (OPEN_TASK.includes(t.status) || t._id === value) && (!jobId || !refId(t.jobId) || refId(t.jobId) === jobId)),
    [tasks, jobId, value]
  );
  const known = options.some((t) => t._id === value);

  return (
    <Select
      value={value || NONE}
      onValueChange={(v) => {
        const task = v === NONE ? null : options.find((t) => t._id === v) || null;
        onChange(v === NONE ? "" : v, task);
      }}
    >
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder="No task" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{options.length ? "No task" : "No open tasks for you"}</SelectItem>
        {value && !known && fallbackTitle && <SelectItem value={value}>{fallbackTitle}</SelectItem>}
        {options.map((t) => {
          const jobTitle = (t.jobId && typeof t.jobId === "object" ? t.jobId.title : "") || t.jobTitle;
          return (
            <SelectItem key={t._id} value={t._id}>
              {t.title}
              {!jobId && jobTitle ? <span className="text-muted-foreground"> · {jobTitle}</span> : null}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
