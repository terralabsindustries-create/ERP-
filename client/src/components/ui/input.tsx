import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground transition-[color,background-color,border-color,box-shadow] duration-200 ease-[ease] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-3 hover:border-foreground/25 focus-visible:outline-none focus-visible:border-primary focus-visible:bg-card focus-visible:shadow-ring disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 aria-[invalid=true]:border-danger-border aria-[invalid=true]:focus-visible:border-danger-border md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
