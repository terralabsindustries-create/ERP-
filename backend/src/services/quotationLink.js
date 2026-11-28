const Quotation = require('../models/Quotation');

/**
 * Keeps a quotation's "converted" state in step with its invoice. When the
 * invoice raised from a quotation is deleted (draft) or cancelled, the quotation
 * is released: it returns to the status it had before conversion so it can be
 * converted again, and the released invoice stays in conversionHistory.
 * The released invoice's number is never reused; the next conversion gets a
 * new number from the normal sequence.
 *
 * Never throws: invoice deletion/cancellation must not fail because of this.
 */
async function releaseQuotationForInvoice(invoice, reason) {
  try {
    const quotation = await Quotation.findOne({ convertedInvoiceId: invoice._id, status: 'converted' });
    if (!quotation) return null;
    const history = (quotation.conversionHistory || []).map((h) => (h.toObject ? h.toObject() : h));
    const entry = history.find((h) => String(h.invoiceId) === String(invoice._id) && !h.releasedAt);
    const releasedAt = new Date();
    if (entry) {
      entry.invoiceNumber = invoice.invoiceNumber; // the number it carried when released (drafts are renumbered on issue)
      entry.releasedAt = releasedAt;
      entry.releasedReason = reason;
    } else {
      history.push({ invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber, convertedAt: quotation.convertedAt, releasedAt, releasedReason: reason });
    }
    return await Quotation.findOneAndUpdate(
      { _id: quotation._id, convertedInvoiceId: invoice._id, status: 'converted' },
      {
        $set: { status: quotation.statusBeforeConversion || 'approved', conversionHistory: history },
        $unset: { convertedInvoiceId: '', convertedInvoiceNumber: '', convertedAt: '', statusBeforeConversion: '' }
      },
      { new: true }
    );
  } catch (error) {
    console.error(`Quotation for invoice ${invoice.invoiceNumber} was not released:`, error.message);
    return null;
  }
}

module.exports = { releaseQuotationForInvoice };
