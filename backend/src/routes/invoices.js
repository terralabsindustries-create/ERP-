const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Customer = require('../models/Customer');
const Job = require('../models/Job');
const HsnCode = require('../models/HsnCode');
const Settings = require('../models/Settings');
const { settingsOwnerId, businessSettings } = require('../utils/businessSettings');
const ActivityLog = require('../models/ActivityLog');
const PDFService = require('../services/PDFService');
const InventoryService = require('../services/InventoryService');
const { createInvoiceWithStock } = require('../services/invoiceCreation');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const { parseDesignCharge, parseGstRate, priceInvoiceDocument, HSN_PATTERN } = require('../utils/billing');

// Bills marked "No GST" stay visible only to logins granted
// "Invoicing (View No GST)".
const noGstVisibility = (user) => (userCan(user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } });
const { staffScopeQuery } = require('../utils/dataScopeHelper');
const { orgScope } = require('../utils/accessScope');
const { sendWhatsAppMessage, buildTemplateVariables } = require('../utils/metaWhatsApp');

const router = express.Router();

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// The views of the invoice list. "Unpaid" and "overdue" only count issued
// invoices: a draft or a cancelled invoice is not owed.
const ISSUED = { status: { $nin: ['draft', 'cancelled'] } };
const INVOICE_VIEWS = {
  draft: () => ({ status: 'draft' }),
  unpaid: () => ({ ...ISSUED, paymentStatus: { $ne: 'paid' } }),
  overdue: () => ({ ...ISSUED, paymentStatus: { $ne: 'paid' }, dueDate: { $lt: startOfToday() } }),
  paid: () => ({ ...ISSUED, paymentStatus: 'paid' }),
  cancelled: () => ({ status: 'cancelled' })
};

// Helper function to get company info from settings with validation
async function getCompanyInfo(user) {
  const settings = await businessSettings(user);
  
  // Check if company name is configured
  if (!settings.companyName || settings.companyName === 'My Company') {
    return {
      isConfigured: false,
      error: 'Company details not configured. Please go to Settings > Company to add your company information before generating invoices.'
    };
  }
  
  // Format address
  const addressParts = [];
  if (settings.companyAddress) {
    if (settings.companyAddress.street) addressParts.push(settings.companyAddress.street);
    if (settings.companyAddress.city) addressParts.push(settings.companyAddress.city);
    if (settings.companyAddress.state) addressParts.push(settings.companyAddress.state);
    if (settings.companyAddress.zipCode) addressParts.push(settings.companyAddress.zipCode);
  }
  
  const formattedAddress = addressParts.length > 0 ? addressParts.join(', ') : '';

  // Multi-line address block for invoice/quotation header (SynX style)
  const addr = settings.companyAddress || {};
  const addressLines = [];
  if (addr.street) addressLines.push(addr.street);
  if (addr.city) addressLines.push(addr.city + (addr.zipCode ? ' - ' + addr.zipCode : ''));
  else if (addr.zipCode) addressLines.push(addr.zipCode);
  const stateCountry = [addr.state, addr.country].filter(Boolean).join(', ').toUpperCase();
  if (stateCountry) addressLines.push(stateCountry);

  return {
    isConfigured: true,
    name: settings.companyName,
    address: formattedAddress,
    addressLines,
    logo: settings.companyLogo || '',
    currency: settings.currency || 'INR',
    phone: settings.companyPhone || '',
    email: settings.companyEmail || '',
    gstNumber: settings.gstNumber || '',
    panNumber: settings.panNumber || '',
    stateName: settings.companyAddress?.state || '',
    country: settings.companyAddress?.country || '',
    paymentQRCode: settings.paymentQRCode || '',
    // Bank details
    bankName: settings.bankName || '',
    accountNumber: settings.accountNumber || '',
    accountName: settings.companyName || '',
    ifscCode: settings.ifscCode || '',
    branchName: settings.branchName || '',
    upiId: settings.upiId || ''
  };
}

