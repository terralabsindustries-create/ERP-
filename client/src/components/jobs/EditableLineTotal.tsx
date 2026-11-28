import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A line total that can be clicked and typed over. Enter or leaving the field
 * applies it (the caller works out the unit price); Escape puts it back.
 */
export function EditableLineTotal({ value, onCommit, label, className }: {
  value: number;
  onCommit: (total: number) => void;
  label: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(value > 0 ? value.toFixed(2) : "");
    setEditing(true);
  };
  const finish = (apply: boolean) => {
    setEditing(false);
    const typed = Number(draft);
    if (apply && draft.trim() !== "" && Number.isFinite(typed) && Math.abs(typed - value) >= 0.005) onCommit(typed);
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        aria-label={label}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
        }}
        className={cn("h-9 w-32 tabular-nums", className)}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={start}
      title="Click to type the total including GST; the unit price is worked out from it"
      aria-label={`${label}: ₹${value.toFixed(2)}. Click to edit`}
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-md border border-dashed border-border/70 px-1.5 py-1 text-sm font-medium tabular-nums transition-colors hover:border-border hover:bg-muted/60 focus-visible:border-ring focus-visible:outline-none",
        className
      )}
    >
      ₹{value.toFixed(2)}
      <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-60 group-hover:opacity-100" aria-hidden />
    </button>
  );
}
