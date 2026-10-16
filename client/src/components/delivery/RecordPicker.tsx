import { useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PickerOption {
  id: string;
  title: string;
  subtitle?: string;
  /** Extra text the search matches (phone numbers, codes…). */
  keywords?: string;
}

const SHOWN = 60;

/**
 * Pick one record from a long list (every job, every customer): a search box
 * over a short scrolling list, and the chosen record with a "Change" button
 * once picked. Inline, so it works inside side panels and on phones.
 */
export function RecordPicker({
  id,
  options,
  value,
  onChange,
  loading,
  placeholder = "Search",
  emptyText = "Nothing matches",
  invalid,
  allowClear,
  searchFirst,
}: {
  id?: string;
  options: PickerOption[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
  invalid?: boolean;
  /** Show "Remove" next to the chosen record (for optional pickers). */
  allowClear?: boolean;
  /** Only list records once something is typed (for optional pickers). */
  searchFirst?: boolean;
}) {
  const [q, setQ] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const selected = options.find((o) => o.id === value);

  const matches = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return options;
    return options.filter((o) => {
      const hay = `${o.title} ${o.subtitle || ""} ${o.keywords || ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [options, q]);

  if (selected && !browsing) {
    return (
      <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
        <Check className="h-4 w-4 shrink-0 text-success-strong" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{selected.title}</div>
          {selected.subtitle && <div className="truncate text-xs text-muted-foreground">{selected.subtitle}</div>}
        </div>
        {allowClear && (
          <Button type="button" variant="ghost" size="xs" onClick={() => onChange("")}>
            Remove
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            setQ("");
            setBrowsing(true);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-md border", invalid && "border-destructive")}>
      <div className={cn("relative", (!searchFirst || q.trim()) && "border-b")}>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          className="h-9 rounded-none border-0 pl-8 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>
      {(!searchFirst || q.trim()) && (
        <div className="max-h-56 overflow-y-auto" role="listbox" aria-label={placeholder}>
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            <>
              {matches.slice(0, SHOWN).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={o.id === value}
                  onClick={() => {
                    onChange(o.id);
                    setBrowsing(false);
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
                    o.id === value && "bg-primary-soft/40",
                  )}
                >
                  <span className="w-full truncate text-sm font-medium">{o.title}</span>
                  {o.subtitle && <span className="w-full truncate text-xs text-muted-foreground">{o.subtitle}</span>}
                </button>
              ))}
              {matches.length > SHOWN && <div className="px-3 py-2 text-xs text-muted-foreground">{matches.length - SHOWN} more — keep typing to narrow down</div>}
            </>
          )}
        </div>
      )}
      {selected && browsing && (
        <div className="border-t bg-muted/30 px-3 py-1.5 text-right">
          <Button type="button" variant="ghost" size="xs" onClick={() => setBrowsing(false)}>
            Keep {selected.title.length > 30 ? "current" : selected.title}
          </Button>
        </div>
      )}
    </div>
  );
}
