const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { validate } = require('../middleware/validate');
const PurchaseBill = require('../models/PurchaseBill');
const PurchaseOrder = require('../models/PurchaseOrder');
const Inventory = require('../models/Inventory');
const Vendor = require('../models/Vendor');
const ActivityLog = require('../models/ActivityLog');
const InventoryService = require('../services/InventoryService');
const Settings = require('../models/Settings');
const { settingsOwnerId, businessSettings } = require('../utils/businessSettings');
const PDFService = require('../services/PDFService');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { orgUserFilter, purchaseOrderScope } = require('../utils/accessScope');
const { canViewAllStaffData } = require('../utils/dataScopeHelper');

// Bills, like invoices: everyone's in the business for the admin and logins
// that see all staff data, otherwise the ones this login recorded. Suppliers
// are shared by the whole business.
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const billScope = async (user) => (canViewAllStaffData(user) ? orgUserFilter(user) : { userId: user._id });

const router = express.Router();

/**
 * Create a bill with the business's next bill number. Two bills saved at the
 * same moment can draw the same number; the loser of that race tries again.
 */
async function createNumberedBill(user, data) {
  const businessId = await settingsOwnerId(user);
  const businessFilter = await orgUserFilter(user);
  for (let attempt = 0; ; attempt++) {
    try {
      const billNumber = await PurchaseBill.generateBillNumber(businessFilter, businessId);
      return await PurchaseBill.create({ ...data, billNumber, userId: user._id, businessId });
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.billNumber || attempt === 4) throw error;
    }
  }
}

// Purchase orders that have been placed (approved) and have no bill yet. A
// draft is not approved; a cancelled order is not owed.
const BILLABLE_PO_STATUSES = ['sent', 'acknowledged', 'partial', 'completed'];
const billableOrders = async (user, ids) => {
  // Older orders marked Ordered have a sent status but no approvedAt field.
  // A draft received straight into partial/completed must not count as approved.
  const filter = { $and: [await purchaseOrderScope(user), { status: { $in: BILLABLE_PO_STATUSES }, $or: [{ approvedAt: { $type: 'date' } }, { status: { $in: ['sent', 'acknowledged'] } }], purchaseBillId: { $exists: false } }] };
  if (ids) filter.$and.push({ _id: { $in: ids } });
  return PurchaseOrder.find(filter).sort({ createdAt: 1 });
};

/** "Net 30" → 30. Orders without a number in their terms fall due in 30 days. */
const termDays = (terms) => {
  const m = /(\d+)/.exec(terms || '');
  return m ? Math.min(Number(m[1]), 365) : 30;
};

/**
 * The bill for an approved purchase order: its supplier, and its lines at the
 * ordered quantity and unit cost, with the HSN code and GST rate of each
 * stock item (as a bill typed in by hand takes them).
 */
async function billFromOrder(user, po) {
  const vendor = await Vendor.findOne({ _id: po.vendorId, ...(await orgUserFilter(user)) });
  if (!vendor) return { error: `${po.poNumber}: its supplier no longer exists` };
  const stock = await Inventory.find({ _id: { $in: po.items.map((i) => i.inventoryId) }, ...InventoryService.itemScope(user) }).select('hsnCode gstRate');
  const byId = new Map(stock.map((s) => [String(s._id), s]));
  const items = po.items
    .filter((line) => line.quantity > 0 && line.unitCost > 0)
    .map((line) => {
      const s = byId.get(String(line.inventoryId));
      return { description: line.itemName, hsnCode: s?.hsnCode || '', rate: line.unitCost, quantity: line.quantity, gstRate: s?.gstRate || 0 };
    });
  if (!items.length) return { error: `${po.poNumber}: no line has a quantity and unit cost above 0` };

  const billDate = new Date();
  const dueDate = new Date(billDate);
  dueDate.setDate(dueDate.getDate() + termDays(po.terms));
  return {
    data: {
      vendorId: vendor._id,
      vendorName: vendor.name,
      vendorGstNumber: vendor.gstNumber || '',
      vendorAddress: vendor.fullAddress || '',
      vendorState: vendor.address?.state || '',
      billDate,
      dueDate,
      items,
      notes: `Generated from purchase order ${po.poNumber}`,
      purchaseOrderId: po._id,
      purchaseOrderNumber: po.poNumber
    }
  };
}

