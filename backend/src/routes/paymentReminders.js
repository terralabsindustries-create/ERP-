const express = require('express');
const { body, query } = require('express-validator');
const { protect } = require('../middleware/auth');
const PaymentReminder = require('../models/PaymentReminder');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Settings = require('../models/Settings');
const { sendWhatsAppMessage, buildTemplateVariables } = require('../utils/metaWhatsApp');
const { staffScopeQuery } = require('../utils/dataScopeHelper');

const router = express.Router();

// Helper: Build message from template
function buildMessage(template, variables) {
  let message = template;
  Object.keys(variables).forEach(key => {
    const placeholder = `{{${key}}}`;
    message = message.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), variables[key]);
  });
  return message;
}

// Helper: Format date for display
function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Helper: Calculate days overdue
function calculateDaysOverdue(dueDate) {
  const now = new Date();
  const due = new Date(dueDate);
  const diffTime = now.getTime() - due.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

// Shared: build the message for one invoice+customer using this user's settings (with an optional
// per-send template override), send it, persist a PaymentReminder record, and flip the invoice to
// overdue if needed. Used by both routes below AND by the auto-send cron in server.js, so there is
// exactly one real send implementation instead of separate (and previously fake) copies.
async function buildAndSendReminder({ invoice, customer, settings, userId, dataScope, reminderCount, templateOverride = {} }) {
  const daysOverdue = calculateDaysOverdue(invoice.dueDate);
  const reminderConfig = settings.paymentReminders || {};
  const contextData = {
    customerName: invoice.customerName,
    invoiceNumber: invoice.invoiceNumber,
    totalAmount: invoice.totalAmount.toLocaleString('en-IN'),
    balanceAmount: invoice.balanceAmount.toLocaleString('en-IN'),
    dueDate: formatDate(invoice.dueDate),
    daysOverdue: daysOverdue.toString(),
    businessName: settings.companyName || 'Our Company'
  };

  // Template selected at send time takes priority over the saved default.
  // templateOverride.metaTemplateName === '' means the caller explicitly chose free text.
  const effectiveTemplateName = templateOverride.metaTemplateName !== undefined ? templateOverride.metaTemplateName : reminderConfig.metaTemplateName;
  const effectiveMapping = templateOverride.templateVariableMapping !== undefined ? templateOverride.templateVariableMapping : reminderConfig.templateVariableMapping;

  let messageContent = '';
  let metaPayload = null;

  if (effectiveTemplateName && settings.whatsappIntegration?.enabled) {
    const variablesArray = buildTemplateVariables(effectiveMapping, contextData);
    messageContent = `[Meta Template: ${effectiveTemplateName}]`;
    metaPayload = {
      templateName: effectiveTemplateName,
      languageCode: templateOverride.metaTemplateLanguage,
      variables: variablesArray
    };
  } else {
    const template = reminderConfig.messageTemplate ||
      'Hi {{customerName}}, this is a friendly reminder that your invoice {{invoiceNumber}} of ₹{{totalAmount}} has a pending balance of ₹{{balanceAmount}}. The payment was due on {{dueDate}}. Please make the payment at your earliest convenience. - {{businessName}}';
    messageContent = buildMessage(template, contextData);
  }

  let reminderType = 'manual';
  if (invoice.paymentStatus === 'overdue' || daysOverdue > 0) {
    reminderType = 'overdue';
  } else if (invoice.paymentStatus === 'partial') {
    reminderType = 'partial';
  }

  const whatsappResult = await sendWhatsAppMessage(customer.phone, messageContent, metaPayload, settings.whatsappIntegration, { invoiceNumber: invoice.invoiceNumber });

  const reminder = await PaymentReminder.create({
    invoiceId: invoice._id,
    customerId: customer._id,
    customerName: invoice.customerName,
    customerPhone: customer.phone,
    invoiceNumber: invoice.invoiceNumber,
    totalAmount: invoice.totalAmount,
    balanceAmount: invoice.balanceAmount,
    dueDate: invoice.dueDate,
    daysOverdue,
    reminderType,
    messageContent,
    status: whatsappResult.success ? 'sent' : 'failed',
    sentAt: whatsappResult.success ? new Date() : undefined,
    failureReason: whatsappResult.success ? undefined : (whatsappResult.error || 'WhatsApp API error'),
    reminderCount: reminderCount + 1,
    whatsappMessageId: whatsappResult.messageId,
    userId,
    dataScope
  });

  if (daysOverdue > 0 && invoice.paymentStatus !== 'overdue') {
    invoice.paymentStatus = 'overdue';
    await invoice.save();
  }

  return { reminder, whatsappResult };
}

// @route   GET /api/payment-reminders/stats
// @desc    Get payment reminder statistics
// @access  Private
router.get('/stats', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const dataScope = req.user.dataScope;

    // Build query for invoices
    const invoiceQuery = {
      ...staffScopeQuery(req.user),
      paymentStatus: { $in: ['pending', 'partial', 'overdue'] }
    };

    // Get overdue invoices (past due date)
    const now = new Date();
    const overdueInvoices = await Invoice.countDocuments({
      ...invoiceQuery,
      dueDate: { $lt: now },
      status: { $nin: ['cancelled', 'refunded'] }
    });

    // Get total outstanding amount
    const outstandingAgg = await Invoice.aggregate([
      {
        $match: {
          ...staffScopeQuery(req.user),
          paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
          dueDate: { $lt: now },
          status: { $nin: ['cancelled', 'refunded'] }
        }
      },
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: '$balanceAmount' },
          uniqueCustomers: { $addToSet: '$customerId' }
        }
      }
    ]);

    // Get reminder stats
    const reminderQuery = dataScope ? { dataScope } : { userId };
    const reminderStats = await PaymentReminder.getReminderStats(userId, dataScope);

    // Count sent today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const sentToday = await PaymentReminder.countDocuments({
      ...reminderQuery,
      createdAt: { $gte: today, $lt: tomorrow }
    });

    // Total reminders sent
    const totalSent = await PaymentReminder.countDocuments({
      ...reminderQuery,
      status: { $in: ['sent', 'delivered'] }
    });

    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          overdueInvoices,
          totalOutstanding: outstandingAgg[0]?.totalOutstanding || 0,
          customersNeedingReminder: outstandingAgg[0]?.uniqueCustomers?.length || 0,
          sentToday,
          totalSent,
          reminderBreakdown: reminderStats.total
        }
      }
    });
  } catch (error) {
    console.error('Get payment reminder stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching payment reminder statistics'
    });
  }
});

