const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { body, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PortalSession = require('../models/PortalSession');
const PortalAccess = require('../models/PortalAccess');
const CustomerFile = require('../models/CustomerFile');
const Customer = require('../models/Customer');
const User = require('../models/User');
const Job = require('../models/Job');
const Invoice = require('../models/Invoice');
const Delivery = require('../models/Delivery');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { orgScope } = require('../utils/accessScope');
// Called through the module so tests can stand in for the SMTP transport.
const mailer = require('../utils/mailer');

/*
  Customer portal
  ---------------
  Staff with Customer Portal: Manage Access issue a link for one customer
  (POST /access). The link carries a random token; only its hash is stored.
  The customer opens the link, the client exchanges the token for a session
  (POST /session), and every portal request then sends the session token in
  X-Portal-Session. All portal data is filtered by that session's customer,
  so one customer can never see another's records. Revoking the link, or its
  expiry, ends the customer's access immediately.

  The old phone-number login is gone: knowing a phone number is not proof of
  identity, and it searched every business's customers.
*/

const router = express.Router();

const LINK_DAYS_DEFAULT = 30;
const LINK_DAYS_MAX = 90;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/customer-files';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar|ai|psd|cdr|eps|svg|tif|tiff/;
    const ok = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    return ok ? cb(null, true) : cb(new Error('Invalid file type. Only images, documents, design files and archives are allowed.'));
  }
});

// Slow down guessing at link tokens and session tokens.
const sessionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const rejectInvalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ status: 'error', message: errors.array()[0].msg });
  return true;
};

const portalUrl = (token) => `${(process.env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '')}/customer-portal/${token}`;

// ============= STAFF: ISSUE AND REVOKE PORTAL LINKS =============

// @route   POST /api/portal/access
// @desc    Create a portal link for one customer (optionally email it to them)
// @access  Private (Customer Portal: Manage Access)
router.post('/access', protect, requirePermission('Customer Portal: Manage Access'), [
  body('customerId').isMongoId().withMessage('Choose a customer'),
  body('expiresInDays').optional().isInt({ min: 1, max: LINK_DAYS_MAX }).withMessage(`Links can last 1 to ${LINK_DAYS_MAX} days`),
  body('sendEmail').optional().isBoolean()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const customer = await Customer.findOne({ _id: req.body.customerId, ...orgScope(req.user) });
    if (!customer) {
      return res.status(404).json({ status: 'error', message: 'Customer not found' });
    }
    if (customer.status && customer.status !== 'active') {
      return res.status(400).json({ status: 'error', message: 'Portal access can only be given to active customers' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const days = parseInt(req.body.expiresInDays, 10) || LINK_DAYS_DEFAULT;
    const access = await PortalAccess.create({
      customerId: customer._id,
      customerName: customer.name,
      tokenHash: PortalSession.hashToken(token),
      expiresAt: new Date(Date.now() + days * 864e5),
      createdBy: req.user._id,
      createdByName: req.user.fullName,
      userId: customer.userId || req.user._id,
      dataScope: req.user.dataScope
    });
    const link = portalUrl(token);

    let emailed = false;
    let emailError = null;
    if (req.body.sendEmail) {
      if (!customer.email) {
        emailError = 'This customer has no email address on file.';
      } else {
        try {
          const company = req.user.companyName || 'Terralabs ERP';
          await mailer.createTransporter().sendMail({
            from: mailer.getFromAddress(company),
            to: customer.email,
            replyTo: req.user.email,
            subject: `Your order portal at ${company}`,
            text: `Hello ${customer.name},\n\nYou can follow your orders, invoices and deliveries with ${company} here:\n${link}\n\nThe link is personal to you and works until ${access.expiresAt.toDateString()}. Please don't forward it.\n\n${company}`
          });
          emailed = true;
        } catch (mailError) {
          emailError = mailError.code === 'EMAIL_NOT_CONFIGURED' ? 'Email is not configured on the server.' : 'The email could not be sent.';
        }
      }
    }

    ActivityLog.logActivity({
      action: 'Portal Link Created',
      description: `Customer portal link created for ${customer.name}, valid for ${days} days${emailed ? ' (emailed)' : ''}`,
      entityType: 'customer',
      entityId: customer._id,
      entityName: customer.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch((err) => console.error('Activity log (portal link) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: emailed ? `Link created and emailed to ${customer.email}` : 'Link created',
      // The raw link is shown once; it cannot be recovered later.
      data: { access, link, emailed, emailError }
    });
  } catch (error) {
    console.error('Create portal link error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating the portal link' });
  }
});

// @route   GET /api/portal/access?customerId=
// @desc    Portal links issued in this business
// @access  Private (Customer Portal)
router.get('/access', protect, requirePermission('Customer Portal'), [query('customerId').optional().isMongoId()], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const filter = { ...orgScope(req.user) };
    if (!req.user.dataScope) filter.userId = req.user._id;
    if (req.query.customerId) filter.customerId = req.query.customerId;
    const links = await PortalAccess.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ status: 'success', data: { links } });
  } catch (error) {
    console.error('List portal links error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching portal links' });
  }
});