// Build company info block for the PDF header (mirrors invoices.js getCompanyInfo)
async function getCompanyInfo(user) {
  const settings = await businessSettings(user);

  if (!settings.companyName || settings.companyName === 'My Company') {
    return {
      isConfigured: false,
      error: 'Company details not configured. Please go to Settings > Company to add your company information before generating bills.'
    };
  }

  const addressParts = [];
  if (settings.companyAddress) {
    if (settings.companyAddress.street) addressParts.push(settings.companyAddress.street);
    if (settings.companyAddress.city) addressParts.push(settings.companyAddress.city);
    if (settings.companyAddress.state) addressParts.push(settings.companyAddress.state);
    if (settings.companyAddress.zipCode) addressParts.push(settings.companyAddress.zipCode);
  }

  const formattedAddress = addressParts.length > 0 ? addressParts.join(', ') : '';

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
    paymentQRCode: settings.paymentQRCode || ''
  };
}

// Validation rules
const billValidation = [
  body('vendorId').notEmpty().withMessage('Vendor is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.description').notEmpty().withMessage('Item description is required'),
  body('items.*.rate').isFloat({ gt: 0 }).withMessage('Every line needs a rate above 0'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0')
];

// An edit may leave the lines alone; any lines it does send follow the same rules.
const billUpdateValidation = [
  body('items').optional().isArray({ min: 1 }).withMessage('At least one item is required'),
  ...billValidation.slice(2)
];

// @route   GET /api/purchase-bills
// @desc    List purchase bills for the authenticated user
// @access  Private
router.get('/', protect, [
  query('paymentStatus').optional({ values: 'falsy' }).isIn(['all', 'pending', 'partial', 'paid', 'overdue']),
  query('vendorId').optional({ values: 'falsy' }).isMongoId(),
  query('search').optional({ values: 'falsy' }).trim(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const {
      paymentStatus,
      vendorId,
      search,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const queryObj = { ...(await billScope(req.user)) };

    // "overdue" = still owed and past its due date.
    if (paymentStatus === 'overdue') {
      Object.assign(queryObj, { paymentStatus: { $ne: 'paid' }, dueDate: { $lt: startOfToday() } });
    } else if (paymentStatus && paymentStatus !== 'all') {
      queryObj.paymentStatus = paymentStatus;
    }

    if (vendorId) queryObj.vendorId = vendorId;

    if (search) {
      queryObj.$or = [
        { billNumber: { $regex: search, $options: 'i' } },
        { vendorName: { $regex: search, $options: 'i' } },
        { vendorInvoiceNumber: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * limit;
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const bills = await PurchaseBill.find(queryObj)
      .populate('vendorId', 'name email phone gstNumber')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const totalBills = await PurchaseBill.countDocuments(queryObj);

    res.status(200).json({
      status: 'success',
      data: {
        bills,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalBills / limit),
          count: bills.length,
          totalBills
        }
      }
    });
  } catch (error) {
    console.error('Get purchase bills error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching purchase bills'
    });
  }
});

// @route   GET /api/purchase-bills/stats/summary
// @desc    Purchase bill statistics
// @access  Private
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = await billScope(req.user);
    const [result, byStatus, overdue] = await Promise.all([
      PurchaseBill.getPurchaseBillStats(scope),
      PurchaseBill.aggregate([{ $match: scope }, { $group: { _id: '$paymentStatus', count: { $sum: 1 } } }]),
      PurchaseBill.aggregate([
        { $match: { ...scope, paymentStatus: { $ne: 'paid' }, dueDate: { $lt: startOfToday() } } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$balanceAmount' } } }
      ])
    ]);
    const stats = {
      ...(result[0] || { totalBills: 0, totalAmount: 0, paidAmount: 0, outstandingAmount: 0 }),
      // Bills per payment status, for the list's views.
      counts: {
        ...Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
        overdue: overdue[0]?.count || 0
      },
      overdueAmount: overdue[0]?.amount || 0
    };

    res.status(200).json({
      status: 'success',
      data: { stats }
    });
  } catch (error) {
    console.error('Get purchase bill stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching purchase bill statistics'
    });
  }
});

// @route   GET /api/purchase-bills/from-orders
// @desc    Approved purchase orders with no bill yet, for one-click generation
// @access  Private
router.get('/from-orders', protect, requirePermission('Purchase Bills: Create & Edit'), async (req, res) => {
  try {
    const orders = await billableOrders(req.user);
    res.status(200).json({
      status: 'success',
      data: {
        orders: orders.map((po) => ({ _id: po._id, poNumber: po.poNumber, vendorName: po.vendorName, status: po.status, totalAmount: po.totalAmount, createdAt: po.createdAt })),
        count: orders.length,
        totalAmount: orders.reduce((s, po) => s + (po.totalAmount || 0), 0)
      }
    });
  } catch (error) {
    console.error('List billable purchase orders error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading purchase orders' });
  }
});