// @route   GET /api/payment-reminders/overdue-invoices
// @desc    Get all overdue/partial invoices eligible for reminders
// @access  Private
router.get('/overdue-invoices', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const dataScope = req.user.dataScope;
    const now = new Date();

    // Get settings for reminder configuration
    const settings = await Settings.getOrCreateSettings(userId);
    const reminderConfig = settings.paymentReminders || {};
    const maxReminders = reminderConfig.maxReminders || 5;

    // Build query
    const invoiceQuery = staffScopeQuery(req.user);

    // Find overdue invoices
    const invoices = await Invoice.find({
      ...invoiceQuery,
      paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
      dueDate: { $lt: now },
      status: { $nin: ['cancelled', 'refunded'] },
      balanceAmount: { $gt: 0 }
    })
    .populate('customerId', 'name phone email whatsappConsent')
    .sort({ dueDate: 1 });

    // Enrich with reminder info
    const enrichedInvoices = await Promise.all(invoices.map(async (invoice) => {
      const reminderCount = await PaymentReminder.getReminderCountForInvoice(invoice._id, userId);
      const lastReminderDate = await PaymentReminder.getLastReminderDate(invoice._id, userId);
      const daysOverdue = calculateDaysOverdue(invoice.dueDate);
      
      // Determine if eligible for reminder
      const daysAfterDue = reminderConfig.daysAfterDue || 1;
      const reminderInterval = reminderConfig.reminderInterval || 3;
      
      let canSendReminder = true;
      if (reminderCount >= maxReminders) {
        canSendReminder = false;
      } else if (lastReminderDate) {
        const daysSinceLastReminder = calculateDaysOverdue(lastReminderDate);
        if (daysSinceLastReminder < reminderInterval) {
          canSendReminder = false;
        }
      } else if (daysOverdue < daysAfterDue) {
        canSendReminder = false;
      }

      return {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customerId?._id || invoice.customerId,
        customerName: invoice.customerName,
        customerPhone: invoice.customerId?.phone || '',
        customerEmail: invoice.customerId?.email || '',
        whatsappConsent: invoice.customerId?.whatsappConsent !== false,
        totalAmount: invoice.totalAmount,
        paidAmount: invoice.paidAmount,
        balanceAmount: invoice.balanceAmount,
        dueDate: invoice.dueDate,
        daysOverdue,
        paymentStatus: invoice.paymentStatus,
        reminderCount,
        lastReminderDate,
        canSendReminder,
        maxRemindersReached: reminderCount >= maxReminders
      };
    }));

    res.status(200).json({
      status: 'success',
      data: {
        invoices: enrichedInvoices,
        total: enrichedInvoices.length,
        eligibleForReminder: enrichedInvoices.filter(i => i.canSendReminder).length
      }
    });
  } catch (error) {
    console.error('Get overdue invoices error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching overdue invoices'
    });
  }
});

