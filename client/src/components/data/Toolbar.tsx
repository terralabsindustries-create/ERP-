import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The search box at the left of a list toolbar, with a clear button. */
export function SearchField({
  value,
  onChange,
  placeholder = "Search",
  className
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full sm:w-72", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="h-9 pl-8 pr-8" />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * A compact filter for a list toolbar. The trigger reads "Category: Paper";
 * the first option is the "all" choice and is separated from the rest.
 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel = "All",
  className
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
  allLabel?: string;
  className?: string;
}) {
  const current = value === "all" ? allLabel : options.find((o) => o.value === value)?.label || value;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className={cn("h-9 w-auto min-w-[8.5rem] shrink-0 gap-1.5 text-[13px]", value !== "all" && "border-primary/40 bg-primary-soft/30", className)}
      >
        <span className="!flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground">{label}:</span>
          <span className="truncate font-medium">{current}</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.length > 0 && <SelectSeparator />}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Lays out a list toolbar: search on the left, filters and actions on the right. */
export function Toolbar({ search, children, className }: { search?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between", className)}>
      {search}
      {children && (
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-end sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {children}
        </div>
      )}
    </div>
  );
}
