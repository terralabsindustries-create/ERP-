import apiClient from "@/lib/apiClient";
import type { PdfFile } from "@/lib/printPdf";

interface DocumentPdfRow {
  id: string;
  number: string;
}

/** Combine the exact server PDFs for selected documents in the order shown. */
export async function bulkPdf(
  documents: DocumentPdfRow[],
  getPdf: (document: DocumentPdfRow) => Promise<PdfFile>,
  filename: string
): Promise<PdfFile> {
  if (!documents.length) throw new Error("Select at least one document.");
  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  // Generating a PDF on the server is expensive; keep concurrent requests small.
  for (let offset = 0; offset < documents.length; offset += 3) {
    const batch = documents.slice(offset, offset + 3);
    const files = await Promise.all(batch.map(async (document) => {
      try {
        return { document, file: await getPdf(document) };
      } catch (error) {
        throw new Error(`${document.number}: ${error instanceof Error ? error.message : "PDF could not be loaded"}`);
      }
    }));
    for (const { document, file } of files) {
      try {
        const source = await PDFDocument.load(await file.blob.arrayBuffer());
        const pages = await merged.copyPages(source, source.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      } catch (error) {
        throw new Error(`${document.number}: ${error instanceof Error ? error.message : "PDF could not be combined"}`);
      }
    }
  }
  const bytes = await merged.save();
  return {
    blob: new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    filename
  };
}

interface InvoicePdfRow {
  _id: string;
  invoiceNumber: string;
}

export function bulkInvoicePdf(invoices: InvoicePdfRow[]): Promise<PdfFile> {
  return bulkPdf(
    invoices.map((invoice) => ({ id: invoice._id, number: invoice.invoiceNumber })),
    (invoice) => apiClient.getInvoicePdfFile(invoice.id),
    `Invoices_${invoices.length}_${new Date().toISOString().slice(0, 10)}.pdf`
  );
}

interface QuotationPdfRow {
  _id: string;
  quotationNumber: string;
}

export function bulkQuotationPdf(quotations: QuotationPdfRow[]): Promise<PdfFile> {
  return bulkPdf(
    quotations.map((quotation) => ({ id: quotation._id, number: quotation.quotationNumber })),
    (quotation) => apiClient.getQuotationPdfFile(quotation.id, quotation.number),
    `Quotations_${quotations.length}_${new Date().toISOString().slice(0, 10)}.pdf`
  );
}
