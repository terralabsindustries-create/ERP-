import { cn } from "@/lib/utils";

export const PRODUCT_NAME = "Carbon";
export const PRODUCT_TAGLINE = "Print Flow Engine";

export function BrandMark({ className, title = PRODUCT_NAME }: { className?: string; title?: string }) {
  return (
    <img src="/brand/carbon-mark.png" alt={title} className={cn("h-8 w-8 shrink-0 object-contain", className)} />
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
      <BrandMark className="h-9 w-9" />
      <div className="min-w-0 leading-none">
        <div
          className={cn(
            "truncate text-[16px] font-bold tracking-[0.06em]",
            tone === "light" ? "text-amber-200" : "text-[#704a00]"
          )}
        >
          CARBON
        </div>
        {showTagline && (
          <div
            className={cn(
              "mt-1 truncate text-[10px] font-semibold uppercase tracking-[0.1em]",
              tone === "light" ? "text-amber-100/80" : "text-[#704a00]/80"
            )}
          >
            {PRODUCT_TAGLINE}
          </div>
        )}
      </div>
    </div>
  );
}
