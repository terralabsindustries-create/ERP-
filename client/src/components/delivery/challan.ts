import { format } from "date-fns";
import { fmtDate, formatINR } from "@/lib/format";
import type { Delivery } from "@/lib/api/deliveries";
import { dateOnly, fmtPhone, jobTitleOf, slotLabel, totalQty } from "./deliveryMeta";

/** The business details printed at the top of a challan. */
export interface ChallanBusiness {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  gstNumber?: string;
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The delivery challan as a complete, printable HTML page. */
export function challanHtml(d: Delivery, biz: ChallanBusiness) {
  const a = d.deliveryAddress || { street: "", city: "", state: "", pincode: "" };
  const cod = d.paymentMethod === "COD" && (d.codAmount || 0) > 0;
  const rows = (d.items || [])
    .map((i, n) => `<tr><td class="n">${n + 1}</td><td>${esc(i.description)}</td><td class="q">${esc(Number(i.quantity).toLocaleString("en-IN"))}</td></tr>`)
    .join("");
  const meta: [string, string][] = [
    ["Challan no.", d.deliveryId],
    ["Delivery date", `${fmtDate(dateOnly(d.deliveryDate))}${d.deliveryTimeSlot && d.deliveryTimeSlot !== "Flexible" ? ` · ${slotLabel(d.deliveryTimeSlot)}` : ""}`],
    ["Job", jobTitleOf(d) || "—"],
    ["Driver", [d.driverInfo?.name, fmtPhone(d.driverInfo?.phone)].filter(Boolean).join(" · ") || "—"],
    ["Vehicle no.", d.driverInfo?.vehicleNumber || "—"]
  ];
  if (d.trackingNumber) meta.push(["Tracking no.", d.trackingNumber]);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delivery challan ${esc(d.deliveryId)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; background: #f4f4f5; }
  .sheet { max-width: 794px; margin: 24px auto; background: #fff; padding: 36px 40px; border: 1px solid #e4e4e7; }
  .bar { max-width: 794px; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .bar button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #d4d4d8; background: #fff; cursor: pointer; }
  .bar button.primary { background: #111; color: #fff; border-color: #111; }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 14px; }
  .biz { font-size: 20px; font-weight: 700; }
  .muted { color: #555; }
  .doc { text-align: right; }
  .doc h1 { margin: 0; font-size: 16px; letter-spacing: .12em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 18px 0; }
  .label { font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #666; margin-bottom: 4px; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; }
  dt { color: #555; } dd { margin: 0; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #d4d4d8; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  td.n, th.n { width: 36px; text-align: center; } td.q, th.q { width: 90px; text-align: right; }
  tfoot td { font-weight: 700; }
  .pay { margin-top: 14px; padding: 10px 12px; border: 1px dashed #a1a1aa; }
  .notes { margin-top: 12px; white-space: pre-wrap; }
  .signs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 56px; }
  .sign { border-top: 1px solid #111; padding-top: 6px; font-size: 12px; }
  .foot { margin-top: 28px; font-size: 11px; color: #666; text-align: center; }
  @media print {
    body { background: #fff; }
    .bar { display: none; }
    .sheet { margin: 0; border: 0; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
<div class="bar"><button type="button" id="close-btn">Close</button><button type="button" class="primary" id="print-btn">Print</button></div>
<div class="sheet">
  <header>
    <div>
      <div class="biz">${esc(biz.name || "Delivery challan")}</div>
      ${biz.address ? `<div class="muted">${esc(biz.address)}</div>` : ""}
      ${biz.phone || biz.email ? `<div class="muted">${esc([fmtPhone(biz.phone), biz.email].filter(Boolean).join(" · "))}</div>` : ""}
      ${biz.gstNumber ? `<div class="muted">GSTIN ${esc(biz.gstNumber)}</div>` : ""}
    </div>
    <div class="doc">
      <h1>DELIVERY CHALLAN</h1>
      <div class="muted">${esc(d.deliveryId)}</div>
    </div>
  </header>

  <div class="grid">
    <div>
      <div class="label">Deliver to</div>
      <div><strong>${esc(d.customerName)}</strong></div>
      ${d.contactInfo?.name && d.contactInfo.name !== d.customerName ? `<div>Attn: ${esc(d.contactInfo.name)}</div>` : ""}
      <div>${esc(a.street)}</div>
      <div>${esc([a.city, [a.state, a.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", "))}</div>
      ${a.landmark ? `<div class="muted">Landmark: ${esc(a.landmark)}</div>` : ""}
      <div>Phone: ${esc(fmtPhone(d.contactInfo?.phone))}</div>
    </div>
    <div>
      <div class="label">Details</div>
      <dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    </div>
  </div>

  <div class="label">Goods sent</div>
  <table>
    <thead><tr><th class="n">#</th><th>Description</th><th class="q">Qty</th></tr></thead>
    <tbody>${rows || `<tr><td class="n">—</td><td>—</td><td class="q">—</td></tr>`}</tbody>
    <tfoot><tr><td></td><td>Total</td><td class="q">${esc(totalQty(d).toLocaleString("en-IN"))}</td></tr></tfoot>
  </table>

  <div class="pay">${
    cod
      ? `<strong>Cash on delivery:</strong> collect ${esc(formatINR(d.codAmount || 0))} from the customer.`
      : `<strong>Payment:</strong> prepaid — nothing to collect.`
  }${d.charges?.deliveryFee ? ` Delivery charge ${esc(formatINR(d.charges.deliveryFee))}.` : ""}</div>
  ${d.deliveryNotes ? `<div class="notes"><span class="label">Notes</span><br>${esc(d.deliveryNotes)}</div>` : ""}

  <div class="signs">
    <div class="sign">Received in good condition<br><span class="muted">Receiver's name, signature and date</span></div>
    <div class="sign">Delivered by<br><span class="muted">Driver's signature</span></div>
    <div class="sign">For ${esc(biz.name || "the sender")}<br><span class="muted">Authorised signatory</span></div>
  </div>
  <div class="foot">Goods sent on delivery challan; not a tax invoice. Printed ${esc(format(new Date(), "d MMM yyyy, h:mm a"))}.</div>
</div>
</body>
</html>`;
}

/**
 * Opens the challan in a new window and brings up the print dialog. Falls back
 * to printing from a hidden frame when pop-ups are blocked.
 */
export function printChallan(d: Delivery, biz: ChallanBusiness) {
  const html = challanHtml(d, biz);
  const w = window.open("", "_blank", "width=900,height=1000");
  if (w) {
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.document.getElementById("print-btn")?.addEventListener("click", () => w.print());
    w.document.getElementById("close-btn")?.addEventListener("click", () => w.close());
    w.focus();
    setTimeout(() => w.print(), 300);
    return;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentWindow?.document;
  if (!doc || !frame.contentWindow) {
    frame.remove();
    throw new Error("The challan could not be opened for printing");
  }
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  }, 300);
}
