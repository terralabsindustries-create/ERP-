const express = require('express');
const mongoose = require('mongoose');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { validationResult } = require('express-validator');
const Quotation = require('../models/Quotation');
const Customer = require('../models/Customer');
const Settings = require('../models/Settings');
const { settingsOwnerId, businessSettings } = require('../utils/businessSettings');
const PDFService = require('../services/PDFService');
const { AREA_UNITS, HSN_PATTERN, round2, parseDesignCharge, parseGstRate, priceQuotationDocument, priceInvoiceDocument, quotationLineToInvoiceLine, sizeLabel, areaLabel } = require('../utils/billing');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');

async function getCompanyInfo(user) {
  const settings = await businessSettings(user);
  const addressParts = [];
  if (settings.companyAddress) {
    if (settings.companyAddress.street) addressParts.push(settings.companyAddress.street);
    if (settings.companyAddress.city) addressParts.push(settings.companyAddress.city);
    if (settings.companyAddress.state) addressParts.push(settings.companyAddress.state);
    if (settings.companyAddress.zipCode) addressParts.push(settings.companyAddress.zipCode);
  }

  // Multi-line address block for header (SynX style)
  const addr = settings.companyAddress || {};
  const addressLines = [];
  if (addr.street) addressLines.push(addr.street);
  if (addr.city) addressLines.push(addr.city + (addr.zipCode ? ' - ' + addr.zipCode : ''));
  else if (addr.zipCode) addressLines.push(addr.zipCode);
  const stateCountry = [addr.state, addr.country].filter(Boolean).join(', ').toUpperCase();
  if (stateCountry) addressLines.push(stateCountry);

  return {
    name: settings.companyName || '',
    address: addressParts.join(', '),
    addressLines,
    logo: settings.companyLogo || '',
    currency: settings.currency || 'INR',
    phone: settings.companyPhone || '',
    email: settings.companyEmail || '',
    gstNumber: settings.gstNumber || '',
    stateName: settings.companyAddress?.state || '',
    country: settings.companyAddress?.country || '',
    paymentQRCode: settings.paymentQRCode || '',
    bankName: settings.bankName || '',
    accountNumber: settings.accountNumber || '',
    accountName: settings.companyName || '',
    ifscCode: settings.ifscCode || '',
    branchName: settings.branchName || '',
    upiId: settings.upiId || ''
  };
}

const { createTransporter, getFromAddress, sendMailErrorResponse } = require('../utils/mailer');
const { sendWhatsAppMessage, buildTemplateVariables } = require('../utils/metaWhatsApp');

const router = express.Router();

const quotationValidation = [
  body('customer_id').notEmpty().withMessage('Customer is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.item_name').notEmpty().withMessage('Item name is required'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ gt: 0 }).withMessage('Every line needs a rate above 0'),
  body('items.*.hsn_code').optional({ values: 'falsy' }).trim().matches(HSN_PATTERN).withMessage('HSN codes are 4 to 8 digits'),
  body('items.*.unit').optional({ values: 'falsy' }).isIn(Quotation.schema.path('items').schema.path('unit').enumValues).withMessage('Invalid unit'),
  body('items.*.length').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Length cannot be negative'),
  body('items.*.width').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Width cannot be negative'),
  body('items.*.tax_rate').optional({ values: 'null' }).custom((v) => parseGstRate(v) !== null).withMessage('GST rate must be from 0 to 100%'),
  body('design_charge').optional({ values: 'falsy' }).custom((v) => parseDesignCharge(v) !== null).withMessage('Design charge must be an amount of 0 or more'),
  body('design_charge_tax_rate').optional({ values: 'null' }).custom((v) => parseGstRate(v) !== null).withMessage('The design charge GST rate must be from 0 to 100%'),
  body('discount_amount').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Discount cannot be negative'),
  body('is_interstate').optional({ values: 'null' }).isBoolean().withMessage('is_interstate must be true or false')
];

