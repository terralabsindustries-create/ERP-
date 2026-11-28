const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const Customer = require('../models/Customer');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const Invoice = require('../models/Invoice');
const { orgScope } = require('../utils/accessScope');
const { jobScope } = require('../utils/jobAccess');
const { createDataScopeQuery } = require('../utils/dataScopeHelper');

const { financialsFor, financialsOne } = require('../services/customerFinancials');

const { gstinError, normalizeGstin } = require('../utils/gstin');
const { stateCodeOf, stateName } = require('../utils/gstStates');
const router = express.Router();

// Validation rules
const customerValidation = [
  body('name').notEmpty().withMessage('Customer name is required').trim(),
  // checkFalsy: express-validator's bare .optional({ values: 'falsy' }) only skips undefined, not
  // "" — and .normalizeEmail() runs even after .isEmail() fails (no .bail()),
  // turning an empty string into the literal string "@". That corrupted value
  // then collides with the very next customer created without an email, since
  // the create route treats any truthy email as one to de-duplicate on.
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('gstNumber').optional({ values: 'falsy' }).customSanitizer(normalizeGstin).custom((value) => {
    const message = gstinError(value);
    if (message) throw new Error(message);
    return true;
  }),
  body('state').optional({ values: 'falsy' }).customSanitizer((v) => stateName(stateCodeOf(v)) || v).custom((value) => {
    if (!stateCodeOf(value)) throw new Error('Choose a valid Indian state or union territory');
    return true;
  }),
  body('phone').optional({ values: 'falsy' }).matches(/^\+?[\d\s()-]{7,20}$/).withMessage('Enter a valid phone number'),
  body('customerType').optional({ values: 'falsy' }).isIn(Customer.schema.path('customerType').enumValues).withMessage('Choose walk-in, agency or another customer type'),
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a customer search matches: the typed text anywhere in the name, company,
 * email or phone, ignoring case. The text is matched literally — "+91" or
 * "(022)" are not regex syntax. A phone-like search also matches numbers saved
 * with spaces, dashes or brackets between the digits ("9847000000" finds
 * "98470 00000").
 */
function customerSearchFilter(search) {
  const text = escapeRegex(search);
  const or = ['name', 'company', 'email', 'phone', 'gstNumber'].map((field) => ({ [field]: { $regex: text, $options: 'i' } }));
  const digits = search.replace(/\D/g, '');
  if (digits.length >= 3 && /^[\d\s()+-]+$/.test(search)) {
    or.push({ phone: { $regex: digits.split('').join('[\\s()+-]*') } });
  }
  return or;
}

// @route   GET /api/customers
// @desc    Get all customers for the authenticated user
// @access  Private
/*
  List views and filters, applied on the server so search, counts and pages
  cover every customer (the Customers page no longer downloads them all).
  Mirrors client/src/pages/Customers.tsx: Business = Business or Corporate;
  "individual" = any other active direct customer; "inactive" = not active.
*/
const BUSINESS_TYPES = ['Business', 'Corporate'];
const CUSTOMER_VIEWS = {
  all: () => ({}),
  walkin: () => ({ status: 'active', customerType: 'Walk-in' }),
  agency: () => ({ status: 'active', customerType: 'Agency' }),
  business: () => ({ status: 'active', customerType: { $in: BUSINESS_TYPES } }),
  individual: () => ({ status: 'active', customerType: { $nin: [...BUSINESS_TYPES, 'Walk-in', 'Agency'] } }),
  inactive: () => ({ status: { $ne: 'active' } })
};
const GST_FILTERS = {
  verified: () => ({ gstVerified: true }),
  unverified: () => ({ gstNumber: { $nin: [null, ''] }, gstVerified: { $ne: true } }),
  none: () => ({ $or: [{ gstNumber: null }, { gstNumber: '' }] })
};
const CUSTOMER_SORTS = { name: 'name', createdAt: 'createdAt', customerType: 'customerType', status: 'status', updatedAt: 'updatedAt' };

router.get('/', protect, [
  query('status').optional({ values: 'falsy' }).isIn(['all', 'active', 'inactive', 'blacklisted']),
  query('view').optional({ values: 'falsy' }).isIn(Object.keys(CUSTOMER_VIEWS)),
  query('gst').optional({ values: 'falsy' }).isIn(['all', ...Object.keys(GST_FILTERS)]),
  query('tag').optional({ values: 'falsy' }).isString().isLength({ max: 60 }),
  query('sortBy').optional({ values: 'falsy' }).isIn(Object.keys(CUSTOMER_SORTS)),
  query('sortOrder').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
  query('search').optional({ values: 'falsy' }).trim(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
], validate, async (req, res) => {
  try {
    const {
      status = 'active',
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query - show only customers in the same dataScope
    // Fallback to userId if dataScope is not available (during migration)
    const query = req.user.dataScope
      ? createDataScopeQuery(req.user.dataScope)
      : { userId: req.user._id };

    if (status !== 'all' && !req.query.view) {
      query.status = status;
    }
    const and = [];
    if (req.query.view) and.push(CUSTOMER_VIEWS[req.query.view]());
    if (req.query.gst && req.query.gst !== 'all') and.push(GST_FILTERS[req.query.gst]());
    if (req.query.tag && req.query.tag !== 'all') and.push({ tags: req.query.tag });
    if (search) and.push({ $or: customerSearchFilter(search) });
    if (and.length) query.$and = and;

    // Calculate pagination
    const skip = (page - 1) * limit;

    // The page and the total are independent: fetched together.
    const countPromise = Customer.countDocuments(query).exec();
    countPromise.catch(() => {}); // awaited below; a failure there reaches the catch
    let customers;
    if (search && !req.query.sortBy) {
      // A search from a picker: names that start with what was typed first,
      // then the rest alphabetically — so "ra" lists Rahul before Abra.
      const ranked = await Customer.aggregate([
        { $match: query },
        {
          $addFields: {
            _prefix: { $cond: [{ $regexMatch: { input: { $ifNull: ['$name', ''] }, regex: `^${escapeRegex(search)}`, options: 'i' } }, 0, 1] },
            _name: { $toLower: { $ifNull: ['$name', ''] } }
          }
        },
        { $sort: { _prefix: 1, _name: 1, _id: 1 } },
        { $skip: skip },
        { $limit: parseInt(limit) },
        { $project: { _id: 1 } }
      ]);
      const ids = ranked.map((r) => r._id);
      const byId = new Map((await Customer.find({ _id: { $in: ids } }).populate('createdBy', 'fullName email')).map((c) => [String(c._id), c]));
      customers = ids.map((id) => byId.get(String(id))).filter(Boolean);
    } else {
      const field = CUSTOMER_SORTS[sortBy] || 'createdAt';
      const dir = sortOrder === 'asc' ? 1 : -1;
      const sort = { [field]: dir, _id: dir };
      customers = await Customer.find(query)
        .populate('createdBy', 'fullName email')
        .sort(sort)
        // Name order ignores case ("abra" sits with "Abra"); uses the name index's collation-free order otherwise.
        .collation(field === 'name' ? { locale: 'en', strength: 2 } : { locale: 'simple' })
        .skip(skip)
        .limit(parseInt(limit));
    }
    
    const totalCustomers = await countPromise;

    // What each customer has been billed and still owes, from their issued
    // invoices — only for logins that may see invoices (and No GST ones only
    // with that permission too).
    let billing = {};
    if (customers.length && userCan(req.user, 'Invoicing')) {
      const invoiceExtra = userCan(req.user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } };
      const byCustomer = await financialsFor(customers.map((c) => c._id), orgScope(req.user), { invoiceExtra });
      billing = Object.fromEntries(
        [...byCustomer].map(([id, f]) => [id, {
          invoiced: f.invoicedRevenue, outstanding: f.outstanding, invoices: f.invoiceCount, lastInvoiceDate: f.lastInvoiceDate,
          grossInvoiced: f.grossInvoiced, creditNotes: f.creditNotesTotal, debitNotes: f.debitNotesTotal,
          paymentsReceived: f.paymentsReceived, cancelledInvoiced: f.cancelledInvoiced, estimatedJobValue: f.estimatedJobValue
        }])
      );
    }

    res.status(200).json({
      status: 'success',
      data: {
        customers: customers.map((c) => ({ ...c.toJSON(), billing: billing[String(c._id)] || null })),
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalCustomers / limit),
          count: customers.length,
          totalCustomers
        }
      }
    });
    
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching customers'
    });
  }
});