// Validation rules. The line rules apply to create, and to an edit that sends lines.
const INVOICE_UNITS = Invoice.schema.path('items').schema.path('unit').enumValues;
const lineValidation = [
  body('items.*.itemName').trim().notEmpty().withMessage('Item name is required'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unitPrice').isFloat({ gt: 0 }).withMessage('Every line needs a rate above 0'),
  body('items.*.hsnCode').optional({ values: 'falsy' }).trim().matches(HSN_PATTERN).withMessage('HSN codes are 4 to 8 digits'),
  body('items.*.unit').optional({ values: 'falsy' }).isIn(INVOICE_UNITS).withMessage('Invalid unit'),
  body('items.*.length').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Length cannot be negative'),
  body('items.*.width').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Width cannot be negative'),
  body('items.*.gstRate').optional({ values: 'null' }).custom((v) => parseGstRate(v) !== null).withMessage('GST rate must be from 0 to 100%'),
  body('designCharge').optional({ values: 'falsy' }).custom((v) => parseDesignCharge(v) !== null).withMessage('Design charge must be an amount of 0 or more'),
  body('designCharge.gstRate').optional({ values: 'null' }).custom((v) => parseGstRate(v) !== null).withMessage('The design charge GST rate must be from 0 to 100%'),
  body('designChargeGstRate').optional({ values: 'null' }).custom((v) => parseGstRate(v) !== null).withMessage('The design charge GST rate must be from 0 to 100%'),
  body('discountAmount').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Discount cannot be negative'),
  body('isInterState').optional({ values: 'null' }).isBoolean().withMessage('isInterState must be true or false')
];
const invoiceValidation = [
  body('customerId').notEmpty().withMessage('Customer ID is required'),
  // Without a due date the invoice is due 30 days after its date (set in the handler).
  body('dueDate').optional({ values: 'falsy' }).isISO8601().withMessage('Due date must be a valid date'),
  body('status').optional({ values: 'falsy' }).isIn(['draft', 'sent']).withMessage('A new invoice is a draft or sent'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  ...lineValidation
];

/** A reference as the client may send it: an id, or the populated object. */
const idOf = (value) => (value && typeof value === 'object' ? value._id || value.id : value);

/**
 * Why a job ticket cannot be linked to an invoice for `customerId`, or null if
 * it can: it must be one of the business's job tickets, raised for that
 * customer. A job of another business reads as not found, exactly like one
 * that does not exist, so ids of other businesses reveal nothing.
 */
async function jobLinkProblem(user, jobId, customerId) {
  const job = mongoose.isValidObjectId(jobId)
    ? await Job.findOne({ _id: jobId, ...orgScope(user) }).select('customerId')
    : null;
  if (!job) return { status: 404, message: 'Job ticket not found' };
  if (String(job.customerId) !== String(customerId)) {
    return { status: 400, message: 'This job ticket is for a different customer. Choose the job ticket\'s customer, or another job ticket.' };
  }
  return null;
}

/**
 * Lines (with their GST rates), design charge and discount → the stored lines,
 * the design charge's tax and the totals the Invoice pre-save hook will arrive
 * at. See utils/billing.js priceInvoiceDocument.
 */
const priceInvoice = (input) => priceInvoiceDocument(input);

// A skipped invoice leaves a job ticket, not an invoice document. List those
// jobs on the Invoices page so they can be billed later without inventing an
// empty draft invoice. Any non-cancelled invoice in this business counts, even
// if another staff member created it or this login cannot view No GST bills.
router.get('/pending-jobs', protect, requirePermission('Invoicing: Create & Edit'), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const invoicedJobIds = await Invoice.distinct('jobId', {
      ...orgScope(req.user),
      jobId: { $ne: null },
      status: { $ne: 'cancelled' }
    });
    const filter = {
      ...orgScope(req.user),
      _id: { $nin: invoicedJobIds },
      status: { $ne: 'cancelled' }
    };
    const search = String(req.query.search || '').trim();
    if (search) filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const [jobs, totalJobs] = await Promise.all([
      Job.find(filter)
        .select('title status customerId items designCharge dueDate estimatedCost createdAt')
        .populate('customerId', 'name')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Job.countDocuments(filter)
    ]);
    res.json({ status: 'success', data: { jobs, pagination: { current: page, totalJobs } } });
  } catch (error) {
    console.error('Get jobs awaiting invoice error:', error);
    res.status(500).json({ status: 'error', message: 'Could not load jobs awaiting invoice' });
  }
});

// @route   GET /api/invoices
// @desc    Get all invoices for the authenticated user
// @access  Private
router.get('/', protect, [
  query('status').optional({ values: 'falsy' }).isIn(['all', 'draft', 'sent', 'paid', 'overdue', 'cancelled', 'refunded']),
  query('paymentStatus').optional({ values: 'falsy' }).custom(value => {
    const statuses = value.split(',');
    const valid = ['pending', 'partial', 'paid', 'overdue'];
    return statuses.every(s => valid.includes(s));
  }),
  query('search').optional({ values: 'falsy' }).trim(),
  query('jobId').optional({ values: 'falsy' }).isMongoId().withMessage('jobId must be a valid id'),
  query('customerId').optional({ values: 'falsy' }).isMongoId().withMessage('customerId must be a valid id'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  query('view').optional({ values: 'falsy' }).isIn(Object.keys(INVOICE_VIEWS))
], async (req, res) => {
  try {
    const {
      status,
      paymentStatus,
      search,
      jobId,
      page = 1,
      limit = 10,
      sortBy = 'invoiceDate',
      sortOrder = 'desc'
    } = req.query;

    // Build query - staff see only the invoices they created; the admin and
    // view-all logins see every invoice in the dataScope
    const queryConditions = [staffScopeQuery(req.user), noGstVisibility(req.user)];

    // Used to find a job's invoices, e.g. when opening one for editing from
    // the job list.
    // Nothing in this file calls validationResult(), so the id is checked here
    // rather than letting a bad one fail the query as a cast error.
    if (jobId && /^[0-9a-fA-F]{24}$/.test(jobId)) {
      queryConditions.push({ jobId });
    }

    // Used by Record Payment to list one customer's unpaid invoices.
    if (req.query.customerId && /^[0-9a-fA-F]{24}$/.test(req.query.customerId)) {
      queryConditions.push({ customerId: req.query.customerId });
    }

    if (status && status !== 'all') {
      queryConditions.push({ status: status });
    }

    if (req.query.view && INVOICE_VIEWS[req.query.view]) {
      queryConditions.push(INVOICE_VIEWS[req.query.view]());
    }

    if (paymentStatus && paymentStatus !== 'all') {
      const statuses = paymentStatus.split(',');
      if (statuses.length > 1) {
        queryConditions.push({ paymentStatus: { $in: statuses } });
      } else {
        queryConditions.push({ paymentStatus: paymentStatus });
      }
    }

    // Build final query
    let query = {};
    if (queryConditions.length === 1) {
      query = queryConditions[0];
    } else if (queryConditions.length > 1) {
      query = { $and: queryConditions };
    }

    // Add search filter with proper $and combination
    if (search) {
      const searchCondition = {
        $or: [
          { invoiceNumber: { $regex: search, $options: 'i' } },
          { customerName: { $regex: search, $options: 'i' } },
          { jobTitle: { $regex: search, $options: 'i' } }
        ]
      };

      if (Object.keys(query).length > 0) {
        // Combine existing query with search using $and
        query = { $and: [query, searchCondition] };
      } else {
        query = searchCondition;
      }
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    // Execute query
    const invoices = await Invoice.find(query)
      .populate('customerId', 'name email phone gstNumber')
      .populate('jobId', 'title status')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    // Get total count
    const totalInvoices = await Invoice.countDocuments(query);
    
    res.status(200).json({
      status: 'success',
      data: {
        invoices,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalInvoices / limit),
          count: invoices.length,
          totalInvoices
        }
      }
    });
    
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching invoices'
    });
  }
});

