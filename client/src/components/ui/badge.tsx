import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
  Status badges use the soft/strong token pairs so their text stays readable
  in both themes. `pending` and `urgent` are older names kept for callers.
*/
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium leading-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-primary/20 bg-primary-soft text-primary-strong",
        secondary:
          "border-border bg-secondary text-secondary-foreground",
        destructive:
          "border-destructive/25 bg-destructive-soft text-destructive-strong",
        outline: "border-border bg-transparent text-foreground",
        success:
          "border-success/25 bg-success-soft text-success-strong",
        warning:
          "border-warning/30 bg-warning-soft text-warning-strong",
        info:
          "border-info/25 bg-info-soft text-info-strong",
        pending:
          "border-info/25 bg-info-soft text-info-strong",
        urgent:
          "border-destructive/25 bg-destructive-soft text-destructive-strong",
        solid:
          "border-transparent bg-primary text-primary-foreground",
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