// @route   GET /api/customers/stats/summary
// @desc    Figures for the Customers page header and view tabs, over every
//          customer of the business (not one page): counts per view, tags in
//          use, and — for logins that see invoices — billed and outstanding.
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const base = req.user.dataScope ? createDataScopeQuery(req.user.dataScope) : { userId: req.user._id };
    const facet = Object.fromEntries(Object.entries(CUSTOMER_VIEWS).map(([k, f]) => [k, [{ $match: f() }, { $count: 'n' }]]));
    facet.active = [{ $match: { status: 'active' } }, { $count: 'n' }];
    facet.withGstin = [{ $match: { gstNumber: { $nin: [null, ''] } } }, { $count: 'n' }];
    facet.tags = [{ $unwind: '$tags' }, { $group: { _id: '$tags' } }, { $sort: { _id: 1 } }, { $limit: 200 }];
    const [row] = await Customer.aggregate([{ $match: base }, { $facet: facet }]);
    const n = (k) => row[k][0]?.n || 0;
    const counts = Object.fromEntries(Object.keys(CUSTOMER_VIEWS).map((k) => [k, n(k)]));
    let billing = null;
    if (userCan(req.user, 'Invoicing')) {
      const invoiceExtra = userCan(req.user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } };
      const ids = await Customer.find(base).distinct('_id');
      const all = await financialsFor(ids, orgScope(req.user), { invoiceExtra });
      let invoiced = 0; let outstanding = 0; let owing = 0;
      for (const f of all.values()) {
        invoiced += f.invoicedRevenue || 0;
        outstanding += f.outstanding || 0;
        if ((f.outstanding || 0) > 0.5) owing += 1;
      }
      billing = { invoiced: Math.round(invoiced * 100) / 100, outstanding: Math.round(outstanding * 100) / 100, owing };
    }
    res.json({ status: 'success', data: { counts, active: n('active'), withGstin: n('withGstin'), tags: row.tags.map((t) => t._id).filter(Boolean), billing } });
  } catch (error) {
    console.error('Customer summary error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading customer figures' });
  }
});

