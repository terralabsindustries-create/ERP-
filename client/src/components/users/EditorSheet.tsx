import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface EditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons pinned to the bottom of the panel. */
  footer: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
  onSubmit?: (e: React.FormEvent) => void;
}

/**
 * The side panel the user, role and team editors open in: a fixed header,
 * a scrolling body and the actions pinned at the bottom, full width on phones.
 */
export function EditorSheet({ open, onOpenChange, title, description, footer, children, wide, onSubmit }: EditorSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn("flex w-full flex-col gap-0 p-0", wide ? "sm:max-w-3xl" : "sm:max-w-xl")}>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle>{title}</SheetTitle>
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">{children}</div>
          <div className="flex flex-col-reverse gap-2 border-t bg-card px-5 py-3 sm:flex-row sm:items-center sm:justify-end">{footer}</div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** A titled block inside an editor. */
export function EditorSection({ title, description, children, className }: { title: string; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3", className)}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