// A quotation can be changed while it is being worked on: a draft, or one sent
// and awaiting a reply. Approved, rejected, expired and closed ones are
// reopened as a draft first (an explicit status change); one turned into an
// invoice is never changed, the invoice is.
const EDITABLE_STATUSES = ['draft', 'sent'];
const notEditableMessage = (q) =>
  q.status === 'converted'
    ? `${q.quotationNumber} was turned into invoice ${q.convertedInvoiceNumber || ''}`.trim() + ', so it can no longer be changed. Edit the invoice instead.'
    : `${q.quotationNumber} is ${q.status}. Reopen it as a draft to change it.`;

/** The priced fields of a quotation, from what the client sent. */
const pricedQuotation = (body) => {
  const isInterstate = body.is_interstate === true;
  const priced = priceQuotationDocument({
    items: body.items,
    designCharge: body.design_charge,
    designChargeGstRate: body.design_charge_tax_rate,
    discount: body.discount_amount,
    isInterState: isInterstate
  });
  if (priced.error) return priced;
  const { lines, totals } = priced;
  return {
    fields: {
      gst_type: totals.gst > 0 ? 'gst' : 'non_gst',
      is_interstate: isInterstate,
      items: lines,
      subtotal: totals.subtotal,
      design_charge: totals.designCharge,
      design_charge_tax_rate: totals.design.gstRate,
      design_charge_tax_amount: totals.design.gstAmount,
      discount_amount: totals.discount,
      cgst_amount: totals.cgst,
      sgst_amount: totals.sgst,
      igst_amount: totals.igst,
      tax_amount: totals.gst,
      total_amount: totals.total
    }
  };
};