// @route   GET /api/customers/:id
// @desc    Get single customer
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    // Use dataScope if available, fallback to userId during migration
    const query = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const customer = mongoose.isValidObjectId(req.params.id) ? await Customer.findOne(query).populate('createdBy', 'fullName email') : null;
    if (!customer) {
      return res.status(404).json({
        status: 'error',
        message: 'Customer not found'
      });
    }
    
    // Live figures (the stored totals only refresh on update-stats).
    let financials = null;
    if (userCan(req.user, 'Invoicing')) {
      const invoiceExtra = userCan(req.user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } };
      financials = await financialsOne(customer._id, orgScope(req.user), { invoiceExtra });
    }

    res.status(200).json({
      status: 'success',
      data: {
        customer: { ...customer.toJSON(), financials }
      }
    });
    
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching customer'
    });
  }
});

// @route   POST /api/customers
// @desc    Create new customer
// @access  Private
router.post('/', protect, requirePermission('Customers: Create & Edit'), customerValidation, validate, async (req, res) => {
  try {
    // Check if customer with same email already exists (scoped to the same company/admin)
    // Prefer dataScope isolation when available; fallback to userId during migration
    if (req.body.email) {
      const scopeQuery = req.user.dataScope
        ? { dataScope: req.user.dataScope }
        : { userId: req.user._id };

      const existingCustomer = await Customer.findOne({
        ...scopeQuery,
        email: req.body.email.toLowerCase()
      });
      
      if (existingCustomer) {
        return res.status(400).json({
          status: 'error',
          message: 'Customer with this email already exists'
        });
      }
    }
    
    const customerData = {
      ...req.body,
      createdBy: req.user._id,
      userId: req.user._id
    };

    // Add dataScope if user has it (post-migration), otherwise skip
    if (req.user.dataScope) {
      customerData.dataScope = req.user.dataScope;
    }

    const customer = await Customer.create(customerData);

    await customer.populate('createdBy', 'fullName email');

    ActivityLog.logActivity({
      action: 'Customer Created',
      description: `Customer ${customer.name} was created`,
      entityType: 'customer',
      entityId: customer._id,
      entityName: customer.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create customer) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Customer created successfully',
      data: {
        customer
      }
    });

  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while creating customer'
    });
  }
});