// @route   GET /api/invoices/:id
// @desc    Get single invoice
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const findQuery = { _id: req.params.id, ...staffScopeQuery(req.user), ...noGstVisibility(req.user) };

    const invoice = await Invoice.findOne(findQuery)
      .populate('customerId', 'name email phone gstNumber address')
      .populate('jobId', 'title status description');
    
    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    const paymentHistory = await Payment.find({ invoiceId: invoice._id })
      .select('paymentId paymentDate amount paymentMethod referenceNumber status')
      .sort({ paymentDate: -1, createdAt: -1 });
    
    res.status(200).json({
      status: 'success',
      data: {
        invoice,
        paymentHistory
      }
    });
    
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching invoice'
    });
  }
});

// @route   POST /api/invoices
// @desc    Create new invoice
// @access  Private
router.post('/', protect, requirePermission('Invoicing: Create & Edit'), invoiceValidation, validate, async (req, res) => {
  try {
    // Set default due date if not provided (30 days from invoice date)
    if (!req.body.dueDate || req.body.dueDate === '') {
      const defaultDueDate = req.body.invoiceDate ? new Date(req.body.invoiceDate) : new Date();
      defaultDueDate.setDate(defaultDueDate.getDate() + 30);
      req.body.dueDate = defaultDueDate.toISOString().split('T')[0];
    }

    // Every money figure is recomputed here from quantity, dimensions, unit
    // price and each line's GST rate. The client sends its own totals for
    // display, but they are never trusted. Line prices are before tax — a job
    // ticket's GST-inclusive item totals are never taken, so GST is added once.
    const isInterState = req.body.isInterState === true;
    const priced = priceInvoice({
      items: req.body.items,
      designCharge: req.body.designCharge,
      designChargeGstRate: req.body.designChargeGstRate,
      discount: req.body.discountAmount,
      isInterState
    });
    if (priced.error) {
      return res.status(400).json({ status: 'error', message: priced.error });
    }
    const { lines, totals, design } = priced;

    // Check stock for the priced lines (an area line needs its total area).
    const stockCheck = await InventoryService.checkStockAvailability(lines, req.user);
    if (!stockCheck.available) {
      return res.status(400).json({
        status: 'error',
        message: 'Insufficient stock for invoice items',
        details: stockCheck.errors,
        stockCheck: stockCheck.items
      });
    }

    // Build customer query with dataScope or userId
    const customerId = idOf(req.body.customerId);
    const customerQuery = req.user.dataScope
      ? { _id: customerId, dataScope: req.user.dataScope }
      : { _id: customerId, userId: req.user._id };

    const customer = await Customer.findOne(customerQuery);
    if (!customer) {
      return res.status(404).json({
        status: 'error',
        message: 'Customer not found'
      });
    }

    // A linked job ticket must be this business's, for this customer. The
    // client sends "" (or nothing) for no job.
    const jobId = idOf(req.body.jobId);
    if (jobId) {
      const problem = await jobLinkProblem(req.user, jobId, customer._id);
      if (problem) return res.status(problem.status).json({ status: 'error', message: problem.message });
    }

    // Only these fields are taken from the request; everything else is derived.
    // The invoice number is given when the invoice is written.
    const invoiceData = {
      customerId: customer._id,
      customerName: customer.name,
      customerGstNumber: customer.gstNumber,
      customerAddress: customer.address,
      invoiceDate: req.body.invoiceDate || new Date(),
      dueDate: req.body.dueDate,
      items: lines,
      ...design,
      discountAmount: totals.discount,
      subtotal: totals.subtotal,
      // The pre-save hook arrives at the same figures from the lines.
      taxableAmount: totals.taxableAmount,
      totalGstAmount: totals.gst,
      totalAmount: totals.total,
      noGst: false,
      isInterState,
      paymentTerms: req.body.paymentTerms || undefined,
      notes: req.body.notes,
      // Older job dialogs send terms_conditions.
      termsAndConditions: req.body.termsAndConditions ?? req.body.terms_conditions,
      userId: req.user._id
    };
    if (req.body.status) invoiceData.status = req.body.status;

    if (jobId) invoiceData.jobId = jobId;
    if (req.body.jobTitle) invoiceData.jobTitle = req.body.jobTitle;

    // Add dataScope if available
    if (req.user.dataScope) {
      invoiceData.dataScope = req.user.dataScope;
    }

    // The invoice and its stock deduction are written together: if the stock
    // has run out since the check above (another invoice took it), or any
    // write fails, no invoice is created and no stock is taken.
    let invoice;
    try {
      invoice = await createInvoiceWithStock(invoiceData, lines, req.user);
    } catch (error) {
      if (error instanceof InventoryService.InsufficientStockError) {
        const latest = await InventoryService.checkStockAvailability(lines, req.user);
        return res.status(400).json({
          status: 'error',
          message: 'Insufficient stock for invoice items',
          details: error.details,
          stockCheck: latest.items
        });
      }
      if (Invoice.isNumberTaken(error)) {
        return res.status(409).json({
          status: 'error',
          message: 'Several invoices were being numbered at the same moment and this one could not get a number. Please try again.'
        });
      }
      throw error;
    }

    // Populate the created invoice
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('customerId', 'name email phone gstNumber')
      .populate('jobId', 'title status');

    ActivityLog.logActivity({
      action: 'Invoice Created',
      description: `Invoice ${invoice.invoiceNumber} was created`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create invoice) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Invoice created successfully',
      data: {
        invoice: populatedInvoice
      }
    });

  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while creating invoice'
    });
  }
});

