import { eachDayOfInterval, format, isSameDay, isSameMonth, isToday } from "date-fns";
import { KIND_META, byTime, monthWindow, onDay, type CalItem } from "@/lib/calendarItems";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A month as a grid of days. Each day lists its first few items as coloured
 * chips (dots on phones); clicking a day selects it for the agenda.
 */
export function MonthGrid({ month, items, selected, onSelect, loading }: { month: Date; items: CalItem[]; selected: Date; onSelect: (d: Date) => void; loading?: boolean }) {
  const { start, end } = monthWindow(month);
  const days = eachDayOfInterval({ start, end });

  return (
    <div className={cn("transition-opacity", loading && "opacity-60")}>
      <div className="grid grid-cols-7 border-b bg-muted/30">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-left">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day, i) => {
          const list = items.filter((it) => onDay(it, day)).sort(byTime);
          const inMonth = isSameMonth(day, month);
          const today = isToday(day);
          const isSel = isSameDay(day, selected);
          const late = list.some((it) => it.overdue);
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onSelect(day)}
              aria-label={`${format(day, "EEEE d MMMM")}${list.length ? `, ${list.length} item${list.length === 1 ? "" : "s"}` : ""}`}
              aria-pressed={isSel}
              className={cn(
                "group relative flex min-h-[64px] flex-col items-stretch gap-1 border-b border-r p-1.5 text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-[112px] sm:p-2",
                (i + 1) % 7 === 0 && "border-r-0",
                i >= days.length - 7 && "border-b-0",
                inMonth ? "bg-card hover:bg-muted/40" : "bg-muted/20 text-muted-foreground hover:bg-muted/40",
                isSel && "bg-primary-soft/40 hover:bg-primary-soft/50"
              )}
            >
              {isSel && <span className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary/60" aria-hidden />}
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "num flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-medium sm:text-[13px]",
                    today && "bg-primary font-semibold text-primary-foreground",
                    !today && !inMonth && "text-muted-foreground/70"
                  )}
                >
                  {day.getDate()}
                  {day.getDate() === 1 && !today && <span className="ml-1 hidden sm:inline">{format(day, "MMM")}</span>}
                </span>
                {late && <span className="h-1.5 w-1.5 rounded-full bg-destructive" title="Overdue task" aria-hidden />}
              </div>

              {/* Phones: one dot per item, up to four. */}
              {list.length > 0 && (
                <div className="flex flex-wrap gap-0.5 sm:hidden" aria-hidden>
                  {list.slice(0, 4).map((it) => (
                    <span key={`${it.source}-${it.id}`} className={cn("h-1.5 w-1.5 rounded-full", it.done ? "bg-muted-foreground/30" : KIND_META[it.kind].dot)} />
                  ))}
                </div>
              )}

              {/* Larger screens: the first three as chips. */}
              <div className="hidden min-w-0 space-y-1 sm:block">
                {list.slice(0, 3).map((it) => (
                  <div
                    key={`${it.source}-${it.id}`}
                    title={it.title}
                    className={cn(
                      "flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4",
                      it.done ? "bg-muted text-muted-foreground line-through decoration-muted-foreground/50" : it.overdue ? "bg-destructive-soft text-destructive-strong" : KIND_META[it.kind].chip
                    )}
                  >
                    {!it.allDay && <span className="num shrink-0 opacity-80">{format(it.start, "H:mm")}</span>}
                    <span className="truncate">{it.title}</span>
                  </div>
                ))}
                {list.length > 3 && <div className="px-1.5 text-[11px] font-medium text-muted-foreground">+{list.length - 3} more</div>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
