import { useState } from "react";
import { CheckCircle2, ChevronDown, Download, Loader2, Printer, Send, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

export interface SendOption {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

export interface DocumentSavedDialogProps {
  open: boolean;
  /** Closing — by Close, Escape or the overlay — does nothing else. */
  onOpenChange: (open: boolean) => void;
  /** "Invoice saved", "Quotation updated"… */
  title: string;
  /** The document number, customer, total. */
  description?: React.ReactNode;
  /** Left out, the action is not offered (e.g. no PDF permission). */
  onPrint?: () => Promise<void>;
  onDownload?: () => Promise<void>;
  /** The ways to send it. Empty or left out, Send is not shown. */
  sendOptions?: SendOption[];
}

/**
 * What can be done with a document once it is saved: Print, Download, Send,
 * or Close. Saving never downloads or prints by itself — each happens only
 * when its button is pressed, and always on the PDF of the document as saved.
 * Used after saving invoices, quotations and purchase bills.
 */
export function DocumentSavedDialog({ open, onOpenChange, title, description, onPrint, onDownload, sendOptions = [] }: DocumentSavedDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"print" | "download" | null>(null);

  // Print is started straight from the click: on phones it opens a tab, which
  // browsers only allow during the click itself (see lib/printPdf).
  const run = (kind: "print" | "download", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    action()
      .catch((error) =>
        toast({
          title: kind === "print" ? "Could not print" : "Download failed",
          description: error instanceof Error ? error.message : undefined,
          variant: "destructive"
        })
      )
      .finally(() => setBusy(null));
  };

  const sendButton =
    sendOptions.length === 1 ? (
      <Button variant="outline" onClick={sendOptions[0].onSelect}>
        <Send />
        {sendOptions[0].label}
      </Button>
    ) : sendOptions.length > 1 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <Send />
            Send
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sendOptions.map(({ key, label, icon: Icon, onSelect }) => (
            <DropdownMenuItem key={key} onSelect={onSelect}>
              <Icon />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md" data-testid="document-saved-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-success-strong" aria-hidden />
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>
            Close
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            {onPrint && (
              <Button variant="outline" onClick={() => run("print", onPrint)} disabled={!!busy}>
                {busy === "print" ? <Loader2 className="animate-spin" /> : <Printer />}
                Print
              </Button>
            )}
            {onDownload && (
              <Button variant="outline" onClick={() => run("download", onDownload)} disabled={!!busy}>
                {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />}
                Download
              </Button>
            )}
            {sendButton}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
