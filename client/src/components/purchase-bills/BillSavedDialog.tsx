import { DocumentSavedDialog } from "@/components/documents/DocumentSavedDialog";
import { useToast } from "@/hooks/use-toast";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";
import { printOutcomeMessage } from "@/lib/printPdf";

export interface SavedBill {
  _id: string;
  billNumber?: string;
  totalAmount?: number;
  vendorName?: string;
  vendorId?: { name?: string } | string | null;
}

/**
 * After a purchase bill is saved: Print, Download or Close. A purchase bill is
 * the supplier's bill to the business, so there is no Send — nothing goes to
 * a customer. Nothing happens until an action is chosen.
 */
export function BillSavedDialog({ bill, title, onClose }: { bill: SavedBill | null; title?: string; onClose: () => void }) {
  const { toast } = useToast();
  if (!bill?._id) return null;
  const number = bill.billNumber || "Purchase bill";
  const supplier = bill.vendorName || (typeof bill.vendorId === "object" ? bill.vendorId?.name : undefined);

  return (
    <DocumentSavedDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title || `${number} saved`}
      description={[number, supplier, bill.totalAmount !== undefined ? formatINR(bill.totalAmount) : null].filter(Boolean).join(" · ")}
      onPrint={async () => {
        const note = printOutcomeMessage(await apiClient.printPurchaseBillPDF(bill._id, bill.billNumber), number);
        if (note) toast(note);
      }}
      onDownload={() => apiClient.downloadPurchaseBillPDF(bill._id, bill.billNumber)}
    />
  );
}
