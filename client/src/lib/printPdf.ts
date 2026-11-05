/**
 * Printing and saving the PDFs the server makes (invoices).
 *
 * The invoice PDF *is* the invoice: the same file is downloaded, emailed, sent
 * on WhatsApp and printed. Printing draws that file's pages, at print
 * resolution, into a hidden frame and opens the browser's print dialog on
 * them, so what is printed cannot differ from what is downloaded or sent —
 * same A4 page, same margins, same page breaks. Nothing is downloaded.
 *
 * (The PDF itself cannot be printed from inside the page: current Chrome shows
 * a PDF in a frame through a viewer the page is not allowed to touch, so the
 * frame's print() is refused. Its pages are drawn with pdf.js instead.)
 *
 * Where it runs decides the route to the printer:
 * - Desktop browsers (Chrome, Edge, Firefox, Safari): the print dialog opens
 *   over the invoice's pages, from a hidden frame.
 * - The Carbon desktop app: the PDF opens in a print window (the desktop
 *   shell provides it), whose Print button opens the system dialog.
 * - Phones and tablets: the PDF opens in a new tab, to print or share from.
 * - If none of that works, the file is saved instead, so it is never lost.
 */

export interface PdfFile {
  blob: Blob;
  filename: string;
}

/** What happened: the print dialog opened, or the PDF opened somewhere to print it from, or it was saved. */
export type PrintOutcome = "dialog" | "window" | "tab" | "downloaded";

interface DesktopBridge {
  printPdf?: (bytes: ArrayBuffer, title: string) => Promise<unknown>;
}

/**
 * What to tell the person when the print dialog did not open by itself (and
 * nothing when it did — the dialog says it all). `what` names the document.
 */
export function printOutcomeMessage(outcome: PrintOutcome, what = "Invoice"): { title: string; description: string } | null {
  switch (outcome) {
    case "window":
      return { title: `${what} ready to print`, description: "Use Print in the window that opened." };
    case "tab":
      return { title: `${what} opened in a new tab`, description: "Print it from there with your browser's Print or Share button." };
    case "downloaded":
      return { title: `${what} saved`, description: "This browser could not print it directly, so the PDF was downloaded. Open it to print." };
    default:
      return null;
  }
}

const desktopBridge = (): DesktopBridge | undefined => (globalThis as { serpyDesktop?: DesktopBridge }).serpyDesktop;

/** Phones and tablets print a page, not a frame inside it; they get the PDF in a tab instead. */
export function isMobileDevice(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator): boolean {
  const ua = nav.userAgent;
  return /iPad|iPhone|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
}

/** Saves a file through the browser's download, under the given name. */
export function saveFile({ blob, filename }: PdfFile) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

// 300 dpi is print resolution: 10 pt text is sharp and a payment QR's modules
// print crisp. An A4 page is then 2480 × 3508 pixels.
const PRINT_DPI = 300;
const MM_PER_POINT = 25.4 / 72;

interface PrintPage {
  url: string;
  widthMm: number;
  heightMm: number;
}

/** Draws each page of the PDF to an image, at its own size. */
async function renderPages(blob: Blob): Promise<PrintPage[]> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages: PrintPage[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not draw the invoice for printing");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const image = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The invoice page could not be drawn"))), "image/png")
      );
      pages.push({ url: URL.createObjectURL(image), widthMm: size.width * MM_PER_POINT, heightMm: size.height * MM_PER_POINT });
      // Let go of the 35 MB bitmap before drawing the next page.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  } catch (error) {
    pages.forEach((p) => URL.revokeObjectURL(p.url));
    throw error;
  } finally {
    await pdf.destroy();
  }
  return pages;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/**
 * The sheet the print dialog sees: one image per page, each exactly the page's
 * size, on paper of that size with no margin (the PDF carries its own). Each
 * page box is half a millimetre short so rounding never spills onto a blank
 * extra sheet; what that trims is the PDF's empty bottom margin.
 */
function printSheet(pages: PrintPage[], title: string): string {
  const [first] = pages;
  const mm = (n: number) => `${n.toFixed(2)}mm`;
  const body = pages
    .map((p) => `<div class="page" style="width:${mm(p.widthMm)};height:${mm(p.heightMm - 0.5)}"><img src="${p.url}" style="width:${mm(p.widthMm)};height:${mm(p.heightMm)}" alt=""></div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { size: ${mm(first.widthMm)} ${mm(first.heightMm)}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { overflow: hidden; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
.page img { display: block; }
</style></head><body>${body}</body></html>`;
}

// The frame of the last print stays until its dialog closes (or the next
// print replaces it): the dialog reads from it while it is open.
let lastPrint: { frame: HTMLIFrameElement; urls: string[] } | null = null;

function clearLastPrint() {
  if (!lastPrint) return;
  lastPrint.frame.remove();
  lastPrint.urls.forEach((url) => URL.revokeObjectURL(url));
  lastPrint = null;
}

function printInFrame(pages: PrintPage[], title: string): Promise<void> {
  clearLastPrint();
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("style", "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;");
  const current = { frame, urls: pages.map((p) => p.url) };
  lastPrint = current;

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The invoice did not load for printing")), 20000);
    frame.onload = async () => {
      window.clearTimeout(timer);
      try {
        const win = frame.contentWindow;
        const doc = frame.contentDocument;
        if (!win || !doc) throw new Error("The invoice could not be opened for printing");
        await Promise.all(Array.from(doc.images).map((img) => img.decode().catch(() => undefined)));
        win.addEventListener("afterprint", () => setTimeout(() => lastPrint === current && clearLastPrint(), 1000));
        win.focus();
        win.print();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    frame.srcdoc = printSheet(pages, title);
    document.body.appendChild(frame);
  });
}

/**
 * Prints the PDF that `load` fetches.
 *
 * Call it straight from the click handler, before anything is awaited: where
 * the PDF has to open in a new tab, the tab is opened at once, while the
 * browser still counts it as the user's click (a tab opened after the download
 * would be blocked as a pop-up), and filled when the file arrives.
 */
export async function printPdf(load: () => Promise<PdfFile>): Promise<PrintOutcome> {
  const desktop = desktopBridge();
  const mode = desktop?.printPdf ? "window" : isMobileDevice() ? "tab" : "frame";
  const tab = mode === "tab" ? window.open("", "_blank") : null;

  let file: PdfFile;
  try {
    file = await load();
  } catch (error) {
    tab?.close();
    throw error;
  }

  if (mode === "window" && desktop?.printPdf) {
    await desktop.printPdf(await file.blob.arrayBuffer(), file.filename);
    return "window";
  }

  if (mode === "tab") {
    if (!tab) {
      saveFile(file);
      return "downloaded";
    }
    const url = URL.createObjectURL(file.blob);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return "tab";
  }

  try {
    await printInFrame(await renderPages(file.blob), file.filename.replace(/\.pdf$/i, ""));
    return "dialog";
  } catch {
    clearLastPrint();
    saveFile(file);
    return "downloaded";
  }
}
