/**
 * The WhatsApp templates the ERP's own sends are written for: payment
 * reminders, invoices, receipts and quotations. The WhatsApp page offers to
 * submit any that are missing from the account, and
 * scripts/createWhatsAppTemplates.js submits them from the command line.
 *
 * Meta rules baked into these bodies:
 *  - variables are numbered {{1}}..{{n}}, sequential, no gaps
 *  - the body never starts or ends with a variable
 *  - no two variables sit next to each other
 *  - every variable has a sample value (Meta rejects the template otherwise)
 *  - footers cannot contain variables
 */

const LANGUAGE = 'en_US';
const OPT_OUT_FOOTER = 'Reply STOP to opt out of these updates.';
const SAMPLE_BUSINESS = 'Terralabs Industries';

const STARTER_TEMPLATES = [
  {
    name: 'payment_reminder',
    category: 'UTILITY',
    purpose: 'Payment reminders',
    body:
      'Hi {{1}}, this is a friendly reminder that your invoice {{2}} of Rs. {{3}} has a pending balance of Rs. {{4}}. The payment was due on {{5}}. Please make the payment at your earliest convenience.\n\nThank you,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '45,000', '15,000', '05 Aug 2026', SAMPLE_BUSINESS],
    footer: OPT_OUT_FOOTER,
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'totalAmount', 4: 'balanceAmount', 5: 'dueDate', 6: 'businessName' }
  },
  {
    name: 'payment_overdue_notice',
    category: 'UTILITY',
    purpose: 'Overdue payment notices',
    body:
      'Hi {{1}}, our records show that invoice {{2}} with an outstanding balance of Rs. {{3}} is now {{4}} days past its due date of {{5}}. Kindly arrange the payment, or reply to this message if you need any help with it.\n\nThank you,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '15,000', '12', '05 Aug 2026', SAMPLE_BUSINESS],
    footer: OPT_OUT_FOOTER,
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'balanceAmount', 4: 'daysOverdue', 5: 'dueDate', 6: 'businessName' }
  },
  {
    name: 'payment_due_soon',
    category: 'UTILITY',
    purpose: 'Reminders before the due date',
    body:
      'Hi {{1}}, a quick heads-up that invoice {{2}} for Rs. {{3}} is due on {{4}}. Please ignore this message if the payment is already on its way.\n\nThank you,\n{{5}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '45,000', '05 Aug 2026', SAMPLE_BUSINESS],
    footer: OPT_OUT_FOOTER,
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'balanceAmount', 4: 'dueDate', 5: 'businessName' }
  },
  {
    name: 'invoice_created',
    category: 'UTILITY',
    purpose: 'Sending invoices',
    body:
      'Hi {{1}}, your invoice {{2}} dated {{3}} for Rs. {{4}} has been generated. The payment is due on {{5}}. Reply to this message if you need a copy of the invoice or have any questions.\n\nThank you,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '01 Aug 2026', '45,000', '05 Aug 2026', SAMPLE_BUSINESS],
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'invoiceDate', 4: 'totalAmount', 5: 'dueDate', 6: 'businessName' }
  },
  {
    name: 'payment_received',
    category: 'UTILITY',
    purpose: 'Payment receipts',
    body:
      'Hi {{1}}, we have received your payment of Rs. {{2}} towards invoice {{3}} on {{4}}. Your remaining balance is Rs. {{5}}. Thank you for your business.\n\nRegards,\n{{6}} Team',
    samples: ['Rajesh Kumar', '30,000', 'INV-2026-0142', '08 Aug 2026', '15,000', SAMPLE_BUSINESS],
    mapping: { 1: 'customerName', 2: 'amountPaid', 3: 'invoiceNumber', 4: 'paymentDate', 5: 'balanceAmount', 6: 'businessName' }
  },
  {
    name: 'quotation_shared',
    category: 'UTILITY',
    purpose: 'Sending quotations',
    body:
      'Hi {{1}}, thank you for your enquiry. Quotation {{2}} dated {{3}} for Rs. {{4}} is ready for your review and is valid until {{5}}. Reply to this message to confirm the order or to request any changes.\n\nRegards,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'QTN-2026-0087', '01 Aug 2026', '45,000', '15 Aug 2026', SAMPLE_BUSINESS],
    mapping: { 1: 'customerName', 2: 'quotationNumber', 3: 'quotationDate', 4: 'totalAmount', 5: 'validUntil', 6: 'businessName' }
  }
];

/**
 * The components array Meta's create-template call takes. `businessName`
 * replaces the sample for the business-name variable, so the reviewer sees
 * the real business rather than a placeholder.
 */
function buildComponents(template, { businessName } = {}) {
  const varCount = new Set(template.body.match(/\{\{(\d+)\}\}/g) || []).size;
  if (varCount !== template.samples.length) {
    throw new Error(
      `${template.name}: body has ${varCount} variables but ${template.samples.length} samples were supplied`
    );
  }

  const samples = template.samples.map((sample, i) =>
    businessName && template.mapping[i + 1] === 'businessName' ? businessName : sample
  );

  const components = [
    {
      type: 'BODY',
      text: template.body,
      ...(varCount > 0 ? { example: { body_text: [samples] } } : {})
    }
  ];

  if (template.footer) {
    components.push({ type: 'FOOTER', text: template.footer });
  }

  return components;
}

module.exports = { LANGUAGE, STARTER_TEMPLATES, buildComponents };