// @route   GET /api/payment-reminders
// @desc    Get all payment reminders (history)
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const dataScope = req.user.dataScope;
    const { status, customerId, startDate, endDate, page = 1, limit = 20 } = req.query;

    const query = dataScope ? { dataScope } : { userId };

    if (status) query.status = status;
    if (customerId) query.customerId = customerId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [reminders, total] = await Promise.all([
      PaymentReminder.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('customerId', 'name phone email')
        .populate('invoiceId', 'invoiceNumber totalAmount balanceAmount'),
      PaymentReminder.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        reminders,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get payment reminders error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching payment reminders'
    });
  }
});

// @route   POST /api/payment-reminders/send/:invoiceId
// @desc    Send a payment reminder for a specific invoice
// @access  Private
router.post('/send/:invoiceId', protect, [
  body('metaTemplateName').optional({ nullable: true }).isString(),
  body('metaTemplateLanguage').optional({ nullable: true }).isString(),
  body('templateVariableMapping').optional({ nullable: true }).isObject()
], async (req, res) => {
  try {
    const userId = req.user._id;
    const dataScope = req.user.dataScope;
    const { invoiceId } = req.params;
    // Allow picking/overriding the template at send time instead of only using the saved default
    const { metaTemplateName: overrideTemplateName, metaTemplateLanguage, templateVariableMapping: overrideMapping } = req.body || {};

    // Get the invoice — the scope doubles as the ownership check
    const invoice = await Invoice.findOne({ _id: invoiceId, ...staffScopeQuery(req.user) })
      .populate('customerId', 'name phone email whatsappConsent');
    if (!invoice) {
      return res.status(404).json({ status: 'error', message: 'Invoice not found' });
    }

    // Check if balance exists
    if (invoice.balanceAmount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invoice is already fully paid' });
    }

    // Get customer phone
    const customer = await Customer.findById(invoice.customerId?._id || invoice.customerId);
    const customerPhone = customer?.phone;
    
    if (!customerPhone) {
      return res.status(400).json({
        status: 'error',
        message: 'Customer does not have a phone number on file'
      });
    }

    // Get settings for template
    const settings = await Settings.getOrCreateSettings(userId);
    const reminderConfig = settings.paymentReminders || {};
    const maxReminders = reminderConfig.maxReminders || 5;

    // Check reminder count
    const reminderCount = await PaymentReminder.getReminderCountForInvoice(invoiceId, userId);
    if (reminderCount >= maxReminders) {
      return res.status(400).json({
        status: 'error',
        message: `Maximum reminders (${maxReminders}) already sent for this invoice`
      });
    }

    const { reminder, whatsappResult } = await buildAndSendReminder({
      invoice,
      customer,
      settings,
      userId,
      dataScope,
      reminderCount,
      templateOverride: {
        metaTemplateName: overrideTemplateName,
        metaTemplateLanguage,
        templateVariableMapping: overrideMapping
      }
    });

    if (!whatsappResult.success) {
      return res.status(400).json({
        status: 'error',
        message: `Failed to send WhatsApp reminder: ${whatsappResult.error || 'WhatsApp API error'}`,
        data: { reminder }
      });
    }

    res.status(200).json({
      status: 'success',
      message: `Payment reminder sent for invoice ${invoice.invoiceNumber}`,
      data: { reminder }
    });
  } catch (error) {
    console.error('Send payment reminder error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while sending payment reminder'
    });
  }
});