// @route   POST /api/purchase-bills/generate
// @desc    Generate the bills of approved purchase orders in one go: the orders
//          named in purchaseOrderIds, or every approved order with no bill yet.
//          An order already billed is skipped, never billed twice.
// @access  Private
router.post('/generate', protect, requirePermission('Purchase Bills: Create & Edit'), [
  body('purchaseOrderIds').optional().isArray({ min: 1, max: 200 }).withMessage('Choose the orders to bill'),
  body('purchaseOrderIds.*').isMongoId().withMessage('Choose the orders to bill')
], validate, async (req, res) => {
  try {
    const ids = req.body.purchaseOrderIds;
    const orders = await billableOrders(req.user, ids);
    if (!orders.length) {
      return res.status(400).json({
        status: 'error',
        message: ids ? 'That order is already billed, still a draft, or cancelled.' : 'There are no approved purchase orders waiting for a bill.'
      });
    }

    const bills = [];
    const problems = [];
    for (const po of orders) {
      const built = await billFromOrder(req.user, po);
      if (built.error) {
        problems.push(built.error);
        continue;
      }
      let bill;
      try {
        bill = await createNumberedBill(req.user, built.data);
      } catch (error) {
        // Another login generated this order's bill a moment ago.
        if (error.code === 11000 && error.keyPattern?.purchaseOrderId) continue;
        throw error;
      }
      po.purchaseBillId = bill._id;
      po.purchaseBillNumber = bill.billNumber;
      await po.save();
      bills.push(bill);
      ActivityLog.logActivity({
        action: 'Purchase Bill Generated',
        description: `${bill.billNumber} generated from purchase order ${po.poNumber} (${po.vendorName})`,
        entityType: 'inventory',
        entityId: bill._id,
        entityName: bill.billNumber,
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        actionType: 'create',
        severity: 'low',
        userId: req.user._id,
        dataScope: req.user.dataScope
      }).catch((err) => console.error('Activity log (generate purchase bill) failed:', err.message));
    }

    if (!bills.length) {
      return res.status(400).json({ status: 'error', message: problems[0] || 'No bills were generated.', details: problems });
    }
    res.status(201).json({
      status: 'success',
      message: `${bills.length} purchase bill${bills.length === 1 ? '' : 's'} generated${problems.length ? `; ${problems.length} order${problems.length === 1 ? '' : 's'} could not be billed` : ''}`,
      data: { bills, generated: bills.length, problems }
    });
  } catch (error) {
    console.error('Generate purchase bills error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while generating purchase bills' });
  }
});

// @route   GET /api/purchase-bills/:id
// @desc    Get a single purchase bill
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const bill = await PurchaseBill.findOne({ _id: req.params.id, ...(await billScope(req.user)) })
      .populate('vendorId', 'name email phone gstNumber');

    if (!bill) {
      return res.status(404).json({ status: 'error', message: 'Purchase bill not found' });
    }

    res.status(200).json({ status: 'success', data: { bill } });
  } catch (error) {
    console.error('Get purchase bill error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching purchase bill'
    });
  }
});

// @route   POST /api/purchase-bills
// @desc    Create a purchase bill
// @access  Private
router.post('/', protect, requirePermission('Purchase Bills: Create & Edit'), billValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array().map(err => ({ field: err.path || err.param, message: err.msg }))
      });
    }

    // Snapshot vendor details
    const vendor = await Vendor.findOne({ _id: req.body.vendorId, ...(await orgUserFilter(req.user)) });
    if (!vendor) {
      return res.status(404).json({ status: 'error', message: 'Vendor not found' });
    }

    // A bill typed in by hand is not linked to an order; generating does that.
    const { purchaseOrderId, purchaseOrderNumber, ...fields } = req.body;
    const bill = await createNumberedBill(req.user, {
      ...fields,
      vendorName: vendor.name,
      vendorGstNumber: req.body.vendorGstNumber || vendor.gstNumber || '',
      vendorAddress: req.body.vendorAddress || vendor.fullAddress || '',
      vendorState: req.body.vendorState || vendor.address?.state || ''
    });

    const populated = await PurchaseBill.findById(bill._id)
      .populate('vendorId', 'name email phone gstNumber');

    res.status(201).json({
      status: 'success',
      message: 'Purchase bill created successfully',
      data: { bill: populated }
    });
  } catch (error) {
    console.error('Create purchase bill error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ status: 'error', message: 'Duplicate bill number. Please try again.' });
    }
    res.status(500).json({
      status: 'error',
      message: 'Server error while creating purchase bill',
      error: error.message
    });
  }
});

