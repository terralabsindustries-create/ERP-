import { DocumentSavedDialog, type DocumentDetail } from "@/components/documents/DocumentSavedDialog";
import apiClient from "@/lib/apiClient";
import { formatINR } from "@/lib/format";

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
  if (!bill?._id) return null;
  const number = bill.billNumber || "Purchase bill";
  const supplier = bill.vendorName || (typeof bill.vendorId === "object" ? bill.vendorId?.name : undefined);

  const details: DocumentDetail[] = [
    { label: "Bill no.", value: number, mono: true },
    ...(supplier ? [{ label: "Supplier", value: supplier }] : []),
    ...(bill.totalAmount !== undefined ? [{ label: "Amount", value: formatINR(bill.totalAmount), strong: true }] : [])
  ];

  return (
    <DocumentSavedDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title || `${number} saved`}
      details={details}
      documentKey={bill._id}
      documentName={number}
      loadPdf={(signal) => apiClient.getPurchaseBillPdfFile(bill._id, bill.billNumber, signal)}
    />
  );
}