// @route   PUT /api/invoices/:id
// @desc    Update invoice
// @access  Private
// Lines, design charge, discount and GST are priced again on the server,
// exactly as on create; totals sent by the client are ignored.
router.put('/:id', protect, requirePermission('Invoicing: Create & Edit'), [
  body('items').optional().isArray({ min: 1 }).withMessage('At least one item is required'),
  body('invoiceDate').optional({ values: 'falsy' }).isISO8601().withMessage('Invoice date must be a valid date'),
  body('dueDate').optional({ values: 'falsy' }).isISO8601().withMessage('Due date must be a valid date'),
  ...lineValidation
], validate, async (req, res) => {
  try {
    // Check if invoice exists and belongs to user's dataScope
    const findQuery = { _id: req.params.id, ...staffScopeQuery(req.user) };

    const invoice = mongoose.isValidObjectId(req.params.id) ? await Invoice.findOne(findQuery) : null;

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    const pricingChanged = ['items', 'designCharge', 'designChargeGstRate', 'discountAmount', 'isInterState']
      .some((field) => req.body[field] !== undefined);
    let newTotal = null;
    if (pricingChanged) {
      // Whatever is not sent is kept: the stored lines keep their GST rates and
      // the design charge its own.
      const items = req.body.items !== undefined ? req.body.items : invoice.items.map((i) => i.toObject());
      const designCharge = req.body.designCharge !== undefined ? req.body.designCharge : invoice.designCharge;
      const designChargeGstRate = req.body.designChargeGstRate !== undefined
        ? req.body.designChargeGstRate
        : (req.body.designCharge && typeof req.body.designCharge === 'object' ? undefined : invoice.designChargeGstRate);
      const discount = req.body.discountAmount !== undefined ? req.body.discountAmount : invoice.discountAmount;
      const isInterState = req.body.isInterState !== undefined ? req.body.isInterState === true : invoice.isInterState === true;
      const priced = priceInvoice({ items, designCharge, designChargeGstRate, discount, isInterState, noGst: invoice.noGst === true });
      if (priced.error) {
        return res.status(400).json({ status: 'error', message: priced.error });
      }
      newTotal = invoice.noGst ? priced.totals.taxableAmount : priced.totals.total;
      if (newTotal + 0.001 < (invoice.paidAmount || 0)) {
        return res.status(400).json({
          status: 'error',
          message: `The new total (₹${newTotal}) is less than the ₹${invoice.paidAmount} already paid on this invoice.`
        });
      }
      invoice.items = priced.lines;
      invoice.set(priced.design);
      invoice.discountAmount = priced.totals.discount;
      invoice.isInterState = isInterState;
    }

    const customerId = idOf(req.body.customerId);
    if (customerId && String(customerId) !== String(invoice.customerId)) {
      const customer = mongoose.isValidObjectId(customerId)
        ? await Customer.findOne(req.user.dataScope ? { _id: customerId, dataScope: req.user.dataScope } : { _id: customerId, userId: req.user._id })
        : null;
      if (!customer) {
        return res.status(404).json({ status: 'error', message: 'Customer not found' });
      }
      invoice.customerId = customer._id;
      invoice.customerName = customer.name;
      invoice.customerGstNumber = customer.gstNumber;
      invoice.customerAddress = customer.address;
    }

    if (req.body.jobId !== undefined) {
      const jobId = idOf(req.body.jobId);
      // "" or "no-job" unsets the optional job reference.
      invoice.jobId = jobId && mongoose.isValidObjectId(jobId) ? jobId : null;
    }
    // A job ticket newly linked, or kept while the customer changes, must be
    // this business's and the invoice's customer's. An older invoice saved
    // with another link is left alone while neither changes.
    if (invoice.jobId && (invoice.isModified('jobId') || invoice.isModified('customerId'))) {
      const problem = await jobLinkProblem(req.user, invoice.jobId, invoice.customerId);
      if (problem) return res.status(problem.status).json({ status: 'error', message: problem.message });
    }
    if (req.body.invoiceDate) invoice.invoiceDate = req.body.invoiceDate;
    if (req.body.dueDate) invoice.dueDate = req.body.dueDate;
    for (const field of ['notes', 'termsAndConditions', 'paymentTerms']) {
      if (req.body[field] !== undefined) invoice[field] = req.body[field];
    }

    // A changed total moves the payment state with it: a partly paid invoice
    // whose total came down to what was paid is now settled, and a settled one
    // whose total went up is partly paid again.
    if (pricingChanged && (invoice.paidAmount || 0) > 0) {
      const settled = invoice.paidAmount + 0.001 >= newTotal;
      invoice.paymentStatus = settled ? 'paid' : 'partial';
      if (settled && invoice.status !== 'cancelled') invoice.status = 'paid';
      else if (!settled && invoice.status === 'paid') invoice.status = 'sent';
    }

    await invoice.save();
    await invoice.populate([
      { path: 'customerId', select: 'name email phone gstNumber' },
      { path: 'jobId', select: 'title status' }
    ]);

    ActivityLog.logActivity({
      action: 'Invoice Updated',
      description: `Invoice ${invoice.invoiceNumber} was updated`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update invoice) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Invoice updated successfully',
      data: {
        invoice
      }
    });

  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    console.error('Update invoice error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating invoice'
    });
  }
});