// @route   PUT /api/purchase-bills/:id
// @desc    Update a purchase bill
// @access  Private
router.put('/:id', protect, requirePermission('Purchase Bills: Create & Edit'), billUpdateValidation, validate, async (req, res) => {
  try {
    const bill = await PurchaseBill.findOne({ _id: req.params.id, ...(await billScope(req.user)) });
    if (!bill) {
      return res.status(404).json({ status: 'error', message: 'Purchase bill not found' });
    }

    const updatable = [
      'vendorInvoiceNumber', 'billDate', 'dueDate', 'items', 'isInterState',
      'paidAmount', 'notes', 'status'
    ];
    updatable.forEach((field) => {
      if (req.body[field] !== undefined) bill[field] = req.body[field];
    });

    // Re-snapshot vendor if changed
    if (req.body.vendorId && req.body.vendorId !== String(bill.vendorId)) {
      const vendor = await Vendor.findOne({ _id: req.body.vendorId, ...(await orgUserFilter(req.user)) });
      if (!vendor) {
        return res.status(404).json({ status: 'error', message: 'Vendor not found' });
      }
      bill.vendorId = vendor._id;
      bill.vendorName = vendor.name;
      bill.vendorGstNumber = req.body.vendorGstNumber || vendor.gstNumber || '';
      bill.vendorAddress = req.body.vendorAddress || vendor.fullAddress || '';
      bill.vendorState = req.body.vendorState || vendor.address?.state || '';
    } else {
      if (req.body.vendorGstNumber !== undefined) bill.vendorGstNumber = req.body.vendorGstNumber;
      if (req.body.vendorAddress !== undefined) bill.vendorAddress = req.body.vendorAddress;
      if (req.body.vendorState !== undefined) bill.vendorState = req.body.vendorState;
    }

    await bill.save();

    const populated = await PurchaseBill.findById(bill._id)
      .populate('vendorId', 'name email phone gstNumber');

    res.status(200).json({
      status: 'success',
      message: 'Purchase bill updated successfully',
      data: { bill: populated }
    });
  } catch (error) {
    console.error('Update purchase bill error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating purchase bill',
      error: error.message
    });
  }
});

// @route   DELETE /api/purchase-bills/:id
// @desc    Delete a purchase bill
// @access  Private
router.delete('/:id', protect, requirePermission('Purchase Bills: Delete'), async (req, res) => {
  try {
    const bill = await PurchaseBill.findOneAndDelete({ _id: req.params.id, ...(await billScope(req.user)) });
    if (!bill) {
      return res.status(404).json({ status: 'error', message: 'Purchase bill not found' });
    }
    // Its order can be billed again.
    if (bill.purchaseOrderId) {
      await PurchaseOrder.updateOne({ _id: bill.purchaseOrderId, purchaseBillId: bill._id }, { $unset: { purchaseBillId: 1, purchaseBillNumber: 1 } });
    }
    res.status(200).json({ status: 'success', message: 'Purchase bill deleted successfully' });
  } catch (error) {
    console.error('Delete purchase bill error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting purchase bill'
    });
  }
});

// @route   GET /api/purchase-bills/:id/pdf
// @desc    Generate and download purchase bill PDF
// @access  Private
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const bill = await PurchaseBill.findOne({ _id: req.params.id, ...(await billScope(req.user)) })
      .populate('vendorId', 'name email phone gstNumber');

    if (!bill) {
      return res.status(404).json({ status: 'error', message: 'Purchase bill not found' });
    }

    const companyInfoResult = await getCompanyInfo(req.user);
    if (!companyInfoResult.isConfigured) {
      return res.status(400).json({
        status: 'error',
        message: companyInfoResult.error,
        code: 'COMPANY_NOT_CONFIGURED'
      });
    }

    const pdfBuffer = await PDFService.generatePurchaseBillPDFFromHTML(bill, companyInfoResult);

    if (!pdfBuffer || pdfBuffer.length === 0) {
      return res.status(500).json({ status: 'error', message: 'Failed to generate PDF - empty buffer' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PurchaseBill_${bill.billNumber}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Purchase bill PDF generation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate PDF: ' + error.message
    });
  }
});

module.exports = router;