// @route   DELETE /api/portal/access/:id
// @desc    Revoke a portal link and end its sessions
// @access  Private (Customer Portal: Manage Access)
router.delete('/access/:id', protect, requirePermission('Customer Portal: Manage Access'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ status: 'error', message: 'Portal link not found' });
    }
    const filter = { _id: req.params.id, ...orgScope(req.user) };
    if (!req.user.dataScope) filter.userId = req.user._id;
    const access = await PortalAccess.findOne(filter);
    if (!access) {
      return res.status(404).json({ status: 'error', message: 'Portal link not found' });
    }
    if (!access.revokedAt) {
      access.revokedAt = new Date();
      access.revokedBy = req.user._id;
      await access.save();
    }
    await PortalSession.updateMany({ accessId: access._id, isActive: true }, { isActive: false });

    ActivityLog.logActivity({
      action: 'Portal Link Revoked',
      description: `Customer portal link for ${access.customerName} was revoked`,
      entityType: 'customer',
      entityId: access.customerId,
      entityName: access.customerName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch((err) => console.error('Activity log (portal revoke) failed:', err.message));

    res.json({ status: 'success', message: 'Portal link revoked', data: { access } });
  } catch (error) {
    console.error('Revoke portal link error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while revoking the portal link' });
  }
});

// ============= CUSTOMER: SESSION =============

// @route   POST /api/portal/login — retired
router.post('/login', (req, res) => {
  res.status(410).json({
    status: 'error',
    message: 'Phone-number login has been retired. Ask the business for your personal portal link.',
    code: 'PORTAL_LINK_REQUIRED'
  });
});

// @route   POST /api/portal/session
// @desc    Exchange a portal link token for a session
// @access  Public (rate limited)
router.post('/session', sessionLimiter, [body('token').isString().isLength({ min: 20, max: 200 }).withMessage('Invalid portal link')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const access = await PortalAccess.findOne({ tokenHash: PortalSession.hashToken(req.body.token) });
    if (!access || access.revokedAt || access.expiresAt < new Date()) {
      return res.status(401).json({ status: 'error', message: 'This portal link is invalid, expired or has been revoked.', code: 'PORTAL_LINK_INVALID' });
    }
    const customer = await Customer.findById(access.customerId);
    if (!customer || (customer.status && customer.status !== 'active')) {
      return res.status(401).json({ status: 'error', message: 'This portal link is no longer active.', code: 'PORTAL_LINK_INVALID' });
    }

    const { session, token } = await PortalSession.openSession({
      access,
      customer,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    access.lastUsedAt = new Date();
    access.useCount = (access.useCount || 0) + 1;
    await access.save();

    const owner = await User.findById(access.userId).select('companyName');
    res.json({
      status: 'success',
      data: {
        sessionToken: token,
        expiresAt: session.expiresAt,
        customer: { name: customer.name, email: customer.email, phone: customer.phone, company: customer.company },
        business: { name: owner?.companyName || null }
      }
    });
  } catch (error) {
    console.error('Portal session error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while opening the portal' });
  }
});

