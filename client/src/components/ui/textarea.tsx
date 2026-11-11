import * as React from "react"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground transition-[color,background-color,border-color,box-shadow] duration-200 ease-[ease] placeholder:text-ink-3 hover:border-foreground/25 focus-visible:outline-none focus-visible:border-primary focus-visible:bg-card focus-visible:shadow-ring disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 aria-[invalid=true]:border-danger-border aria-[invalid=true]:focus-visible:border-danger-border md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