// GET /api/quotations
router.get('/', protect, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;

    const filter = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { userId: req.user._id };

    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { quotationNumber: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const quotations = await Quotation.find(filter)
      .populate('customer_id', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    const total = await Quotation.countDocuments(filter);

    res.json({
      status: 'success',
      data: { quotations, total, page: Number(page), limit: Number(limit) }
    });
  } catch (err) {
    console.error('GET /quotations error:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// GET /api/quotations/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOne(filter).populate('customer_id', 'name email phone');
    if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    res.json({ status: 'success', data: { quotation } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// POST /api/quotations
router.post('/', protect, requirePermission('Quotations: Create & Edit'), quotationValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
  }

  try {
    const { customer_id, valid_until, items, payment_link, terms_conditions, notes } = req.body;

    // Verify customer belongs to this user/scope
    const customerFilter = req.user.dataScope
      ? { _id: customer_id, dataScope: req.user.dataScope }
      : { _id: customer_id, userId: req.user._id };
    const customer = await Customer.findOne(customerFilter);
    if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });

    // Priced on the server with the same arithmetic as invoices (area lines
    // are length × width × quantity × rate; the discount comes off before tax;
    // GST at each line's rate and the design charge's own). Client totals are
    // ignored.
    const priced = pricedQuotation({ ...req.body, items });
    if (priced.error) return res.status(400).json({ status: 'error', message: priced.error });

    const quotationNumber = await Quotation.generateQuotationNumber(req.user._id, req.user.dataScope);

    const quotation = await Quotation.create({
      quotationNumber,
      customer_id,
      ...priced.fields,
      valid_until: valid_until || null,
      payment_link: payment_link || null,
      terms_conditions,
      notes,
      status: 'draft',
      userId: req.user._id,
      dataScope: req.user.dataScope || null
    });

    await quotation.populate('customer_id', 'name email phone');

    res.status(201).json({ status: 'success', data: { quotation } });
  } catch (err) {
    console.error('POST /quotations error:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// PUT /api/quotations/:id
// Change a draft or sent quotation: its customer, lines (add, remove, change),
// design charge, discount, GST and terms. The whole quotation is sent, as on
// create, and priced again here; its number and status stay as they are.
router.put('/:id', protect, requirePermission('Quotations: Create & Edit'), quotationValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
  }

  try {
    const scope = req.user.dataScope ? { dataScope: req.user.dataScope } : { userId: req.user._id };
    const existing = mongoose.isValidObjectId(req.params.id) ? await Quotation.findOne({ _id: req.params.id, ...scope }) : null;
    if (!existing) return res.status(404).json({ status: 'error', message: 'Quotation not found' });
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      return res.status(409).json({ status: 'error', code: 'QUOTATION_LOCKED', message: notEditableMessage(existing) });
    }

    const customer = mongoose.isValidObjectId(req.body.customer_id)
      ? await Customer.findOne({ _id: req.body.customer_id, ...scope })
      : null;
    if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });

    const priced = pricedQuotation(req.body);
    if (priced.error) return res.status(400).json({ status: 'error', message: priced.error });

    const { valid_until, payment_link, terms_conditions, notes } = req.body;
    // Only while it is still editable: a conversion that lands in the
    // meantime must not be overwritten.
    const quotation = await Quotation.findOneAndUpdate(
      { _id: existing._id, status: { $in: EDITABLE_STATUSES } },
      {
        $set: {
          customer_id: customer._id,
          ...priced.fields,
          valid_until: valid_until || null,
          payment_link: payment_link || null,
          terms_conditions,
          notes
        }
      },
      { new: true, runValidators: true }
    ).populate('customer_id', 'name email phone');
    if (!quotation) {
      const now = await Quotation.findById(existing._id);
      return res.status(409).json({ status: 'error', code: 'QUOTATION_LOCKED', message: notEditableMessage(now || existing) });
    }

    res.json({ status: 'success', message: `${quotation.quotationNumber} updated`, data: { quotation } });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ status: 'error', message: err.message });
    console.error('PUT /quotations/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// PATCH /api/quotations/:id/status
const QUOTATION_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'expired', 'converted', 'closed'];

router.patch('/:id/status', protect, requirePermission('Quotations: Change Status'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!QUOTATION_STATUSES.includes(status)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid status. Must be one of: ${QUOTATION_STATUSES.join(', ')}`
      });
    }

    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const existing = await Quotation.findOne(filter);
    if (!existing) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    // 'converted' is owned by the conversion endpoint — it must always point at
    // a real invoice, so it can neither be set nor cleared by hand.
    if (status === 'converted') {
      return res.status(400).json({
        status: 'error',
        message: 'Use the convert-to-invoice action to mark a quotation as converted'
      });
    }
    if (existing.status === 'converted') {
      return res.status(409).json({
        status: 'error',
        message: `This quotation was already converted to invoice ${existing.convertedInvoiceNumber}. Its status can no longer be changed.`
      });
    }

    const quotation = await Quotation.findOneAndUpdate(filter, { status }, { new: true })
      .populate('customer_id', 'name email phone');

    res.json({ status: 'success', data: { quotation } });
  } catch (err) {
    console.error('Update quotation status error:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// POST /api/quotations/:id/convert-to-invoice
// Raises an invoice from an accepted quotation. The quotation itself is left
// intact as a record and marked 'converted' so it can't be billed twice.
router.post('/:id/convert-to-invoice', protect, requirePermission('Quotations: Convert to Invoice'), async (req, res) => {
  try {
    const Invoice = require('../models/Invoice');

    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOne(filter).populate('customer_id');
    if (!quotation) {
      return res.status(404).json({ status: 'error', message: 'Quotation not found' });
    }

    if (quotation.status === 'converted') {
      return res.status(409).json({
        status: 'error',
        message: `Already converted to invoice ${quotation.convertedInvoiceNumber}`,
        data: { invoiceId: quotation.convertedInvoiceId, invoiceNumber: quotation.convertedInvoiceNumber }
      });
    }
    if (['rejected', 'expired', 'closed'].includes(quotation.status)) {
      return res.status(400).json({
        status: 'error',
        message: `A ${quotation.status} quotation cannot be converted to an invoice`
      });
    }
    if (!quotation.items || quotation.items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Quotation has no items to invoice' });
    }

    const customer = quotation.customer_id;
    if (!customer) {
      return res.status(400).json({ status: 'error', message: 'The customer on this quotation no longer exists' });
    }

    // The lines, the design charge and their GST rates carry over as they were
    // quoted, so the invoice comes to the quoted total.
    const isInterState = quotation.is_interstate === true;
    const { lines: items, totals, design } = priceInvoiceDocument({
      items: quotation.items.map((q) => quotationLineToInvoiceLine(q)),
      designCharge: quotation.design_charge || 0,
      designChargeGstRate: quotation.design_charge_tax_rate || 0,
      discount: quotation.discount_amount || 0,
      isInterState
    });
    const invoiceDate = new Date();
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + 30);

    const invoiceNumber = await Invoice.generateInvoiceNumber(req.user._id, req.user.dataScope);

    const invoiceData = {
      invoiceNumber,
      customerId: customer._id,
      customerName: customer.name,
      customerGstNumber: customer.gstNumber || '',
      customerAddress: customer.address || '',
      invoiceDate,
      dueDate,
      items,
      subtotal: totals.subtotal,
      ...design,
      discountAmount: totals.discount,
      // The pre-save hook recomputes these from the lines and design charge.
      taxableAmount: totals.taxableAmount,
      totalGstAmount: totals.gst,
      totalAmount: totals.total,
      status: 'draft',
      isInterState,
      noGst: false,
      notes: quotation.notes || '',
      termsAndConditions: quotation.terms_conditions || '',
      userId: req.user._id
    };
    if (req.user.dataScope) invoiceData.dataScope = req.user.dataScope;

    const invoice = await Invoice.create(invoiceData);

    quotation.status = 'converted';
    quotation.convertedInvoiceId = invoice._id;
    quotation.convertedInvoiceNumber = invoice.invoiceNumber;
    quotation.convertedAt = new Date();
    await quotation.save();

    res.status(201).json({
      status: 'success',
      message: `Quotation ${quotation.quotationNumber} converted to invoice ${invoice.invoiceNumber}`,
      data: { invoice, quotation }
    });
  } catch (err) {
    console.error('Convert quotation to invoice error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Server error while converting quotation to invoice',
      error: err.message
    });
  }
});

// POST /api/quotations/:id/send-email
router.post('/:id/send-email', protect, requirePermission('Quotations: Send Email'), async (req, res) => {
  try {
    const { recipientEmail, message } = req.body;

    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOne(filter).populate('customer_id', 'name email phone address gstNumber');
    if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    const toEmail = recipientEmail || quotation.customer_id?.email;
    if (!toEmail) return res.status(400).json({ status: 'error', message: 'Recipient email is required' });

    // Generate the exact same PDF as the download endpoint, to attach to the email
    const companyInfo = await getCompanyInfo(req.user);
    let pdfBuffer = null;
    try {
      pdfBuffer = await PDFService.generateQuotationPDFFromHTML(quotation, companyInfo);
    } catch (pdfErr) {
      console.warn('⚠️ Quotation PDF generation for email failed:', pdfErr.message);
    }

    const companyName = process.env.COMPANY_NAME || 'Carbon';
    const validUntil = quotation.valid_until
      ? new Date(quotation.valid_until).toLocaleDateString('en-IN') : 'N/A';

    // GST on the lines and the design charge (total_amount includes it).
    const tax = round2(quotation.tax_amount || 0);

    const itemsRows = quotation.items.map(item => {
      const size = sizeLabel(item);
      const sizeText = size ? `${size} (${areaLabel(item.area_per_piece, item.unit)} each, ${areaLabel(item.total_area, item.unit)} in all)` : '';
      // A line keeps its tax inside total_amount; show the line before tax.
      const lineAmount = round2((item.total_amount || 0) - (item.tax_amount || 0));
      return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${item.item_name}${sizeText ? `<div style="color:#666;font-size:12px;">${sizeText}</div>` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${item.description || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${size ? PDFService.fmtQty(item.quantity) : PDFService.formatQtyWithUnit(item.quantity, item.unit)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">&#8377;${item.unit_price.toFixed(2)}${size ? ` / ${AREA_UNITS[item.unit].label}` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">&#8377;${lineAmount.toFixed(2)}</td>
      </tr>`;
    }).join('');

    const paymentSection = quotation.payment_link ? `
      <div style="margin:20px 0;padding:16px;background:#f0f7ff;border-radius:8px;border-left:4px solid #3399cc;">
        <h3 style="margin:0 0 8px 0;color:#333;">Payment Link</h3>
        <a href="${quotation.payment_link}" style="color:#3399cc;word-break:break-all;">${quotation.payment_link}</a>
      </div>` : '';

    const customMessage = message
      ? `<p style="margin:16px 0;padding:12px;background:#fafafa;border-left:3px solid #ddd;">${message}</p>` : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Quotation ${quotation.quotationNumber}</title></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;margin:0;padding:0;">
<div style="max-width:700px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px;text-align:center;color:white;">
    <h1 style="margin:0;">${companyName}</h1>
    <p style="margin:8px 0 0 0;opacity:.9;">Quotation</p>
  </div>
  <div style="padding:30px;background:#f9f9f9;">
    <table style="width:100%;margin-bottom:20px;"><tr>
      <td><p style="margin:0;color:#666;font-size:13px;">QUOTATION FOR</p>
          <h2 style="margin:4px 0;font-size:18px;">${quotation.customer_id?.name || 'Customer'}</h2></td>
      <td style="text-align:right;"><p style="margin:0;color:#666;font-size:13px;">QUOTATION NUMBER</p>
          <h2 style="margin:4px 0;font-size:18px;font-family:monospace;">${quotation.quotationNumber}</h2>
          <p style="margin:4px 0;color:#666;font-size:13px;">Valid Until: ${validUntil}</p></td>
    </tr></table>
    ${customMessage}
    <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;">
      <thead><tr>
        <th style="padding:10px 8px;background:#f5f5f5;text-align:left;">Item</th>
        <th style="padding:10px 8px;background:#f5f5f5;text-align:left;">Description</th>
        <th style="padding:10px 8px;background:#f5f5f5;text-align:center;">Qty</th>
        <th style="padding:10px 8px;background:#f5f5f5;text-align:right;">Rate</th>
        <th style="padding:10px 8px;background:#f5f5f5;text-align:right;">Amount</th>
      </tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
    <div style="margin-top:16px;text-align:right;">
      <p style="margin:4px 0;">Subtotal: <strong>&#8377;${(quotation.subtotal || 0).toFixed(2)}</strong></p>
      ${quotation.design_charge > 0 ? `<p style="margin:4px 0;">Design Charge: <strong>&#8377;${quotation.design_charge.toFixed(2)}</strong></p>` : ''}
      ${quotation.discount_amount > 0 ? `<p style="margin:4px 0;">Discount: <strong>- &#8377;${quotation.discount_amount.toFixed(2)}</strong></p>` : ''}
      ${tax > 0 ? `<p style="margin:4px 0;">GST${quotation.is_interstate ? ' (IGST)' : ' (CGST + SGST)'}: <strong>&#8377;${tax.toFixed(2)}</strong></p>` : ''}
      <p style="margin:8px 0;font-size:18px;">Total: <strong style="color:#667eea;">&#8377;${quotation.total_amount.toFixed(2)}</strong></p>
    </div>
    ${paymentSection}
    ${quotation.terms_conditions ? `<div style="margin-top:20px;"><h4 style="margin:0 0 8px 0;">Terms &amp; Conditions</h4><p style="margin:0;color:#555;font-size:13px;">${quotation.terms_conditions}</p></div>` : ''}
    ${quotation.notes ? `<div style="margin-top:16px;"><h4 style="margin:0 0 8px 0;">Notes</h4><p style="margin:0;color:#555;font-size:13px;">${quotation.notes}</p></div>` : ''}
  </div>
  <div style="text-align:center;padding:20px;color:#666;font-size:12px;background:#f0f0f0;">
    <p style="margin:0;">&copy; 2026 ${companyName}. All rights reserved.</p>
  </div>
</div>
</body></html>`;

    const transporter = createTransporter();
    await transporter.sendMail({
      from: getFromAddress(companyName),
      to: toEmail,
      subject: `Quotation ${quotation.quotationNumber} from ${companyName}`,
      html,
      attachments: pdfBuffer
        ? [{ filename: `Quotation_${quotation.quotationNumber}.pdf`, content: pdfBuffer }]
        : []
    });

    await Quotation.findOneAndUpdate(filter, { status: 'sent' });

    res.json({ status: 'success', message: 'Quotation email sent successfully' });
  } catch (err) {
    console.error('POST /quotations/:id/send-email error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to send quotation email' });
  }
});

// POST /api/quotations/:id/send-whatsapp
router.post('/:id/send-whatsapp', protect, requirePermission('WhatsApp: Send Messages'), [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('metaTemplateName').notEmpty().withMessage('A WhatsApp template is required'),
  body('metaTemplateLanguage').optional({ nullable: true }).isString(),
  body('templateVariableMapping').optional({ nullable: true }).isObject()
], validate, async (req, res) => {
  try {
    const { phone, metaTemplateName, metaTemplateLanguage, templateVariableMapping } = req.body;

    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOne(filter).populate('customer_id', 'name email phone address gstNumber');
    if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    const settings = await businessSettings(req.user);
    const waIntegration = settings.whatsappIntegration;
    if (!waIntegration?.enabled || !waIntegration?.phoneNumberId || !waIntegration?.accessToken) {
      return res.status(400).json({
        status: 'error',
        message: 'WhatsApp Business API is not configured. Connect it in Settings > WhatsApp before sending quotations.',
        code: 'WHATSAPP_NOT_CONFIGURED'
      });
    }

    // Generate the PDF and save it to a temporary public URL so it can be offered as a linked variable
    const companyInfo = await getCompanyInfo(req.user);
    let quotationLink = '';
    try {
      const pdfBuffer = await PDFService.generateQuotationPDFFromHTML(quotation, companyInfo);
      const fs = require('fs');
      const path = require('path');
      const publicDir = path.join(__dirname, '../../public/temp');
      if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
      const fileName = `Quotation_${quotation.quotationNumber}_${Date.now()}.pdf`;
      const filePath = path.join(publicDir, fileName);
      fs.writeFileSync(filePath, pdfBuffer);
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      quotationLink = `${baseUrl}/temp/${fileName}`;
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Error deleting temporary PDF:', err);
        }
      }, 60 * 60 * 1000); // 1 hour
    } catch (pdfErr) {
      console.warn('⚠️ Quotation PDF generation for WhatsApp failed:', pdfErr.message);
    }

    const contextData = {
      customerName: quotation.customer_id?.name || '',
      quotationNumber: quotation.quotationNumber,
      totalAmount: quotation.total_amount.toLocaleString('en-IN'),
      validUntil: quotation.valid_until ? new Date(quotation.valid_until).toLocaleDateString('en-IN') : 'N/A',
      businessName: companyInfo.name || 'Our Company',
      quotationLink
    };

    const variablesArray = buildTemplateVariables(templateVariableMapping, contextData);

    const whatsappResult = await sendWhatsAppMessage(
      phone,
      `[Meta Template: ${metaTemplateName}]`,
      { templateName: metaTemplateName, languageCode: metaTemplateLanguage, variables: variablesArray },
      waIntegration,
      { invoiceNumber: quotation.quotationNumber }
    );

    if (!whatsappResult.success) {
      return res.status(400).json({
        status: 'error',
        message: whatsappResult.error || 'Failed to send quotation via WhatsApp'
      });
    }

    await Quotation.findOneAndUpdate(filter, { status: 'sent' });

    res.json({
      status: 'success',
      message: `Quotation ${quotation.quotationNumber} sent via WhatsApp`,
      data: {
        quotationNumber: quotation.quotationNumber,
        recipientPhone: phone,
        messageId: whatsappResult.messageId,
        sentAt: new Date()
      }
    });
  } catch (err) {
    console.error('POST /quotations/:id/send-whatsapp error:', err);
    res.status(500).json({ status: 'error', message: err.message || 'Failed to send quotation via WhatsApp' });
  }
});

// GET /api/quotations/:id/pdf
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOne(filter)
      .populate('customer_id', 'name email phone address gstNumber');
    if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    const companyInfo = await getCompanyInfo(req.user);
    if (!companyInfo.name || companyInfo.name === 'My Company') {
      return res.status(400).json({
        status: 'error',
        message: 'Company details not configured. Please update Settings before generating PDFs.',
        code: 'COMPANY_NOT_CONFIGURED'
      });
    }

    const pdfBuffer = await PDFService.generateQuotationPDFFromHTML(quotation, companyInfo);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quotation_${quotation.quotationNumber}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('GET /quotations/:id/pdf error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to generate PDF: ' + err.message });
  }
});

// DELETE /api/quotations/:id
router.delete('/:id', protect, requirePermission('Quotations: Delete'), async (req, res) => {
  try {
    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOneAndDelete(filter);
    if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    res.json({ status: 'success', message: 'Quotation deleted' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

module.exports = router;