// Every customer route below runs as the session's customer only.
const portalSession = async (req, res, next) => {
  try {
    const session = await PortalSession.validateSession(req.get('X-Portal-Session'));
    if (!session) {
      return res.status(401).json({ status: 'error', message: 'Your portal session has ended. Open your portal link again.', code: 'PORTAL_SESSION_INVALID' });
    }
    req.portalSession = session;
    next();
  } catch (error) {
    console.error('Portal session validation error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while validating portal session' });
  }
};

const mine = (req) => ({ customerId: req.portalSession.customerId });
const pageArgs = (req, max = 50) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, max);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  return { limit, skip: (page - 1) * limit, page };
};

// @route   POST /api/portal/logout
router.post('/logout', portalSession, async (req, res) => {
  try {
    req.portalSession.isActive = false;
    await req.portalSession.save();
    res.json({ status: 'success', message: 'Signed out' });
  } catch (error) {
    console.error('Portal logout error:', error);
    res.status(500).json({ status: 'error', message: 'Server error during portal logout' });
  }
});

// @route   GET /api/portal/customer-data
router.get('/customer-data', portalSession, async (req, res) => {
  try {
    const customer = await Customer.findById(req.portalSession.customerId).select('name email phone company address gstNumber');
    if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });
    res.json({ status: 'success', data: { customer, sessionExpiresAt: req.portalSession.expiresAt } });
  } catch (error) {
    console.error('Get customer data error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching customer data' });
  }
});

// @route   GET /api/portal/orders
router.get('/orders', portalSession, async (req, res) => {
  try {
    const { limit, skip, page } = pageArgs(req);
    const filter = { ...mine(req) };
    if (req.query.status && req.query.status !== 'all') filter.status = String(req.query.status);
    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .select('title description status priority dueDate printSpecs estimatedCost createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Job.countDocuments(filter)
    ]);
    res.json({ status: 'success', data: { jobs, pagination: { current: page, total: Math.ceil(total / limit), totalJobs: total } } });
  } catch (error) {
    console.error('Get customer orders error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching your orders' });
  }
});

// @route   GET /api/portal/invoices — issued invoices only, no drafts
router.get('/invoices', portalSession, async (req, res) => {
  try {
    const { limit, skip, page } = pageArgs(req);
    const filter = { ...mine(req), status: { $nin: ['draft', 'cancelled'] } };
    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .select('invoiceNumber invoiceDate dueDate totalAmount paidAmount balanceAmount paymentStatus status jobTitle items.itemName items.quantity items.unit items.unitPrice items.totalAmount items.length items.width items.totalSquareFeet designCharge discountAmount totalGstAmount')
        .sort({ invoiceDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(filter)
    ]);
    res.json({ status: 'success', data: { invoices, pagination: { current: page, total: Math.ceil(total / limit), totalInvoices: total } } });
  } catch (error) {
    console.error('Get customer invoices error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching your invoices' });
  }
});

