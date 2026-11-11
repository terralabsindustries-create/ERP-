import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
  Status badges are pills on the soft/strong token pairs, so their text stays
  readable in both themes: warning (part-paid), success (paid, delivered),
  destructive (overdue), info, secondary (neutral / draft). `pending` and
  `urgent` are older names kept for callers.
*/
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2.5 py-[3px] text-[11.5px] font-semibold leading-4 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary-soft text-primary-strong",
        /* Neutral / draft */
        secondary:
          "bg-secondary text-muted-foreground",
        destructive:
          "bg-destructive-soft text-destructive-strong",
        outline: "border-border bg-transparent text-foreground",
        success:
          "bg-success-soft text-success-strong",
        warning:
          "bg-warning-soft text-warning-strong",
        info:
          "bg-info-soft text-info-strong",
        pending:
          "bg-info-soft text-info-strong",
        urgent:
          "bg-destructive-soft text-destructive-strong",
        solid:
          "bg-primary text-primary-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