// @route   DELETE /api/invoices/:id
// @desc    Delete invoice (soft delete)
// @access  Private
router.delete('/:id', protect, requirePermission('Invoicing: Delete'), async (req, res) => {
  try {
    const findQuery = { _id: req.params.id, ...staffScopeQuery(req.user) };

    const invoice = await Invoice.findOne(findQuery);
    
    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }
    
    // Delete the invoice completely
    await Invoice.deleteOne({ _id: req.params.id });

    ActivityLog.logActivity({
      action: 'Invoice Deleted',
      description: `Invoice ${invoice.invoiceNumber} was deleted`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (delete invoice) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Invoice deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting invoice'
    });
  }
});

// @route   GET /api/invoices/stats/summary
// @desc    Get invoice statistics
// @access  Private
router.get('/stats/summary', protect, async (req, res) => {
  try {
    // No GST totals only for logins that may see No GST invoices.
    const stats = await Invoice.getInvoiceStats({ $and: [staffScopeQuery(req.user), noGstVisibility(req.user)] });
    
    res.status(200).json({
      status: 'success',
      data: {
        stats: stats[0] || {
          totalInvoices: 0,
          totalAmount: 0,
          paidAmount: 0,
          pendingAmount: 0,
          avgInvoiceValue: 0
        }
      }
    });
    
  } catch (error) {
    console.error('Get invoice stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching invoice statistics'
    });
  }
});

// @route   GET /api/invoices/stats/views
// @desc    Counts and amounts behind the invoice list's views
// @access  Private (Invoicing)
router.get('/stats/views', protect, async (req, res) => {
  try {
    const base = { $and: [staffScopeQuery(req.user), noGstVisibility(req.user)] };
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const today = startOfToday();
    const issued = { $not: { $in: ['$status', ['draft', 'cancelled']] } };
    const owed = { $and: [issued, { $ne: ['$paymentStatus', 'paid'] }] };
    const [row] = await Invoice.aggregate([
      { $match: base },
      {
        $group: {
          _id: null,
          all: { $sum: 1 },
          draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          paid: { $sum: { $cond: [{ $and: [issued, { $eq: ['$paymentStatus', 'paid'] }] }, 1, 0] } },
          unpaid: { $sum: { $cond: [owed, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [owed, { $lt: ['$dueDate', today] }] }, 1, 0] } },
          invoiced: { $sum: { $cond: [issued, '$totalAmount', 0] } },
          outstanding: { $sum: { $cond: [owed, { $ifNull: ['$balanceAmount', 0] }, 0] } },
          overdueAmount: { $sum: { $cond: [{ $and: [owed, { $lt: ['$dueDate', today] }] }, { $ifNull: ['$balanceAmount', 0] }, 0] } },
          collected: { $sum: { $cond: [issued, { $ifNull: ['$paidAmount', 0] }, 0] } },
          invoicedThisMonth: { $sum: { $cond: [{ $and: [issued, { $gte: ['$invoiceDate', monthStart] }] }, '$totalAmount', 0] } },
          countThisMonth: { $sum: { $cond: [{ $and: [issued, { $gte: ['$invoiceDate', monthStart] }] }, 1, 0] } }
        }
      }
    ]);
    const empty = { all: 0, draft: 0, cancelled: 0, paid: 0, unpaid: 0, overdue: 0, invoiced: 0, outstanding: 0, overdueAmount: 0, collected: 0, invoicedThisMonth: 0, countThisMonth: 0 };
    const { _id, ...stats } = row || {};
    res.json({ status: 'success', data: { stats: { ...empty, ...stats } } });
  } catch (error) {
    console.error('Invoice view stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching invoice statistics' });
  }
});