// @route   PUT /api/customers/:id
// @desc    Update customer
// @access  Private
router.put('/:id', protect, requirePermission('Customers: Create & Edit'), customerValidation, validate, async (req, res) => {
  try {
    // Use dataScope if available, fallback to userId during migration
    const findQuery = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    // Check if customer exists and belongs to the authenticated user
    const existingCustomer = await Customer.findOne(findQuery);

    if (!existingCustomer) {
      return res.status(404).json({
        status: 'error',
        message: 'Customer not found'
      });
    }

    // Check for email conflicts
    if (req.body.email && req.body.email !== existingCustomer.email) {
      const scopeQuery = req.user.dataScope
        ? { dataScope: req.user.dataScope }
        : { userId: req.user._id };

      const emailConflict = await Customer.findOne({
        ...scopeQuery,
        email: req.body.email.toLowerCase(),
        _id: { $ne: req.params.id }
      });

      if (emailConflict) {
        return res.status(400).json({
          status: 'error',
          message: 'Customer with this email already exists'
        });
      }
    }

    // Update customer
    const customer = await Customer.findOneAndUpdate(
      findQuery,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'fullName email');

    ActivityLog.logActivity({
      action: 'Customer Updated',
      description: `Customer ${customer.name} was updated`,
      entityType: 'customer',
      entityId: customer._id,
      entityName: customer.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update customer) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Customer updated successfully',
      data: {
        customer
      }
    });

  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating customer'
    });
  }
});

// What still refers to a customer. Any of it blocks permanent deletion.
async function customerHistory(customer) {
  const Invoice = require('../models/Invoice');
  const Job = require('../models/Job');
  const Quotation = require('../models/Quotation');
  const Payment = require('../models/Payment');
  const CreditNote = require('../models/CreditNote');
  const id = customer._id;
  const [invoices, jobs, quotations, payments, creditNotes] = await Promise.all([
    Invoice.countDocuments({ customerId: id }),
    Job.countDocuments({ customerId: id }),
    Quotation.countDocuments({ customer_id: id }),
    Payment.countDocuments({ customerId: id }),
    CreditNote.countDocuments({ customerId: id })
  ]);
  return { invoices, jobs, quotations, payments, creditNotes, total: invoices + jobs + quotations + payments + creditNotes };
}

const customerScope = (req) => (req.user.dataScope
  ? { _id: req.params.id, dataScope: req.user.dataScope }
  : { _id: req.params.id, userId: req.user._id });

const logCustomer = (req, customer, action, actionType, severity) => ActivityLog.logActivity({
  action,
  description: `Customer ${customer.name}: ${action.toLowerCase()}`,
  entityType: 'customer',
  entityId: customer._id,
  entityName: customer.name,
  performedBy: req.user._id,
  performedByName: req.user.fullName,
  actionType,
  severity,
  userId: req.user._id,
  dataScope: req.user.dataScope
}).catch(err => console.error(`Activity log (${action}) failed:`, err.message));

// @route   POST /api/customers/bulk  { action: 'deactivate' | 'reactivate', ids: [] }
// @desc    Change several customers at once. Each id is checked on its own
//          against the caller's business; the answer lists every success and
//          every failure with its reason. Nothing is ever deleted here.
router.post('/bulk', protect, async (req, res) => {
  try {
    const { action } = req.body || {};
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 500) : [];
    if (!['deactivate', 'reactivate'].includes(action)) return res.status(400).json({ status: 'error', message: 'Choose deactivate or reactivate.' });
    if (!ids.length) return res.status(400).json({ status: 'error', message: 'Select at least one customer.' });
    const needs = action === 'deactivate' ? 'Customers: Delete' : 'Customers: Create & Edit';
    if (!userCan(req.user, needs)) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to do this.', required: needs });
    const scope = req.user.dataScope ? { dataScope: req.user.dataScope } : { userId: req.user._id };
    const valid = ids.filter((id) => mongoose.isValidObjectId(id));
    const found = await Customer.find({ _id: { $in: valid }, ...scope });
    const byId = new Map(found.map((c) => [String(c._id), c]));
    const succeeded = [];
    const failed = [];
    for (const id of ids) {
      const customer = byId.get(id);
      if (!customer) { failed.push({ id, reason: 'Not found in your business' }); continue; }
      const target = action === 'deactivate' ? 'inactive' : 'active';
      if (customer.status === target) { failed.push({ id, name: customer.name, reason: `${customer.name} is already ${target}` }); continue; }
      try {
        customer.status = target;
        customer.isActive = target === 'active';
        await customer.save();
        logCustomer(req, customer, action === 'deactivate' ? 'Customer Deactivated (bulk)' : 'Customer Reactivated (bulk)', 'update', 'medium');
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, name: customer.name, reason: error.message });
      }
    }
    res.json({ status: 'success', data: { succeeded, failed } });
  } catch (error) {
    console.error('Bulk customer change error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while changing customers' });
  }
});

