import { Link } from "react-router-dom";
import { formatINR } from "@/lib/format";

export interface InvoicePaymentBreakdown {
  recordedOnInvoices: number;
  recordedOutsidePayments: number;
  directEntries: { invoiceNumber: string; amount: number }[];
}

/** Explain invoice balances that were marked paid without a payment receipt. */
export function InvoicePaymentReconciliation({ breakdown }: { breakdown: InvoicePaymentBreakdown | null }) {
  if (!breakdown || breakdown.recordedOutsidePayments <= 0) return null;

  return (
    <div className="rounded-xl border border-amber/35 bg-amber-soft/40 px-4 py-3 text-sm text-foreground" role="note">
      <p className="font-semibold">{formatINR(breakdown.recordedOutsidePayments)} is marked paid directly on invoices</p>
      <p className="mt-1 text-muted-foreground">
        This amount is included in invoice totals but has no payment receipt, so it does not appear in Payments received.
        Check whether it was actually received before changing a balance or recording a payment.
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {breakdown.directEntries.map((entry) => (
          <Link key={entry.invoiceNumber} className="font-medium text-amber hover:underline" to={`/invoices?q=${encodeURIComponent(entry.invoiceNumber)}`}>
            {entry.invoiceNumber}: {formatINR(entry.amount)}
          </Link>
        ))}
      </div>
    </div>
  );
}