// @route   PATCH /api/invoices/:id/cancel
// @desc    Cancel invoice and restore inventory
// @access  Private
router.patch('/:id/cancel', protect, async (req, res) => {
  try {
    const findQuery = { _id: req.params.id, ...staffScopeQuery(req.user) };

    const invoice = await Invoice.findOne(findQuery);
    
    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }
    
    if (invoice.status === 'cancelled') {
      return res.status(400).json({
        status: 'error',
        message: 'Invoice is already cancelled'
      });
    }
    
    // Update invoice status
    invoice.status = 'cancelled';
    invoice.cancelledAt = new Date();
    invoice.cancellationReason = req.body.reason || 'Invoice cancelled';
    await invoice.save();

    ActivityLog.logActivity({
      action: 'Invoice Cancelled',
      description: `Invoice ${invoice.invoiceNumber} was cancelled`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'cancel',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (cancel invoice) failed:', err.message));

    // Restore inventory
    try {
      const restoreResult = await InventoryService.restoreInventoryForCancelledInvoice(
        invoice._id,
        req.user
      );
      
      res.status(200).json({
        status: 'success',
        message: 'Invoice cancelled and inventory restored successfully',
        data: {
          invoice,
          inventoryRestored: restoreResult.success
        }
      });
      
    } catch (inventoryError) {
      console.error('Error restoring inventory:', inventoryError);
      
      res.status(200).json({
        status: 'success',
        message: 'Invoice cancelled but inventory restoration failed',
        data: {
          invoice,
          inventoryRestored: false,
          warning: 'Please manually restore inventory items'
        }
      });
    }
    
  } catch (error) {
    console.error('Cancel invoice error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while cancelling invoice'
    });
  }
});

// @route   PATCH /api/invoices/:id/payment-status
// @desc    Update invoice payment status
// @access  Private
router.patch('/:id/payment-status', protect, requirePermission('Invoicing: Record Payment'), [
  body('paymentStatus').isIn(['pending', 'partial', 'paid', 'overdue']).withMessage('Invalid payment status'),
  body('amountPaid').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Amount paid must be greater than or equal to 0')
], validate, async (req, res) => {
  try {
    const { amountPaid } = req.body;

    const query = { _id: req.params.id, ...staffScopeQuery(req.user) };

    const invoice = await Invoice.findOne(query);

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    // Validate amount paid
    if (amountPaid !== undefined) {
      if (amountPaid < 0) {
        return res.status(400).json({
          status: 'error',
          message: 'Amount paid cannot be negative. Please enter a valid amount.',
          code: 'NEGATIVE_AMOUNT'
        });
      }

      if (amountPaid > invoice.totalAmount) {
        const excessAmount = amountPaid - invoice.totalAmount;
        return res.status(400).json({
          status: 'error',
          message: `Amount paid (₹${amountPaid.toLocaleString()}) exceeds invoice total (₹${invoice.totalAmount.toLocaleString()}) by ₹${excessAmount.toLocaleString()}. Please enter an amount less than or equal to ₹${invoice.totalAmount.toLocaleString()}.`,
          code: 'AMOUNT_EXCEEDS_TOTAL',
          details: {
            amountPaid,
            invoiceTotal: invoice.totalAmount,
            excessAmount
          }
        });
      }

      const allocated = await Payment.aggregate([
        { $match: { invoiceId: invoice._id, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      if (amountPaid + 0.001 < (allocated[0]?.total || 0)) {
        return res.status(400).json({ status: 'error', message: 'Amount paid cannot be less than payments already allocated to this invoice.' });
      }

      invoice.paidAmount = amountPaid;
    }

    // The amount is authoritative; a manual status must not contradict the balance.
    invoice.paymentStatus = invoice.paidAmount >= invoice.totalAmount ? 'paid' : invoice.paidAmount > 0 ? 'partial' : 'pending';

    // Auto-update invoice status based on payment status
    if (invoice.paymentStatus === 'paid') {
      invoice.status = 'paid';
    } else if (invoice.status === 'paid') {
      invoice.status = 'sent';
    }

    await invoice.save();

    ActivityLog.logActivity({
      action: 'Invoice Payment Status Updated',
      description: `Invoice ${invoice.invoiceNumber} payment status was changed to ${invoice.paymentStatus}`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (invoice payment status update) failed:', err.message));

    // Populate and return updated invoice
    const updatedInvoice = await Invoice.findById(req.params.id)
      .populate('customerId', 'name email phone gstNumber')
      .populate('jobId', 'title status');

    res.status(200).json({
      status: 'success',
      message: 'Invoice payment status updated successfully',
      data: {
        invoice: updatedInvoice
      }
    });

  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating payment status'
    });
  }
});

// @route   GET /api/invoices/:id/movements
// @desc    Get inventory movements for an invoice
// @access  Private
router.get('/:id/movements', protect, async (req, res) => {
  try {
    const invoice = mongoose.isValidObjectId(req.params.id)
      ? await Invoice.findOne({ _id: req.params.id, ...staffScopeQuery(req.user), ...noGstVisibility(req.user) })
      : null;
    
    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }
    
    const movements = await InventoryService.getMovementHistory(req.user, {
      referenceType: 'invoice',
      referenceId: req.params.id
    });
    
    res.status(200).json({
      status: 'success',
      data: {
        movements
      }
    });
    
  } catch (error) {
    console.error('Get invoice movements error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching invoice movements'
    });
  }
});

// @route   GET /api/invoices/:id/pdf
// @desc    Generate and download invoice PDF
// @access  Private
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const invoiceId = req.params.id;

    console.log('📄 PDF request for invoice:', invoiceId, 'by user:', userId);

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      ...staffScopeQuery(req.user)
    })
    .populate('customerId', 'name email phone address gstNumber')
    .populate('jobId', 'title');

    if (!invoice) {
      console.log('⚠️  Invoice not found:', invoiceId);
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    console.log('✅ Invoice found:', invoice.invoiceNumber);

    // Get company information from settings
    const companyInfoResult = await getCompanyInfo(req.user);
    
    if (!companyInfoResult.isConfigured) {
      return res.status(400).json({
        status: 'error',
        message: companyInfoResult.error,
        code: 'COMPANY_NOT_CONFIGURED'
      });
    }

    console.log('🔄 Generating PDF from HTML template...');
    const pdfBuffer = await PDFService.generateInvoicePDFFromHTML(invoice, companyInfoResult);

    if (!pdfBuffer || pdfBuffer.length === 0) {
      console.error('❌ PDF buffer is empty');
      return res.status(500).json({
        status: 'error',
        message: 'Failed to generate PDF - empty buffer'
      });
    }

    console.log('✅ PDF generated successfully, size:', pdfBuffer.length, 'bytes');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice_${invoice.invoiceNumber}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);

    console.log('✅ PDF sent to client for invoice:', invoice.invoiceNumber);

  } catch (error) {
    console.error('❌ PDF generation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate PDF: ' + error.message
    });
  }
});