// @route   GET /api/portal/deliveries
router.get('/deliveries', portalSession, async (req, res) => {
  try {
    const { limit, skip, page } = pageArgs(req);
    const filter = { ...mine(req) };
    const [deliveries, total] = await Promise.all([
      Delivery.find(filter)
        .select('deliveryId jobId status deliveryDate deliveryTimeSlot deliveryAddress trackingNumber createdAt updatedAt')
        .populate('jobId', 'title')
        .sort({ deliveryDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Delivery.countDocuments(filter)
    ]);
    res.json({ status: 'success', data: { deliveries, pagination: { current: page, total: Math.ceil(total / limit), totalDeliveries: total } } });
  } catch (error) {
    console.error('Get customer deliveries error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching your deliveries' });
  }
});

// @route   POST /api/portal/upload-file
router.post('/upload-file', portalSession, upload.single('file'), [
  body('category').optional().isIn(['design', 'proof', 'final', 'reference', 'other']),
  body('description').optional().trim().isLength({ max: 500 }),
  body('jobId').optional({ checkFalsy: true }).isMongoId()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    if (!req.file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });

    const { category = 'other', description, jobId } = req.body;
    if (jobId && !(await Job.exists({ _id: jobId, ...mine(req) }))) {
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }

    const customerFile = await CustomerFile.create({
      fileName: req.file.filename,
      originalName: req.file.originalname,
      fileUrl: `/uploads/customer-files/${req.file.filename}`,
      fileType: path.extname(req.file.originalname).toLowerCase(),
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      category,
      description,
      customerId: req.portalSession.customerId,
      jobId: jobId || undefined,
      uploadedBy: 'customer',
      userId: req.portalSession.userId
    });

    res.status(201).json({ status: 'success', message: 'File uploaded', data: { file: customerFile } });
  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while uploading file' });
  }
});

// @route   GET /api/portal/files
router.get('/files', portalSession, async (req, res) => {
  try {
    const { limit, skip, page } = pageArgs(req);
    const filter = { ...mine(req) };
    const [files, total] = await Promise.all([
      CustomerFile.find(filter)
        .select('originalName fileType fileSize mimeType category description jobId uploadedBy createdAt')
        .populate('jobId', 'title')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CustomerFile.countDocuments(filter)
    ]);
    res.json({ status: 'success', data: { files, pagination: { current: page, total: Math.ceil(total / limit), totalFiles: total } } });
  } catch (error) {
    console.error('Get customer files error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching your files' });
  }
});

// @route   GET /api/portal/files/:id/download
router.get('/files/:id/download', portalSession, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'File not found' });
    const file = await CustomerFile.findOne({ _id: req.params.id, ...mine(req) });
    if (!file) return res.status(404).json({ status: 'error', message: 'File not found' });

    const filePath = path.join('uploads/customer-files', path.basename(file.fileName));
    if (!fs.existsSync(filePath)) return res.status(404).json({ status: 'error', message: 'File is no longer available' });

    file.downloadCount = (file.downloadCount || 0) + 1;
    file.lastDownloaded = new Date();
    await file.save();
    res.download(filePath, file.originalName);
  } catch (error) {
    console.error('Download file error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while downloading file' });
  }
});

// @route   GET /api/portal/stats/summary
router.get('/stats/summary', portalSession, async (req, res) => {
  try {
    const own = mine(req);
    const [totalOrders, openOrders, totalInvoices, unpaidInvoices, outstanding, totalFiles] = await Promise.all([
      Job.countDocuments(own),
      Job.countDocuments({ ...own, status: { $nin: ['completed', 'delivered', 'cancelled'] } }),
      Invoice.countDocuments({ ...own, status: { $nin: ['draft', 'cancelled'] } }),
      Invoice.countDocuments({ ...own, status: { $nin: ['draft', 'cancelled'] }, paymentStatus: { $ne: 'paid' } }),
      Invoice.aggregate([
        { $match: { customerId: new mongoose.Types.ObjectId(String(own.customerId)), status: { $nin: ['draft', 'cancelled'] } } },
        { $group: { _id: null, total: { $sum: '$balanceAmount' } } }
      ]),
      CustomerFile.countDocuments(own)
    ]);
    res.json({
      status: 'success',
      data: { stats: { totalOrders, openOrders, totalInvoices, unpaidInvoices, outstandingBalance: outstanding[0]?.total || 0, totalFiles } }
    });
  } catch (error) {
    console.error('Get portal stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching portal statistics' });
  }
});

module.exports = router;
