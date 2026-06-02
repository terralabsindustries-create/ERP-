const express = require('express');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');
const Quotation = require('../models/Quotation');
const Customer = require('../models/Customer');
const { protect } = require('../middleware/auth');

const router = express.Router();

const quotationValidation = [
  body('customer_id').notEmpty().withMessage('Customer is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.item_name').notEmpty().withMessage('Item name is required'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price cannot be negative')
];

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
router.post('/', protect, quotationValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
  }

  try {
    const { customer_id, gst_type, is_interstate, valid_until, items, terms_conditions, notes } = req.body;

    // Verify customer belongs to this user/scope
    const customerFilter = req.user.dataScope
      ? { _id: customer_id, dataScope: req.user.dataScope }
      : { _id: customer_id, userId: req.user._id };
    const customer = await Customer.findOne(customerFilter);
    if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });

    // Calculate item totals
    const processedItems = items.map(item => {
      const subtotal = item.quantity * item.unit_price;
      const taxAmount = gst_type === 'gst' ? (subtotal * (item.tax_rate || 0)) / 100 : 0;
      return {
        item_name: item.item_name,
        description: item.description || '',
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate || 0,
        tax_amount: taxAmount,
        total_amount: subtotal + taxAmount
      };
    });

    const subtotal = processedItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const taxTotal = processedItems.reduce((sum, i) => sum + i.tax_amount, 0);
    const totalAmount = subtotal + taxTotal;

    const quotationNumber = await Quotation.generateQuotationNumber(req.user._id, req.user.dataScope);

    const quotation = await Quotation.create({
      quotationNumber,
      customer_id,
      gst_type: gst_type || 'non_gst',
      is_interstate: is_interstate || false,
      valid_until: valid_until || null,
      items: processedItems,
      subtotal,
      tax_amount: taxTotal,
      total_amount: totalAmount,
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

// PATCH /api/quotations/:id/status
router.patch('/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['draft', 'sent', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ status: 'error', message: 'Invalid status' });
    }

    const filter = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const quotation = await Quotation.findOneAndUpdate(filter, { status }, { new: true })
      .populate('customer_id', 'name email phone');

    if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });

    res.json({ status: 'success', data: { quotation } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// DELETE /api/quotations/:id
router.delete('/:id', protect, async (req, res) => {
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
