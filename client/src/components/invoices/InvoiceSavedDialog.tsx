import { useState } from "react";
import { IndianRupee, Mail, MessageSquare } from "lucide-react";
import { DocumentSavedDialog, type DocumentDetail, type SendOption } from "@/components/documents/DocumentSavedDialog";
import { InvoicePaymentDialog, type PayableInvoice, type RecordedPaymentReceipt } from "@/components/invoices/InvoicePaymentDialog";
import { ViewInvoiceDialog, type InvoiceSendChannel } from "@/components/invoices/ViewInvoiceDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";

/** The saved invoice, as the create / update / convert APIs return it. */
export interface SavedInvoice {
  _id?: string;
  id?: string;
  invoiceNumber?: string;
  status?: string;
  totalAmount?: number;
  customerName?: string;
  customerId?: { _id?: string; name?: string } | string | null;
  paidAmount?: number;
  balanceAmount?: number;
}

export const savedInvoiceId = (invoice: SavedInvoice | null | undefined) => invoice?._id || invoice?.id || "";

/**
 * After an invoice is saved: Print, Download, Send, Record payment or Close.
 * Nothing happens until one is chosen.
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
  /** Sending or recording a payment can change the invoice; refresh its list. */
  onInvoiceUpdated?: () => void;
}) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [sendVia, setSendVia] = useState<InvoiceSendChannel | null>(null);
  const [paying, setPaying] = useState<PayableInvoice | null>(null);
  const [receipt, setReceipt] = useState<RecordedPaymentReceipt | null>(null);
  const [loadingPayment, setLoadingPayment] = useState(false);
  const id = savedInvoiceId(invoice);
  if (!invoice || !id) return null;

  const number = invoice.invoiceNumber || "Invoice";
  const customer = invoice.customerName || (typeof invoice.customerId === "object" ? invoice.customerId?.name : undefined);
  const canPdf = hasPermission("Invoicing: Download PDF");
  const balance = invoice.balanceAmount ?? Math.max(0, (invoice.totalAmount || 0) - (invoice.paidAmount || 0));
  const canRecordPayment =
    (hasPermission("Payments: Record Payment") || hasPermission("Invoicing: Record Payment")) &&
    !["draft", "cancelled", "refunded", "paid"].includes(invoice.status || "") && balance > 0;
  const openPayment = async () => {
    if (loadingPayment) return;
    setLoadingPayment(true);
    try {
      // Read the current balance before opening the payment form: another user
      // may have collected against this invoice since the saved dialog opened.
      const response = (await apiClient.getInvoice(id)) as { invoice?: PayableInvoice & { status?: string } };
      const current = response.invoice;
      const due = current?.balanceAmount ?? Math.max(0, (current?.totalAmount || 0) - (current?.paidAmount || 0));
      if (!current || !current.customerId || !current.paymentStatus ||
          ["draft", "cancelled", "refunded", "paid"].includes(current.status || "") || due <= 0) {
        onInvoiceUpdated?.();
        toast({ title: "No payment to record", description: "This invoice is no longer open for payment." });
        return;
      }
      setPaying(current);
    } catch (error) {
      toast({ title: "Could not load invoice", description: error instanceof Error ? error.message : undefined, variant: "destructive" });
    } finally {
      setLoadingPayment(false);
    }
  };
  const sendOptions: SendOption[] = [
    ...(hasPermission("Invoicing: Send Email") ? [{ key: "email", label: "Send by email", icon: Mail, onSelect: () => setSendVia("email") }] : []),
    ...(hasPermission("WhatsApp: Send Messages") ? [{ key: "whatsapp", label: "Send on WhatsApp", icon: MessageSquare, onSelect: () => setSendVia("whatsapp") }] : [])
  ];

  const details: DocumentDetail[] = [
    { label: "Invoice no.", value: invoice.status === "draft" ? `${number} (draft)` : number, mono: true },
    ...(customer ? [{ label: "Customer", value: customer }] : []),
    ...(invoice.totalAmount !== undefined ? [{ label: "Amount", value: formatINR(invoice.totalAmount), strong: true }] : [])
  ];

  return (
    <>
      <DocumentSavedDialog
        open={!sendVia && !paying && !receipt}
        onOpenChange={(open) => !open && onClose()}
        title={title || `${number} saved`}
        details={details}
        documentKey={id}
        documentName={number}
        loadPdf={canPdf ? (signal) => apiClient.getInvoicePdfFile(id, signal) : undefined}
        sendOptions={sendOptions}
        additionalAction={canRecordPayment ? {
          label: "Record payment",
          icon: IndianRupee,
          onSelect: () => void openPayment(),
          loading: loadingPayment
        } : undefined}
      />
      <InvoicePaymentDialog
        invoice={paying}
        onOpenChange={(open) => { if (!open) setPaying(null); }}
        onSaved={(payment) => {
          onInvoiceUpdated?.();
          setPaying(null);
          if (payment) setReceipt(payment);
          else onClose();
        }}
      />
      {receipt && (
        <DocumentSavedDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            setReceipt(null);
            onClose();
          }}
          title="Payment recorded"
          details={[
            { label: "Receipt no.", value: receipt.paymentId, mono: true },
            { label: "Invoice", value: number, mono: true },
            { label: "Amount received", value: formatINR(receipt.amount), strong: true }
          ]}
          documentKey={receipt._id}
          documentName={`Receipt ${receipt.paymentId}`}
          loadPdf={(signal) => apiClient.getPaymentReceiptPdfFile(receipt._id, receipt.paymentId, signal)}
        />
      )}
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
