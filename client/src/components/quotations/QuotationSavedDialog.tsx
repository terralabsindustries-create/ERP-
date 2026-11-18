import { useState } from "react";
import { Mail, MessageSquare } from "lucide-react";
import { DocumentSavedDialog, type SendOption } from "@/components/documents/DocumentSavedDialog";
import { SendQuotationEmailDialog, SendQuotationWhatsAppDialog, type SendableQuotation } from "@/components/quotations/SendQuotationDialogs";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";
import { printOutcomeMessage } from "@/lib/printPdf";

export interface SavedQuotation extends SendableQuotation {
  status?: string;
  total_amount?: number;
}

// Matches the Quotations list: a converted or closed quotation is not sent again.
const FINISHED = ["converted", "closed"];

/**
 * After a quotation is saved: Print, Download, Send (email or WhatsApp, the
 * same forms as the Quotations list) or Close. Nothing happens until one is
 * chosen.
 */
export function QuotationSavedDialog({ quotation, title, onClose, onSent }: { quotation: SavedQuotation | null; title?: string; onClose: () => void; onSent?: () => void }) {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const [sendVia, setSendVia] = useState<"email" | "whatsapp" | null>(null);
  if (!quotation?._id) return null;

  const number = quotation.quotationNumber || "Quotation";
  const sendable = !FINISHED.includes(quotation.status || "");
  const sendOptions: SendOption[] = sendable
    ? [
        ...(hasPermission("Quotations: Send Email") ? [{ key: "email", label: "Email to customer", icon: Mail, onSelect: () => setSendVia("email") }] : []),
        ...(hasPermission("WhatsApp: Send Messages") ? [{ key: "whatsapp", label: "Send on WhatsApp", icon: MessageSquare, onSelect: () => setSendVia("whatsapp") }] : [])
      ]
    : [];
  const finishSend = (open: boolean) => {
    if (open) return;
    setSendVia(null);
    onClose();
  };

  return (
    <>
      <DocumentSavedDialog
        open={!sendVia}
        onOpenChange={(open) => !open && onClose()}
        title={title || `${number} saved`}
        description={[number, quotation.customer_id?.name, quotation.total_amount !== undefined ? formatINR(quotation.total_amount) : null].filter(Boolean).join(" · ")}
        onPrint={async () => {
          const note = printOutcomeMessage(await apiClient.printQuotationPDF(quotation._id, quotation.quotationNumber), number);
          if (note) toast(note);
        }}
        onDownload={() => apiClient.downloadQuotationPDF(quotation._id, quotation.quotationNumber)}
        sendOptions={sendOptions}
      />
      <SendQuotationEmailDialog quotation={sendVia === "email" ? quotation : null} onOpenChange={finishSend} onSent={() => onSent?.()} />
      <SendQuotationWhatsAppDialog quotation={sendVia === "whatsapp" ? quotation : null} onOpenChange={finishSend} onSent={() => onSent?.()} />
    </>
  );
}
