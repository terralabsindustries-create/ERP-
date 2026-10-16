import { Link, useNavigate } from "react-router-dom";
import { format, isSameDay } from "date-fns";
import { CheckCircle, ExternalLink, MapPin, Pencil, Trash2 } from "lucide-react";
import { RowActions, StatusPill } from "@/components/data";
import { KIND_META, type CalItem } from "@/lib/calendarItems";
import { dueLabel, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

interface AgendaListProps {
  items: CalItem[];
  /** Show the date on each row (lists that span several days). */
  showDate?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onDone: (i: CalItem) => void;
  onEdit: (i: CalItem) => void;
  onDelete: (i: CalItem) => void;
  empty: React.ReactNode;
}

function whenOf(i: CalItem, showDate?: boolean) {
  if (i.source === "task") return i.done ? "Due" : dueLabel(i.start);
  const day = showDate ? `${format(i.start, "EEE d MMM")} · ` : "";
  if (i.allDay) return `${day}All day`;
  return `${day}${format(i.start, "h:mm a")}${isSameDay(i.start, i.end) && i.end > i.start ? ` – ${format(i.end, "h:mm a")}` : ""}`;
}

/** Tasks and events as a list: a coloured rail, the title, when, and actions. */
export function AgendaList({ items, showDate, canEdit, canDelete, onDone, onEdit, onDelete, empty }: AgendaListProps) {
  const navigate = useNavigate();
  if (!items.length) return <>{empty}</>;
  return (
    <ul className="divide-y">
      {items.map((i) => {
        const meta = KIND_META[i.kind];
        const title =
          i.source === "task" ? (
            <Link to={`/tasks/${i.id}`} className="hover:underline">
              {i.title}
            </Link>
          ) : (
            i.title
          );
        return (
          <li key={`${i.source}-${i.id}`} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <span className={cn("mt-1 h-9 w-1 shrink-0 rounded-full", i.done ? "bg-muted-foreground/25" : i.overdue ? "bg-destructive" : meta.dot)} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className={cn("truncate text-sm font-medium", i.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className={cn(i.overdue && "font-medium text-destructive-strong")}>
                  {showDate && i.source === "task" ? `${format(i.start, "EEE d MMM")} · ` : ""}
                  {whenOf(i, showDate)}
                </span>
                <span aria-hidden>·</span>
                <span>{meta.label}</span>
                {i.assignee && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="truncate">{i.assignee}</span>
                  </>
                )}
                {i.location && (
                  <span className="inline-flex items-center gap-0.5">
                    <MapPin className="h-3 w-3" />
                    {i.location}
                  </span>
                )}
              </div>
              {i.description && !i.done && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{i.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {i.done ? (
                <StatusPill tone={i.status === "cancelled" ? "neutral" : "success"}>{i.status === "cancelled" ? "Cancelled" : "Done"}</StatusPill>
              ) : (
                (i.priority === "urgent" || i.priority === "high") && <StatusPill tone={i.priority === "urgent" ? "danger" : "warning"}>{humanize(i.priority)}</StatusPill>
              )}
              <RowActions
                label={`Actions for ${i.title}`}
                actions={[
                  { label: "Mark done", icon: CheckCircle, onClick: () => onDone(i), hidden: i.done || (i.source === "event" && !canEdit) },
                  { label: "Open task", icon: ExternalLink, onClick: () => navigate(`/tasks/${i.id}`), hidden: i.source !== "task" },
                  { label: "Edit event", icon: Pencil, onClick: () => onEdit(i), hidden: i.source !== "event" || !canEdit },
                  { label: "Delete event", icon: Trash2, destructive: true, separated: true, onClick: () => onDelete(i), hidden: i.source !== "event" || !canDelete }
                ]}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
