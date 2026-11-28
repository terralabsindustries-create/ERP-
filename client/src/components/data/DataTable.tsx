import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ErrorState, StaleDataBanner } from "@/components/common/LoadState";

/** A bordered card holding a list: toolbar on top, table, footer line. */
export function DataCard({ toolbar, footer, children, className }: { toolbar?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card shadow-card", className)}>
      {toolbar && <div className="border-b px-4 py-3">{toolbar}</div>}
      {children}
      {footer && <div className="border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">{footer}</div>}
    </div>
  );
}

export interface RowAction {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separated?: boolean;
  hidden?: boolean;
}

/** The "⋯" menu at the end of a row. */
export function RowActions({ actions, label }: { actions: RowAction[]; label: string }) {
  const shown = actions.filter((a) => !a.hidden);
  if (!shown.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground hover:text-foreground">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {shown.map((a, i) => (
          <div key={a.label}>
            {a.separated && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={a.disabled} onClick={a.onClick} className={cn(a.destructive && "text-destructive-strong focus:text-destructive-strong")}>
              {a.icon && <a.icon />}
              {a.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  /** Extra classes for the header and cells, e.g. a width. */
  className?: string;
  /** Hide the column below this breakpoint. */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  /** Enables sorting by this column. */
  sortValue?: (row: T) => string | number | null | undefined;
}

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell"
};
const ALIGN = { left: "text-left", right: "text-right", center: "text-center" };

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  actions?: (row: T) => RowAction[];
  /** Label for the actions button, e.g. (row) => `Actions for ${row.name}` */
  actionsLabel?: (row: T) => string;
  loading?: boolean;
  /** Shown when there are no rows. */
  empty?: React.ReactNode;
  /** A phone layout for one row; without it the table scrolls sideways. */
  mobile?: (row: T) => React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
  minWidth?: number;
  /** Start sorted by this column id. */
  defaultSort?: { id: string; dir: "asc" | "desc" };
  /**
   * The last load failed. With no rows the table shows the error and Retry
   * instead of `empty` (a failed request is not "no records"); with rows from
   * an earlier load it keeps them under a "may be out of date" notice.
   */
  error?: unknown;
  onRetry?: () => void;
  /** Noun for the error message, e.g. "invoices" */
  errorWhat?: string;
  /**
   * Server-side sorting: the rows arrive already sorted for `sort`, and a
   * header click calls onSortChange instead of re-ordering one page locally.
   */
  sort?: { id: string; dir: "asc" | "desc" } | null;
  onSortChange?: (sort: { id: string; dir: "asc" | "desc" } | null) => void;
  /** Row checkboxes for bulk actions; `selected` holds row keys. "Select page" selects the rows shown. */
  selectable?: boolean;
  selected?: Set<string>;
  onSelectedChange?: (selected: Set<string>) => void;
}

/**
 * The list table every page uses: one header style, numbers right-aligned,
 * sortable columns, whole-row click, a "⋯" menu per row and a phone layout.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  actions,
  actionsLabel = () => "Row actions",
  loading,
  empty,
  mobile,
  rowClassName,
  minWidth = 760,
  defaultSort,
  error,
  onRetry,
  errorWhat,
  sort: serverSort,
  onSortChange,
  selectable,
  selected,
  onSelectedChange
}: DataTableProps<T>) {
  const canSelect = !!(selectable && selected && onSelectedChange);
  const pageKeys = rows.map(rowKey);
  const allOnPage = canSelect && pageKeys.length > 0 && pageKeys.every((k) => selected!.has(k));
  const toggleRow = (k: string) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k); else next.add(k);
    onSelectedChange!(next);
  };
  const togglePage = () => {
    const next = new Set(selected);
    if (allOnPage) pageKeys.forEach((k) => next.delete(k)); else pageKeys.forEach((k) => next.add(k));
    onSelectedChange!(next);
  };
  const checkCell = (row: T) =>
    canSelect ? (
      <td className="w-10 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="h-4 w-4 accent-primary" aria-label="Select row" checked={selected!.has(rowKey(row))} onChange={() => toggleRow(rowKey(row))} />
      </td>
    ) : null;
  const [localSort, setLocalSort] = useState<{ id: string; dir: "asc" | "desc" } | null>(defaultSort || null);
  const serverSide = !!onSortChange;
  const sort = serverSide ? serverSort ?? null : localSort;
  const setSort = (next: { id: string; dir: "asc" | "desc" } | null | ((s: { id: string; dir: "asc" | "desc" } | null) => { id: string; dir: "asc" | "desc" } | null)) => {
    const value = typeof next === "function" ? next(sort) : next;
    if (serverSide) onSortChange!(value);
    else setLocalSort(value);
  };

  const sorted = useMemo(() => {
    if (!sort || serverSide) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return rows;
    const val = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === "asc" ? r : -r;
    });
  }, [rows, sort, columns, serverSide]);

  const toggleSort = (id: string) =>
    setSort((s) => (s?.id !== id ? { id, dir: "asc" } : s.dir === "asc" ? { id, dir: "desc" } : null));

  if (loading) {
    return (
      <div className="divide-y" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5">
            <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/5 animate-pulse rounded bg-muted" />
            <div className="ml-auto h-4 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) return error ? <ErrorState error={error} onRetry={onRetry} what={errorWhat} /> : <>{empty}</>;
  const stale = error ? <StaleDataBanner className="m-3" error={error} onRetry={onRetry} /> : null;

  const actionsCell = (row: T) =>
    actions ? (
      <td className="w-12 px-2 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
        <RowActions actions={actions(row)} label={actionsLabel(row)} />
      </td>
    ) : null;

  return (
    <>
      {stale}
      {mobile && (
        <ul className="divide-y md:hidden">
          {sorted.map((row) => (
            <li key={rowKey(row)} className="flex items-start gap-2">
              {canSelect && (
                <input type="checkbox" className="ml-3 mt-4 h-4 w-4 accent-primary" aria-label="Select row" checked={selected!.has(rowKey(row))} onChange={() => toggleRow(rowKey(row))} />
              )}
              <div
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onRowClick(row)) : undefined}
                className={cn("min-w-0 flex-1 px-4 py-3", onRowClick && "cursor-pointer active:bg-muted")}
              >
                {mobile(row)}
              </div>
              {actions && (
                <div className="py-2 pr-2">
                  <RowActions actions={actions(row)} label={actionsLabel(row)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className={cn("overflow-x-auto", mobile && "hidden md:block")}>
        <table className="w-full text-sm" style={{ minWidth }}>
          <thead>
            <tr className="border-b bg-background">
              {canSelect && (
                <th className="w-10 px-3">
                  <input type="checkbox" className="h-4 w-4 accent-primary" aria-label="Select all rows on this page" checked={allOnPage} onChange={togglePage} />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={cn("h-10 px-4 font-semibold", ALIGN[c.align || "left"], c.hideBelow && HIDE[c.hideBelow], c.className)}
                  >
                    {c.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.id)}
                        className={cn(
                          "inline-flex items-center gap-1 uppercase tracking-[0.08em] transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          c.align === "right" && "flex-row-reverse",
                          active && "text-foreground"
                        )}
                      >
                        {c.header}
                        {active ? (
                          sort!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {actions && <th className="w-12 px-2"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {sorted.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn("transition-colors duration-200", onRowClick && "cursor-pointer hover:bg-muted", rowClassName?.(row))}
              >
                {checkCell(row)}
                {columns.map((c) => (
                  <td key={c.id} className={cn("px-4 py-2.5 align-middle", ALIGN[c.align || "left"], c.align === "right" && "num font-mono", c.hideBelow && HIDE[c.hideBelow], c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
                {actionsCell(row)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** "Showing 21–40 of 134" with previous / next, for server-paged lists. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  noun = "items"
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="num">
        {total === 0 ? `No ${noun}` : `${from.toLocaleString("en-IN")}–${to.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} ${noun}`}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-xs" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <span className="num px-2 text-foreground">
            {page} / {pages}
          </span>
          <Button variant="outline" size="icon-xs" onClick={() => onPageChange(page + 1)} disabled={page >= pages} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
