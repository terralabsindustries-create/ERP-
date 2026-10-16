const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Job = require('../models/Job');
const HsnCode = require('../models/HsnCode');
const Settings = require('../models/Settings');
const { settingsOwnerId, businessSettings } = require('../utils/businessSettings');
const ActivityLog = require('../models/ActivityLog');
const PDFService = require('../services/PDFService');
const InventoryService = require('../services/InventoryService');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const { round2, parseDesignCharge, documentTotals, toInvoiceLine } = require('../utils/billing');

// Invoices are issued without GST. Bills marked "No GST" before that stay
// visible only to logins granted "Invoicing (View No GST)".
const noGstVisibility = (user) => (userCan(user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } });
const { staffScopeQuery } = require('../utils/dataScopeHelper');
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
  body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('Unit price cannot be negative'),
  body('items.*.unit').optional({ values: 'falsy' }).isIn(INVOICE_UNITS).withMessage('Invalid unit'),
  body('items.*.length').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Length cannot be negative'),
  body('items.*.width').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Width cannot be negative'),
  body('designCharge').optional({ values: 'falsy' }).custom((v) => parseDesignCharge(v) !== null).withMessage('Design charge must be an amount of 0 or more'),
  body('discountAmount').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Discount cannot be negative')
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
 * Lines, design charge and discount → the stored lines and the totals the
 * Invoice pre-save hook will arrive at. Returns { error } when the discount is
 * more than the invoice.
 */