// @route   POST /api/payment-reminders/send-bulk
// @desc    Send reminders for all eligible overdue invoices
// @access  Private
router.post('/send-bulk', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const dataScope = req.user.dataScope;
    const now = new Date();

    // Get settings
    const settings = await Settings.getOrCreateSettings(userId);
    const reminderConfig = settings.paymentReminders || {};
    const maxReminders = reminderConfig.maxReminders || 5;
    const daysAfterDue = reminderConfig.daysAfterDue || 1;
    const reminderInterval = reminderConfig.reminderInterval || 3;

    // Build query
    const invoiceQuery = staffScopeQuery(req.user);

    // Find eligible invoices
    const invoices = await Invoice.find({
      ...invoiceQuery,
      paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
      dueDate: { $lt: now },
      status: { $nin: ['cancelled', 'refunded'] },
      balanceAmount: { $gt: 0 }
    }).populate('customerId', 'name phone email whatsappConsent');

    const results = { sent: 0, failed: 0, skipped: 0, details: [] };

    for (const invoice of invoices) {
      try {
        const customer = await Customer.findById(invoice.customerId?._id || invoice.customerId);
        const customerPhone = customer?.phone;
        const daysOverdue = calculateDaysOverdue(invoice.dueDate);

        // Skip conditions
        if (!customerPhone) {
          results.skipped++;
          results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: 'No phone number' });
          continue;
        }

        if (customer?.whatsappConsent === false) {
          results.skipped++;
          results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: 'WhatsApp consent denied' });
          continue;
        }

        if (daysOverdue < daysAfterDue) {
          results.skipped++;
          results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: 'Not yet eligible (days threshold)' });
          continue;
        }

        const reminderCount = await PaymentReminder.getReminderCountForInvoice(invoice._id, userId);
        if (reminderCount >= maxReminders) {
          results.skipped++;
          results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: 'Max reminders reached' });
          continue;
        }

        const lastReminderDate = await PaymentReminder.getLastReminderDate(invoice._id, userId);
        if (lastReminderDate) {
          const daysSinceLastReminder = calculateDaysOverdue(lastReminderDate);
          if (daysSinceLastReminder < reminderInterval) {
            results.skipped++;
            results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: 'Too soon since last reminder' });
            continue;
          }
        }

        const { whatsappResult } = await buildAndSendReminder({
          invoice,
          customer,
          settings,
          userId,
          dataScope,
          reminderCount
        });

        if (whatsappResult.success) {
          results.sent++;
        } else {
          results.failed++;
          results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: whatsappResult.error || 'WhatsApp API error' });
        }

      } catch (err) {
        console.error(`Error sending reminder for invoice ${invoice.invoiceNumber}:`, err);
        results.failed++;
        results.details.push({ invoiceNumber: invoice.invoiceNumber, reason: err.message });
      }
    }

    res.status(200).json({
      status: 'success',
      message: `Bulk reminders processed: ${results.sent} sent, ${results.failed} failed, ${results.skipped} skipped`,
      data: { results }
    });
  } catch (error) {
    console.error('Send bulk payment reminders error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while sending bulk payment reminders'
    });
  }
});