// @route   POST /api/invoices/:id/send-email
// @desc    Send invoice via email
// @access  Private
router.post('/:id/send-email', protect, requirePermission('Invoicing: Send Email'), [
  body('email').isEmail().withMessage('Valid email is required'),
  body('message').optional({ values: 'falsy' }).isString().trim()
], validate, async (req, res) => {
  try {
    const invoiceId = req.params.id;
    const { email, message } = req.body;

    const query = { _id: invoiceId, ...staffScopeQuery(req.user) };

    const invoice = await Invoice.findOne(query)
      .populate('customerId', 'name email phone address gstNumber')
      .populate('jobId', 'title');

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    // Get company information from settings
    const companyInfoResult = await getCompanyInfo(req.user);
    
    if (!companyInfoResult.isConfigured) {
      return res.status(400).json({
        status: 'error',
        message: companyInfoResult.error,
        code: 'COMPANY_NOT_CONFIGURED'
      });
    }

    // Generate PDF using HTML template
    console.log('📧 Generating PDF for email...');
    const pdfBuffer = await PDFService.generateInvoicePDFFromHTML(invoice, companyInfoResult);

    // Send email with custom message
    console.log('📧 Preparing to send invoice email...');
    const invoiceName = `Invoice_${invoice.invoiceNumber}`;
    await PDFService.sendInvoiceEmail(pdfBuffer, email, invoiceName, message);

    ActivityLog.logActivity({
      action: 'Invoice Emailed',
      description: `Invoice ${invoice.invoiceNumber} was emailed to ${email}`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'send',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (send invoice email) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: `Invoice ${invoice.invoiceNumber} sent successfully to ${email}`,
      data: {
        invoiceNumber: invoice.invoiceNumber,
        recipientEmail: email,
        sentAt: new Date()
      }
    });

  } catch (error) {
    console.error('❌ Email sending error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to send invoice email'
    });
  }
});

