import { useState } from "react";
import { Mail, MessageSquare } from "lucide-react";
import { DocumentSavedDialog, type SendOption } from "@/components/documents/DocumentSavedDialog";
import { ViewInvoiceDialog, type InvoiceSendChannel } from "@/components/invoices/ViewInvoiceDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";
import { printOutcomeMessage } from "@/lib/printPdf";

/** The saved invoice, as the create / update / convert APIs return it. */
export interface SavedInvoice {
  _id?: string;
  id?: string;
  invoiceNumber?: string;
  status?: string;
  totalAmount?: number;
  customerName?: string;
  customerId?: { name?: string } | string | null;
}

export const savedInvoiceId = (invoice: SavedInvoice | null | undefined) => invoice?._id || invoice?.id || "";

/**
 * After an invoice is saved: Print, Download, Send (email or WhatsApp, through
 * the invoice's own send forms) or Close. Nothing happens until one is chosen.
 * Each action needs its permission; one the login lacks is not offered.
 */
export function InvoiceSavedDialog({
  invoice,
  title,
  onClose,
  onInvoiceUpdated
}: {
  invoice: SavedInvoice | null;
  title?: string;
  /** The dialog, and any send form opened from it, is finished. */
  onClose: () => void;
  /** Sending can issue a draft; refresh whatever lists it. */
  onInvoiceUpdated?: () => void;
}) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [sendVia, setSendVia] = useState<InvoiceSendChannel | null>(null);
  const id = savedInvoiceId(invoice);
  if (!invoice || !id) return null;

  const number = invoice.invoiceNumber || "Invoice";
  const customer = invoice.customerName || (typeof invoice.customerId === "object" ? invoice.customerId?.name : undefined);
  const canPdf = hasPermission("Invoicing: Download PDF");
  const sendOptions: SendOption[] = [
    ...(hasPermission("Invoicing: Send Email") ? [{ key: "email", label: "Send by email", icon: Mail, onSelect: () => setSendVia("email") }] : []),
    ...(hasPermission("WhatsApp: Send Messages") ? [{ key: "whatsapp", label: "Send on WhatsApp", icon: MessageSquare, onSelect: () => setSendVia("whatsapp") }] : [])
  ];

  return (
    <>
      <DocumentSavedDialog
        open={!sendVia}
        onOpenChange={(open) => !open && onClose()}
        title={title || `${number} saved`}
        description={[number, customer, invoice.totalAmount !== undefined ? formatINR(invoice.totalAmount) : null, invoice.status === "draft" ? "Draft" : null]
          .filter(Boolean)
          .join(" · ")}
        onPrint={
          canPdf
            ? async () => {
                const note = printOutcomeMessage(await apiClient.printInvoicePDF(id), number);
                if (note) toast(note);
              }
            : undefined
        }
        onDownload={canPdf ? () => apiClient.downloadInvoicePDF(id) : undefined}
        sendOptions={sendOptions}
      />
      {/* The existing send flow: the invoice, opened on the chosen channel's form. */}
      <ViewInvoiceDialog
        open={!!sendVia}
        onOpenChange={(open) => {
          if (open) return;
          setSendVia(null);
          onClose();
        }}
        invoice={(sendVia ? { _id: id, id, invoiceNumber: number } : null) as never}
        sendVia={sendVia}
        onInvoiceUpdated={() => onInvoiceUpdated?.()}
      />
    </>
  );
}
