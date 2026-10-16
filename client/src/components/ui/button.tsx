import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/*
  Pick a variant by intent:
    default      the one primary action in a view
    outline      secondary actions next to it (Cancel, Export, filters)
    secondary    a filled neutral button, for toolbars and toggles
    subtle       a tinted brand button, for "add another" style actions
    ghost        icon buttons and actions inside rows and cards
    destructive  delete / cancel-job, always behind a confirmation
    link         inline text actions
  The remaining variants are kept for older screens and map onto these looks.
*/
const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-card text-foreground shadow-sm hover:border-foreground/20 hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70 dark:hover:bg-secondary/80",
        subtle:
          "bg-primary-soft text-primary-strong hover:bg-primary/15",
        ghost: "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90",
        warning: "bg-warning text-warning-foreground shadow-sm hover:bg-warning/90",
        pending: "bg-warning text-warning-foreground shadow-sm hover:bg-warning/90",
        urgent: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        gradient: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
        accent: "bg-foreground text-background shadow-sm hover:bg-foreground/90",
        glass: "border border-input bg-card text-foreground shadow-sm hover:bg-accent",
        floating: "bg-primary text-primary-foreground shadow-float hover:bg-primary-hover",
      },
      size: {
        default: "h-9 px-4",
        xs: "h-7 gap-1 rounded px-2.5 text-xs [&_svg]:size-3.5",
        sm: "h-8 gap-1.5 px-3 text-[13px]",
        lg: "h-10 px-5",
        xl: "h-11 rounded-lg px-6 text-base",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
        "icon-xs": "h-7 w-7 rounded [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** Shows a spinner and blocks clicks while an action is running. */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={asChild ? disabled : disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Loader2 className="button-spinner animate-spin" aria-hidden />}
            <span className={cn("contents", loading && "[&>svg]:hidden")}>{children}</span>
          </>
        )}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
