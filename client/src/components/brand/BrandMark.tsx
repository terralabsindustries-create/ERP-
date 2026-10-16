import { cn } from "@/lib/utils";

export const PRODUCT_NAME = "Terralabs ERP";
export const PRODUCT_TAGLINE = "Print Production Suite";

/**
 * The Terralabs mark: a press registration target on an ink tile, its circle
 * split into the process inks (the key quadrant is the tile itself).
 * Keep in step with public/favicon.svg.
 */
export function BrandMark({ className, title = PRODUCT_NAME }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label={title} className={cn("h-8 w-8 shrink-0", className)}>
      <rect width="32" height="32" rx="8" fill="#0f172a" />
      <path d="M16 16 L16 8 A8 8 0 0 0 8 16 Z" fill="#00a3e0" />
      <path d="M16 16 L24 16 A8 8 0 0 0 16 8 Z" fill="#e5007e" />
      <path d="M16 16 L8 16 A8 8 0 0 0 16 24 Z" fill="#ffd500" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path d="M16 4.5 V27.5 M4.5 16 H27.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Mark + wordmark. `tone="light"` is for dark backgrounds (the sidebar). */
export function BrandLogo({
  className,
  tone = "dark",
  showTagline = true,
}: {
  className?: string;
  tone?: "dark" | "light";
  showTagline?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 min-w-0", className)}>
      <BrandMark className={tone === "light" ? "ring-1 ring-white/10 rounded-lg" : undefined} />
      <div className="min-w-0 leading-none">
        <div
          className={cn(
            "truncate text-[15px] font-semibold tracking-tight",
            tone === "light" ? "text-white" : "text-foreground"
          )}
        >
          Terralabs <span className={tone === "light" ? "text-sky-300" : "text-primary"}>ERP</span>
        </div>
        {showTagline && (
          <div
            className={cn(
              "mt-1 truncate text-[10.5px] font-medium uppercase tracking-[0.12em]",
              tone === "light" ? "text-slate-400" : "text-muted-foreground"
            )}
          >
            {PRODUCT_TAGLINE}
          </div>
        )}
      </div>
    </div>
  );
}
