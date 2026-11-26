import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronsUpDown, Loader2, UserPlus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import apiClient from "@/lib/apiClient";
import { cn } from "@/lib/utils";

export interface CustomerOption {
  _id: string;
  id?: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  customerType?: string;
  status?: string;
  address?: string;
  gstNumber?: string;
}

export const customerIdOf = (c?: { _id?: string; id?: string } | null) => (c?._id || c?.id || "") as string;

const DEBOUNCE_MS = 200;
const PAGE_SIZE = 20;
const CREATE_ITEM = "__create_customer__";

/**
 * Customers matching `query`, searched on the server as it changes: debounced,
 * and a reply that arrives after a newer search started is dropped, so a slow
 * response can never replace the results for what is typed now. An empty query
 * lists the most recent customers.
 */
export function useCustomerSearch(query: string, { enabled = true, status = "active" }: { enabled?: boolean; status?: "active" | "all" } = {}) {
  const [state, setState] = useState<{ results: CustomerOption[]; total: number; term: string | null; error: string | null }>({ results: [], total: 0, term: null, error: null });
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const term = query.trim();

  useEffect(() => {
    if (!enabled) return;
    const request = ++latest.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      apiClient
        .get<{ customers?: CustomerOption[]; pagination?: { totalCustomers?: number } }>("/customers", { search: term, status, limit: PAGE_SIZE })
        .then((res) => {
          if (request !== latest.current) return;
          const seen = new Set<string>();
          const results = (res?.customers || []).filter((c) => {
            const id = customerIdOf(c);
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          setState({ results, total: res?.pagination?.totalCustomers ?? results.length, term, error: null });
        })
        .catch((e: unknown) => {
          if (request === latest.current) setState({ results: [], total: 0, term, error: (e instanceof Error && e.message) || "Could not load customers" });
        })
        .finally(() => {
          if (request === latest.current) setLoading(false);
        });
    }, term ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [term, enabled, status]);

  /** True while the list on screen is for an older query than the one typed. */
  const stale = state.term !== term;
  return { ...state, loading: loading || stale, stale };
}

/**
 * The record of customer `id`: the first of `known` with that id, else loaded
 * from the server (an invoice being edited, a customer taken from a job).
 * `onLoaded` hears about a record that had to be loaded.
 */
export function useCustomerRecord(id: string, known: (CustomerOption | null | undefined)[] = [], onLoaded?: (customer: CustomerOption) => void) {
  const [loaded, setLoaded] = useState<CustomerOption | null>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const record = [...known, loaded].find((c) => c && customerIdOf(c) === id) || null;
  const have = !!record;

  useEffect(() => {
    if (!id || have) return;
    let live = true;
    apiClient
      .get<{ customer?: CustomerOption }>(`/customers/${id}`)
      .then((res) => {
        if (!live || !res?.customer) return;
        setLoaded(res.customer);
        onLoadedRef.current?.(res.customer);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, have]);

  return record;
}

/** The part of `text` that matches `query`, in bold. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-foreground underline decoration-primary/60 underline-offset-2">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

const details = (c: CustomerOption) => [c.company, c.phone, c.email].filter(Boolean).join(" · ");

interface CustomerSearchProps {
  id?: string;
  /** The selected customer's id, "" when none is chosen. */
  value: string;
  /** The selected customer's record, when the caller already has it. Otherwise it is loaded by id. */
  customer?: CustomerOption | null;
  onSelect: (customer: CustomerOption) => void;
  /** Called with the record loaded for a `value` the caller passed no `customer` for. */
  onResolved?: (customer: CustomerOption) => void;
  /** Offers "Add … as a new customer" at the end of the list; receives what was typed. */
  onCreateNew?: (name: string) => void;
  /** For an optional picker: shows a button that clears the choice. */
  onClear?: () => void;
  status?: "active" | "all";
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}

/**
 * The customer picker used across billing: shows the chosen customer, and on
 * click (or on just starting to type) opens a search box over the customer
 * list. Results follow each keystroke — name, company, phone or email, any
 * part, any case — and are picked with the mouse or ↑ ↓ Enter; Esc closes.
 */
export function CustomerSearch({
  id,
  value,
  customer,
  onSelect,
  onResolved,
  onCreateNew,
  onClear,
  status = "active",
  placeholder = "Search customer by name, company or phone",
  disabled,
  invalid,
  className,
}: CustomerSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const [picked, setPicked] = useState<CustomerOption | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingEnter = useRef(false);

  const { results, total, loading, stale, error } = useCustomerSearch(query, { enabled: open, status });
  const selected = useCustomerRecord(value, [customer, picked], onResolved);
  const typed = query.trim();
  const canCreate = !!onCreateNew;

  const choose = (c: CustomerOption) => {
    setPicked(c);
    setOpen(false);
    onSelect(c);
  };
  const create = () => {
    setOpen(false);
    onCreateNew?.(typed);
  };

  // Fresh results highlight their first row — and finish an Enter pressed
  // before they arrived, so a quick "type, Enter" picks from what was typed.
  useEffect(() => {
    if (stale) return;
    const first = results[0] ? customerIdOf(results[0]) : canCreate ? CREATE_ITEM : "";
    setActive(first);
    if (pendingEnter.current) {
      pendingEnter.current = false;
      if (results[0]) choose(results[0]);
      else if (canCreate && typed) create();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, stale]);

  const openWith = (text: string) => {
    setQuery(text);
    pendingEnter.current = false;
    setOpen(true);
  };

  // Start searching straight from the closed picker: typing a letter or
  // pressing ↓ opens it.
  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 && e.key !== " ") {
      e.preventDefault();
      openWith(e.key);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      openWith("");
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter while the list is still for an older query: wait for this one.
    if (e.key === "Enter" && stale) {
      e.preventDefault();
      pendingEnter.current = true;
    }
  };

  return (
    <div className="flex w-full items-start gap-1">
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openWith("");
        else {
          // Closed with Esc or a click outside: an Enter still waiting on results is dropped.
          pendingEnter.current = false;
          setOpen(false);
        }
      }}
      modal
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          disabled={disabled}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            "flex min-h-10 w-full min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            invalid && "border-destructive",
            className,
          )}
        >
          {selected ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{selected.name}</span>
              {details(selected) && <span className="block truncate text-xs text-muted-foreground">{details(selected)}</span>}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{value ? "Loading customer…" : placeholder}</span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      {onClear && value && !disabled && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear customer"
          className="-ml-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        // Keep Enter inside the picker, so it never reaches a form or dialog
        // handler behind it.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.stopPropagation();
        }}
      >
        <Command shouldFilter={false} loop value={active} onValueChange={setActive} onKeyDown={onListKeyDown}>
          <div className="relative">
            <CommandInput ref={inputRef} value={query} onValueChange={setQuery} placeholder={placeholder} aria-label="Search customers" />
            {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Searching" />}
          </div>
          <CommandList className={cn("max-h-72", stale && results.length > 0 && "opacity-60")}>
            {error ? (
              <div className="px-3 py-6 text-center text-sm text-destructive">{error}</div>
            ) : results.length === 0 && !loading ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {typed ? `No customer matches "${typed}"` : "No customers yet"}
              </div>
            ) : results.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</div>
            ) : null}
            {!error &&
              results.map((c) => {
                const cid = customerIdOf(c);
                return (
                  <CommandItem key={cid} value={cid} onSelect={() => choose(c)} className="cursor-pointer items-start gap-2 px-3 py-2">
                    <Check className={cn("mt-0.5 h-4 w-4 shrink-0", cid === value ? "opacity-100" : "opacity-0")} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{highlight(c.name, typed)}</span>
                        {c.customerType && <span className="shrink-0 rounded border px-1.5 text-[11px] text-muted-foreground">{c.customerType}</span>}
                      </div>
                      {details(c) && <div className="truncate text-xs text-muted-foreground">{highlight(details(c), typed)}</div>}
                    </div>
                  </CommandItem>
                );
              })}
            {!error && !stale && total > results.length && (
              <div className="border-t px-3 py-2 text-xs text-muted-foreground">
                Showing {results.length} of {total} — keep typing to narrow down
              </div>
            )}
            {canCreate && (
              <CommandItem value={CREATE_ITEM} onSelect={create} className="cursor-pointer gap-2 border-t px-3 py-2">
                <UserPlus className="h-4 w-4 shrink-0" aria-hidden />
                {typed ? `Add "${typed}" as a new customer` : "Add a new customer"}
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    </div>
  );
}
