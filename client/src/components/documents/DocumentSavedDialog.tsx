import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Download, Loader2, Printer, Send, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { isAbortError, preparePrinting, printOutcomeMessage, printPdf, saveFile, type PdfFile } from "@/lib/printPdf";

export interface SendOption {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/** One line of the document's summary: "Invoice no. · INV-0041". */
export interface DocumentDetail {
  label: string;
  value: React.ReactNode;
  /** Document numbers: set in the mono face, like on the PDF. */
  mono?: boolean;
  /** The amount: set bold. */
  strong?: boolean;
}

export interface DocumentSavedDialogProps {
  open: boolean;
  /** Closing — by Close, the X, Escape or the overlay — does nothing else, and works at any time. */
  onOpenChange: (open: boolean) => void;
  /** "Invoice saved", "Quotation updated"… */
  title: string;
  /** The document number, customer, total, shown as a short summary. */
  details?: DocumentDetail[];
  /** Free text under the title, for anything the details do not cover. */
  description?: React.ReactNode;
  /**
   * Which document this is (its id). The PDF fetched for one document is
   * never used for another.
   */
  documentKey: string;
  /** What the document is called in messages: "INV-0041", "Quotation". */
  documentName: string;
  /** Fetches the saved document's PDF. Left out, Print and Download are not offered (e.g. no PDF permission). */
  loadPdf?: (signal: AbortSignal) => Promise<PdfFile>;
  /** The ways to send it. Empty or left out, Send is not shown. */
  sendOptions?: SendOption[];
}

const ACTION_COLUMNS = ["", "sm:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3"];

/**
 * What can be done with a document once it is saved: Print, Download, Send,
 * or Close. Saving never downloads or prints by itself — each happens only
 * when its button is pressed, and always on the PDF of the document as saved.
 * Used after saving invoices, quotations and purchase bills.
 *
 * The PDF is fetched once, as the dialog opens (the document is already
 * saved, so it is the final version), and Print and Download both use that
 * file: pressing Print no longer waits for the server, and printing then
 * downloading does not make the PDF twice. Printing's own code is loaded at
 * the same time. Closing the dialog drops the file and cancels anything still
 * being prepared.
 */
export function DocumentSavedDialog({
  open,
  onOpenChange,
  title,
  details,
  description,
  documentKey,
  documentName,
  loadPdf,
  sendOptions = []
}: DocumentSavedDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"print" | "download" | null>(null);
  // The click guard is a ref: two clicks in one frame both see the old state.
  const busyRef = useRef<"print" | "download" | null>(null);
  const session = useRef<{ controller: AbortController; file: Promise<PdfFile> | null } | null>(null);
  const loadRef = useRef(loadPdf);
  loadRef.current = loadPdf;
  const canPdf = !!loadPdf;

  const getFile = useCallback((): Promise<PdfFile> => {
    const current = session.current;
    const load = loadRef.current;
    if (!current || !load) return Promise.reject(new Error("The document is not available"));
    current.file ||= load(current.controller.signal).catch((error) => {
      // A failed fetch is not kept: the next Print or Download tries again.
      if (session.current === current) current.file = null;
      throw error;
    });
    return current.file;
  }, []);

  // One session per opening of the dialog for one document.
  useEffect(() => {
    if (!open || !canPdf) return;
    const current = { controller: new AbortController(), file: null };
    session.current = current;
    preparePrinting();
    getFile().catch(() => undefined); // errors are shown if the person presses Print or Download
    return () => {
      current.controller.abort();
      if (session.current === current) session.current = null;
      busyRef.current = null;
      setBusy(null);
    };
  }, [open, canPdf, documentKey, getFile]);

  // Print is started straight from the click: on phones it opens a tab, which
  // browsers only allow during the click itself (see lib/printPdf).
  const run = (kind: "print" | "download") => {
    const current = session.current;
    if (busyRef.current || !current) return;
    busyRef.current = kind;
    setBusy(kind);
    const { signal } = current.controller;
    const action =
      kind === "print"
        ? printPdf(getFile, { signal }).then((outcome) => {
            const note = printOutcomeMessage(outcome, documentName);
            if (note) toast(note);
          })
        : getFile().then((file) => {
            if (!signal.aborted) saveFile(file);
          });
    action
      .catch((error) => {
        if (signal.aborted || isAbortError(error)) return;
        toast({
          title: kind === "print" ? "Could not print" : "Download failed",
          description: error instanceof Error ? error.message : undefined,
          variant: "destructive"
        });
      })
      .finally(() => {
        if (session.current !== current) return;
        busyRef.current = null;
        setBusy(null);
      });
  };

  const sendButton =
    sendOptions.length === 1 ? (
      <Button variant="outline" className="w-full" onClick={sendOptions[0].onSelect}>
        <Send />
        <span className="truncate">{sendOptions[0].label}</span>
      </Button>
    ) : sendOptions.length > 1 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full">
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

  const actionCount = (canPdf ? 2 : 0) + (sendButton ? 1 : 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md gap-5 overflow-x-hidden"
        data-testid="document-saved-dialog"
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-strong" aria-hidden />
            <span className="min-w-0 break-words">{title}</span>
          </DialogTitle>
          {description && <DialogDescription className="break-words">{description}</DialogDescription>}
        </DialogHeader>

        {details && details.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
            {details.map(({ label, value, mono, strong }) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd
                  className={cn(
                    "min-w-0 break-words text-right text-foreground",
                    mono && "font-mono text-[13px]",
                    strong && "font-semibold tabular-nums"
                  )}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {actionCount > 0 && (
          <div className={cn("grid grid-cols-1 gap-2", ACTION_COLUMNS[actionCount])}>
            {canPdf && (
              <Button variant="outline" className="w-full" onClick={() => run("print")} disabled={!!busy} aria-busy={busy === "print"}>
                {busy === "print" ? <Loader2 className="animate-spin" /> : <Printer />}
                {busy === "print" ? "Preparing…" : "Print"}
              </Button>
            )}
            {canPdf && (
              <Button variant="outline" className="w-full" onClick={() => run("download")} disabled={!!busy} aria-busy={busy === "download"}>
                {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />}
                Download
              </Button>
            )}
            {sendButton}
          </div>
        )}

        <DialogFooter className="pt-0">
          <Button variant="ghost" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
