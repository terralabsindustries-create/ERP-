const express = require('express');
const Customer = require('../models/Customer');
const Job = require('../models/Job');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const PurchaseOrder = require('../models/PurchaseOrder');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { orgScope, purchaseOrderScope } = require('../utils/accessScope');
const { jobScope } = require('../utils/jobAccess');
const { staffScopeQuery } = require('../utils/dataScopeHelper');

/*
  GET /api/search?q=<text>&limit=5

  The header's global search, in one request. Everything stays inside the
  caller's business and their record visibility (the same scopes the list
  pages use), and each section appears only for logins that may open it.

  A search matches, case-insensitively and literally (the text is not a regex):
  - customers: name, company, email, phone (digits with any spacing)
  - jobs: title, description, product/item name — and every job of the
    customers the text matched, so a customer's name finds their jobs
  - quotations: number, item names, and those customers' quotations
  - invoices: number, customer name, job title, and those customers' invoices
  - purchase orders: PO number and supplier name
*/
const router = express.Router();
router.use(protect);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
    const empty = { customers: [], jobs: [], quotations: [], invoices: [], purchaseOrders: [] };
    if (q.length < 2) return res.json({ status: 'success', data: empty });

    const user = req.user;
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    const digits = q.replace(/\D/g, '');
    const phoneRx = digits.length >= 3 && /^[\d\s()+-]+$/.test(q) ? { $regex: digits.split('').join('[\\s()+-]*') } : null;

    const can = {
      customers: userCan(user, 'Customers') || userCan(user, 'Jobs') || userCan(user, 'Invoicing') || userCan(user, 'Quotations'),
      jobs: userCan(user, 'Jobs'),
      quotations: userCan(user, 'Quotations'),
      invoices: userCan(user, 'Invoicing'),
      purchaseOrders: userCan(user, 'Inventory') || userCan(user, 'Purchase Bills') || userCan(user, 'Vendors')
    };

    // Customers first: their ids widen the other searches.
    const customerScope = user.dataScope ? { dataScope: user.dataScope } : { userId: user._id };
    const customerOr = ['name', 'company', 'email', 'phone'].map((f) => ({ [f]: rx }));
    if (phoneRx) customerOr.push({ phone: phoneRx });
    const matchedCustomers = can.customers
      ? await Customer.find({ ...customerScope, $or: customerOr }).select('name company phone email status').sort({ name: 1 }).limit(50).lean()
      : [];
    const customerIds = matchedCustomers.map((c) => c._id);

    const noGst = userCan(user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } };
    const work = {
      jobs: can.jobs
        ? Job.find({ ...jobScope(user), $or: [{ title: rx }, { description: rx }, { 'items.itemName': rx }, ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : [])] })
          .select('title status priority dueDate customerId createdAt')
          .populate('customerId', 'name company')
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean()
        : [],
      quotations: can.quotations
        ? Quotation.find({ ...(user.dataScope ? { dataScope: user.dataScope } : { userId: user._id }), $or: [{ quotationNumber: rx }, { 'items.item_name': rx }, ...(customerIds.length ? [{ customer_id: { $in: customerIds } }] : [])] })
          .select('quotationNumber status total_amount customer_id createdAt')
          .populate('customer_id', 'name company')
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean()
        : [],
      invoices: can.invoices
        ? Invoice.find({ $and: [staffScopeQuery(user), noGst, { $or: [{ invoiceNumber: rx }, { draftNumber: rx }, { customerName: rx }, { jobTitle: rx }, ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : [])] }] })
          .select('invoiceNumber customerName jobTitle totalAmount balanceAmount status paymentStatus invoiceDate')
          .sort({ invoiceDate: -1 })
          .limit(limit)
          .lean()
        : [],
      purchaseOrders: can.purchaseOrders
        ? purchaseOrderScope(user).then((scope) => PurchaseOrder.find({ $and: [scope, { $or: [{ poNumber: rx }, { vendorName: rx }] }] })
          .select('poNumber vendorName status totalAmount createdAt')
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean())
        : []
    };
    const keys = Object.keys(work);
    const results = await Promise.all(keys.map((k) => work[k]));
    const data = { ...empty, customers: matchedCustomers.slice(0, limit) };
    keys.forEach((k, i) => { data[k] = results[i]; });
    res.json({ status: 'success', data });
  } catch (error) {
    console.error('Global search error:', error);
    res.status(500).json({ status: 'error', message: 'Search failed. Please try again.' });
  }
});

module.exports = router;