// @route   GET /api/payment-reminders/settings
// @desc    Get payment reminder settings
// @access  Private
router.get('/settings', protect, async (req, res) => {
  try {
    const settings = await Settings.getOrCreateSettings(req.user._id);
    // .paymentReminders is a raw nested path, not a subdocument — accessing it directly bypasses
    // the document's toJSON/flattenMaps, so templateVariableMapping (a Map) would serialize to
    // "{}" in the response even though it's saved correctly. Go through toObject() to flatten it.
    const paymentReminderSettings = settings.toObject({ flattenMaps: true }).paymentReminders;

    res.status(200).json({
      status: 'success',
      data: {
        settings: paymentReminderSettings || {
          enabled: false,
          daysAfterDue: 1,
          reminderInterval: 3,
          maxReminders: 5,
          messageTemplate: 'Hi {{customerName}}, this is a friendly reminder that your invoice {{invoiceNumber}} of ₹{{totalAmount}} has a pending balance of ₹{{balanceAmount}}. The payment was due on {{dueDate}}. Please make the payment at your earliest convenience. - {{businessName}}',
          autoSend: false
        }
      }
    });
  } catch (error) {
    console.error('Get payment reminder settings error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching payment reminder settings'
    });
  }
});

// @route   PUT /api/payment-reminders/settings
// @desc    Update payment reminder settings
// @access  Private
router.put('/settings', protect, [
  body('enabled').optional().isBoolean(),
  body('daysAfterDue').optional().isInt({ min: 0 }),
  body('reminderInterval').optional().isInt({ min: 1 }),
  body('maxReminders').optional().isInt({ min: 1, max: 20 }),
  body('messageTemplate').optional().isString(),
  body('autoSend').optional().isBoolean(),
  body('metaTemplateName').optional().isString(),
  body('templateVariableMapping').optional().isObject()
], async (req, res) => {
  try {
    const { enabled, daysAfterDue, reminderInterval, maxReminders, messageTemplate, autoSend, metaTemplateName, templateVariableMapping } = req.body;

    const updateData = {};
    if (enabled !== undefined) updateData['paymentReminders.enabled'] = enabled;
    if (daysAfterDue !== undefined) updateData['paymentReminders.daysAfterDue'] = daysAfterDue;
    if (reminderInterval !== undefined) updateData['paymentReminders.reminderInterval'] = reminderInterval;
    if (maxReminders !== undefined) updateData['paymentReminders.maxReminders'] = maxReminders;
    if (messageTemplate !== undefined) updateData['paymentReminders.messageTemplate'] = messageTemplate;
    if (autoSend !== undefined) updateData['paymentReminders.autoSend'] = autoSend;
    if (metaTemplateName !== undefined) updateData['paymentReminders.metaTemplateName'] = metaTemplateName;
    if (templateVariableMapping !== undefined) updateData['paymentReminders.templateVariableMapping'] = templateVariableMapping;

    const settings = await Settings.findOneAndUpdate(
      { userId: req.user._id },
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );

    res.status(200).json({
      status: 'success',
      message: 'Payment reminder settings updated successfully',
      data: { settings: settings.toObject({ flattenMaps: true }).paymentReminders }
    });
  } catch (error) {
    console.error('Update payment reminder settings error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating payment reminder settings'
    });
  }
});

module.exports = router;
// Exposed so the auto-send cron in server.js reuses the real send logic instead of its own copy.
module.exports.buildAndSendReminder = buildAndSendReminder;