// @route   POST /api/invoices/:id/send-whatsapp
// @desc    Send invoice via WhatsApp using the Meta WhatsApp Business Cloud API
// @access  Private
router.post('/:id/send-whatsapp', protect, requirePermission('WhatsApp: Send Messages'), [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('metaTemplateName').notEmpty().withMessage('A WhatsApp template is required'),
  body('metaTemplateLanguage').optional({ nullable: true }).isString(),
  body('templateVariableMapping').optional({ nullable: true }).isObject()
], validate, async (req, res) => {
  try {
    const invoiceId = req.params.id;
    const { phone, metaTemplateName, metaTemplateLanguage, templateVariableMapping } = req.body;

    const query = { _id: invoiceId, ...staffScopeQuery(req.user) };

    const invoice = await Invoice.findOne(query)
      .populate('customerId', 'name email phone address gstNumber')
      .populate('jobId', 'title');

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    // Get company information from settings
    const companyInfoResult = await getCompanyInfo(req.user);

    if (!companyInfoResult.isConfigured) {
      return res.status(400).json({
        status: 'error',
        message: companyInfoResult.error,
        code: 'COMPANY_NOT_CONFIGURED'
      });
    }

    const settings = await businessSettings(req.user);
    const waIntegration = settings.whatsappIntegration;

    if (!waIntegration?.enabled || !waIntegration?.phoneNumberId || !waIntegration?.accessToken) {
      return res.status(400).json({
        status: 'error',
        message: 'WhatsApp Business API is not configured. Connect it in Settings > WhatsApp before sending invoices.',
        code: 'WHATSAPP_NOT_CONFIGURED'
      });
    }

    // Generate PDF and save to a temporary public URL so it can be offered as a linked variable
    console.log('📱 Generating PDF for WhatsApp...');
    const pdfBuffer = await PDFService.generateInvoicePDFFromHTML(invoice, companyInfoResult);

    const fs = require('fs');
    const path = require('path');
    const publicDir = path.join(__dirname, '../../public/temp');

    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const fileName = `Invoice_${invoice.invoiceNumber}_${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, pdfBuffer);
    console.log('📱 PDF saved to:', filePath);

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const pdfUrl = `${baseUrl}/temp/${fileName}`;

    // Schedule file deletion after 1 hour
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('📱 Temporary PDF deleted:', fileName);
        }
      } catch (err) {
        console.error('Error deleting temporary PDF:', err);
      }
    }, 60 * 60 * 1000); // 1 hour

    const contextData = {
      customerName: invoice.customerId?.name || invoice.customerName || '',
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: invoice.totalAmount.toLocaleString('en-IN'),
      balanceDue: invoice.balanceDue.toLocaleString('en-IN'),
      dueDate: new Date(invoice.dueDate).toLocaleDateString('en-IN'),
      invoiceDate: new Date(invoice.invoiceDate).toLocaleDateString('en-IN'),
      businessName: companyInfoResult.name || 'Our Company',
      invoiceLink: pdfUrl
    };

    const variablesArray = buildTemplateVariables(templateVariableMapping, contextData);

    const whatsappResult = await sendWhatsAppMessage(
      phone,
      `[Meta Template: ${metaTemplateName}]`,
      { templateName: metaTemplateName, languageCode: metaTemplateLanguage, variables: variablesArray },
      waIntegration,
      { invoiceNumber: invoice.invoiceNumber }
    );

    if (!whatsappResult.success) {
      return res.status(400).json({
        status: 'error',
        message: whatsappResult.error || 'Failed to send invoice via WhatsApp'
      });
    }

    ActivityLog.logActivity({
      action: 'Invoice Sent via WhatsApp',
      description: `Invoice ${invoice.invoiceNumber} was sent via WhatsApp to ${phone}`,
      entityType: 'invoice',
      entityId: invoice._id,
      entityName: invoice.invoiceNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'send',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (send invoice whatsapp) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: `Invoice ${invoice.invoiceNumber} sent via WhatsApp`,
      data: {
        invoiceNumber: invoice.invoiceNumber,
        recipientPhone: phone,
        messageId: whatsappResult.messageId,
        sentAt: new Date()
      }
    });

  } catch (error) {
    console.error('❌ WhatsApp sending error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to send invoice via WhatsApp'
    });
  }
});

// @route   GET /api/invoices/:id/print-data
// @desc    Get invoice data formatted for printing
// @access  Private
router.get('/:id/print-data', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const invoiceId = req.params.id;

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      ...staffScopeQuery(req.user)
    })
    .populate('customerId', 'name email phone address gstNumber')
    .populate('jobId', 'title');

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    // Get company information from settings
    const companyInfoResult = await getCompanyInfo(req.user);
    
    if (!companyInfoResult.isConfigured) {
      return res.status(400).json({
        status: 'error',
        message: companyInfoResult.error,
        code: 'COMPANY_NOT_CONFIGURED'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        invoice,
        companyInfo: companyInfoResult
      }
    });

  } catch (error) {
    console.error('Print data error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get print data'
    });
  }
});

// @route   DELETE /api/invoices/clear-duplicate
// @desc    Clear duplicate invoice (temporary fix)
// @access  Private
router.delete('/clear-duplicate', protect, async (req, res) => {
  try {
    const result = await Invoice.deleteOne({ invoiceNumber: 'INV-202603-0001' });
    res.status(200).json({
      status: 'success',
      message: `Deleted ${result.deletedCount} duplicate invoice(s)`
    });
  } catch (error) {
    console.error('Clear duplicate error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while clearing duplicate'
    });
  }
});

module.exports = router;
// Exposed so other routes (e.g. payment reminders, for PDF attachments) can build the same
// company-info shape PDFService.generateInvoicePDFFromHTML expects, without duplicating it.
module.exports.getCompanyInfo = getCompanyInfo;