// @route   PATCH /api/customers/:id/reactivate
// @desc    Make a deactivated customer active again
router.patch('/:id/reactivate', protect, requirePermission('Customers: Create & Edit'), async (req, res) => {
  try {
    const customer = await Customer.findOne(customerScope(req));
    if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });
    customer.status = 'active';
    customer.isActive = true;
    await customer.save();
    logCustomer(req, customer, 'Customer Reactivated', 'update', 'medium');
    res.status(200).json({ status: 'success', message: `${customer.name} is active again`, data: { customer } });
  } catch (error) {
    console.error('Reactivate customer error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while reactivating customer' });
  }
});

// @route   DELETE /api/customers/:id
// @desc    Deactivate a customer (default) or, with ?permanent=true, delete one
//          that has no financial or job history.
// @access  Private
router.delete('/:id', protect, requirePermission('Customers: Delete'), async (req, res) => {
  try {
    const customer = await Customer.findOne(customerScope(req));

    if (!customer) {
      return res.status(404).json({
        status: 'error',
        message: 'Customer not found'
      });
    }

    if (req.query.permanent === 'true') {
      const history = await customerHistory(customer);
      if (history.total > 0) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTOMER_HAS_HISTORY',
          message: `${customer.name} has ${history.invoices} invoices, ${history.jobs} jobs, ${history.quotations} quotations and ${history.payments} payments on record, so it cannot be deleted permanently. Deactivate it instead.`,
          details: history
        });
      }
      await Customer.deleteOne({ _id: customer._id });
      logCustomer(req, customer, 'Customer Deleted', 'delete', 'high');
      return res.status(200).json({ status: 'success', message: 'Customer permanently deleted' });
    }

    customer.status = 'inactive';
    customer.isActive = false;
    await customer.save();
    logCustomer(req, customer, 'Customer Deactivated', 'update', 'high');

    res.status(200).json({
      status: 'success',
      message: `${customer.name} was deactivated. Their invoices, jobs and payments are kept, and you can reactivate them any time.`,
      data: { customer }
    });

  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting customer'
    });
  }
});

// @route   POST /api/customers/:id/update-stats
// @desc    Update customer statistics
// @access  Private
router.post('/:id/update-stats', protect, async (req, res) => {
  try {
    // Use dataScope if available, fallback to userId during migration
    const findQuery = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const customer = await Customer.findOne(findQuery);

    if (!customer) {
      return res.status(404).json({
        status: 'error',
        message: 'Customer not found'
      });
    }

    await customer.updateStats();

    res.status(200).json({
      status: 'success',
      message: 'Customer statistics updated successfully',
      data: {
        customer
      }
    });

  } catch (error) {
    console.error('Update customer stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating customer statistics'
    });
  }
});

// @route   GET /api/customers/:id/jobs
// @desc    Get customer jobs
// @access  Private
router.get('/:id/jobs', protect, async (req, res) => {
  try {
    const Job = require('../models/Job');

    // Use dataScope if available, fallback to userId during migration
    const findQuery = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    // Verify the customer belongs to the authenticated user before fetching jobs
    const customer = await Customer.findOne(findQuery);

    if (!customer) {
      return res.status(404).json({
        status: 'error',
        message: 'Customer not found'
      });
    }

    // The customer's job tickets this login may see (utils/jobAccess.js).
    const jobQuery = { customerId: req.params.id, ...jobScope(req.user) };

    const jobs = await Job.find(jobQuery).sort({ createdAt: -1 });
    
    res.status(200).json({
      status: 'success',
      data: {
        jobs
      }
    });
    
  } catch (error) {
    console.error('Get customer jobs error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching customer jobs'
    });
  }
});

module.exports = router;