function priceInvoice(items, designChargeInput, discountInput) {
  const lines = items.map(toInvoiceLine);
  const totals = documentTotals(lines.map((l) => l.totalAmount), parseDesignCharge(designChargeInput) || 0, discountInput);
  if (totals.discount > totals.gross) {
    return { error: `Discount (${totals.discount}) cannot be more than the invoice value (${totals.gross}).` };
  }
  return { lines, totals };
}

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
    
    res.status(200).json({
      status: 'success',
      data: {
        invoice
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

    // Every money figure is recomputed here from quantity, dimensions and unit
    // price. The client sends its own totals for display, but they are never
    // trusted, and no GST is charged whatever rate a line arrives with.
    const priced = priceInvoice(req.body.items, req.body.designCharge, req.body.discountAmount);
    if (priced.error) {
      return res.status(400).json({ status: 'error', message: priced.error });
    }
    const { lines, totals } = priced;

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

    const invoiceNumber = await Invoice.generateInvoiceNumber(req.user._id, req.user.dataScope);

    // Only these fields are taken from the request; everything else is derived.
    const invoiceData = {
      invoiceNumber,
      customerId: customer._id,
      customerName: customer.name,
      customerGstNumber: customer.gstNumber,
      customerAddress: customer.address,
      invoiceDate: req.body.invoiceDate || new Date(),
      dueDate: req.body.dueDate,
      items: lines,
      designCharge: totals.designCharge,
      discountAmount: totals.discount,
      subtotal: totals.subtotal,
      taxableAmount: totals.total,
      totalGstAmount: 0,
      totalAmount: totals.total,
      noGst: false,
      isInterState: false,
      paymentTerms: req.body.paymentTerms || undefined,
      notes: req.body.notes,
      // Older job dialogs send terms_conditions.
      termsAndConditions: req.body.termsAndConditions ?? req.body.terms_conditions,
      userId: req.user._id
    };
    if (req.body.status) invoiceData.status = req.body.status;

    // Job is optional — the client sends "" rather than omitting the field
    // when none is picked, which fails Mongoose's ObjectId cast on create.
    const jobId = idOf(req.body.jobId);
    if (jobId && mongoose.isValidObjectId(jobId)) invoiceData.jobId = jobId;
    if (req.body.jobTitle) invoiceData.jobTitle = req.body.jobTitle;

    // Add dataScope if available
    if (req.user.dataScope) {
      invoiceData.dataScope = req.user.dataScope;
    }
    const invoice = await Invoice.create(invoiceData);

    // Deduct inventory for all items
    try {
      const inventoryResult = await InventoryService.deductInventoryForInvoice(
        lines,
        invoice._id,
        invoiceNumber,
        req.user
      );

      if (!inventoryResult.success) {
        // If inventory deduction fails, we should ideally rollback the invoice
        // For now, we'll log the error and continue
        console.error('Inventory deduction failed:', inventoryResult.errors);
        
        // You might want to delete the invoice here or mark it as failed
        // await Invoice.findByIdAndDelete(invoice._id);
      }
    } catch (inventoryError) {
      console.error('Error during inventory deduction:', inventoryError);
      // Log the error but don't fail the invoice creation
      // In a production system, you might want to implement proper rollback
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
// Lines, design charge and discount are priced again on the server, exactly as
// on create; totals sent by the client are ignored. An invoice issued with GST
// is re-priced without it once its lines are saved through here.
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

    const pricingChanged = req.body.items !== undefined || req.body.designCharge !== undefined || req.body.discountAmount !== undefined;
    if (pricingChanged) {
      const items = req.body.items !== undefined ? req.body.items : invoice.items.map((i) => i.toObject());
      const designCharge = req.body.designCharge !== undefined ? req.body.designCharge : invoice.designCharge;
      const discount = req.body.discountAmount !== undefined ? req.body.discountAmount : invoice.discountAmount;
      const priced = priceInvoice(items, designCharge, discount);
      if (priced.error) {
        return res.status(400).json({ status: 'error', message: priced.error });
      }
      if (priced.totals.total + 0.001 < (invoice.paidAmount || 0)) {
        return res.status(400).json({
          status: 'error',
          message: `The new total (₹${priced.totals.total}) is less than the ₹${invoice.paidAmount} already paid on this invoice.`
        });
      }
      invoice.items = priced.lines;
      invoice.designCharge = priced.totals.designCharge;
      invoice.discountAmount = priced.totals.discount;
      // Lines saved here carry no GST. Clearing the header figures too means an
      // invoice issued with GST re-totals without it (the pre-save hook rolls
      // tax up from the lines, which now have none).
      invoice.isInterState = false;
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
    if (req.body.invoiceDate) invoice.invoiceDate = req.body.invoiceDate;
    if (req.body.dueDate) invoice.dueDate = req.body.dueDate;
    for (const field of ['notes', 'termsAndConditions', 'paymentTerms']) {
      if (req.body[field] !== undefined) invoice[field] = req.body[field];
    }

    // A changed total moves the payment state with it: a partly paid invoice
    // whose total came down to what was paid is now settled, and a settled one
    // whose total went up is partly paid again.
    if (pricingChanged && (invoice.paidAmount || 0) > 0) {
      const total = documentTotals(invoice.items.map((i) => i.totalAmount), invoice.designCharge, invoice.discountAmount).total;
      const settled = invoice.paidAmount + 0.001 >= total;
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
    const { paymentStatus, amountPaid } = req.body;

    const query = { _id: req.params.id, ...staffScopeQuery(req.user) };

    const invoice = await Invoice.findOne(query);

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'Invoice not found'
      });
    }

    console.log('💰 Payment status update:', { paymentStatus, amountPaid, currentPaidAmount: invoice.paidAmount });

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

      invoice.paidAmount = amountPaid;
      invoice.balanceAmount = invoice.totalAmount - amountPaid;
      console.log('💰 Updated amounts:', { paidAmount: invoice.paidAmount, balanceAmount: invoice.balanceAmount });
    }

    // Update payment status
    invoice.paymentStatus = paymentStatus;

    // Auto-update invoice status based on payment status
    if (paymentStatus === 'paid') {
      invoice.status = 'paid';
    } else if (paymentStatus === 'partial') {
      if (invoice.status !== 'paid') {
        invoice.status = 'sent';
      }
    }

    await invoice.save();
    console.log('✅ Invoice saved successfully');

    ActivityLog.logActivity({
      action: 'Invoice Payment Status Updated',
      description: `Invoice ${invoice.invoiceNumber} payment status was changed to ${paymentStatus}`,
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
