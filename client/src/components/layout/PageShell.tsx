import { cn } from "@/lib/utils";

const WIDTHS = {
  /** Dashboards, boards and wide tables */
  wide: "max-w-[1600px]",
  /** Most list pages */
  default: "max-w-7xl",
  /** Settings and single-record pages */
  narrow: "max-w-5xl",
  full: "max-w-none",
};

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: keyof typeof WIDTHS;
}

/**
 * The outer frame of every page: the same gutters, max width and vertical
 * rhythm everywhere, so headings and content line up from page to page.
 */
export function PageShell({ width = "wide", className, children, ...props }: PageShellProps) {
  return (
    <div
      className={cn("page-frame", WIDTHS[width], className)}
      {...props}
    >
      {children}
    </div>
  );
}
