import { cn } from "@/lib/utils";

interface MessagePreviewProps {
  body: string;
  footer?: string;
  /** Values for {{1}}, {{2}}… by number; a missing one shows as its placeholder. */
  values?: Record<string, string>;
  /** The chat's title, e.g. the business's verified WhatsApp name. */
  sender?: string;
  /** Shown in place of the bubble while there is no message yet. */
  placeholder?: React.ReactNode;
  className?: string;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

/**
 * A template message the way the customer sees it in WhatsApp: the chat's
 * title bar and one incoming bubble, with the variables filled in.
 */
export function MessagePreview({ body, footer, values = {}, sender = "Your business", placeholder = "The message preview appears here.", className }: MessagePreviewProps) {
  const time = new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="flex items-center gap-2.5 bg-success px-3 py-2.5 text-success-foreground">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-foreground/20 text-xs font-semibold" aria-hidden>
          {initials(sender) || "B"}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{sender}</p>
          <p className="text-[11px] leading-tight opacity-80">Business account</p>
        </div>
      </div>
      <div className="min-h-[200px] bg-muted/60 p-3 sm:p-4">
        {body.trim() ? (
          <div className="max-w-[92%] rounded-lg rounded-tl-none bg-card px-3 py-2 text-sm shadow-sm">
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {body.split(/(\{\{\d+\}\})/g).map((part, i) => {
                const n = part.match(/^\{\{(\d+)\}\}$/)?.[1];
                if (!n) return part;
                const value = values[n]?.trim();
                return value ? (
                  <span key={i} className="font-medium">
                    {value}
                  </span>
                ) : (
                  <span key={i} className="rounded bg-info-soft px-1 font-mono text-[12px] text-info-strong">
                    {part}
                  </span>
                );
              })}
            </p>
            {footer?.trim() && <p className="mt-1.5 text-xs text-muted-foreground">{footer}</p>}
            <p className="mt-1 text-right text-[10px] text-muted-foreground">{time}</p>
          </div>
        ) : (
          <div className="flex min-h-[168px] items-center justify-center px-4 text-center text-xs text-muted-foreground">{placeholder}</div>
        )}
      </div>
    </div>
  );
}
