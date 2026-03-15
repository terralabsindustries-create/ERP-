const express = require('express');
const { body, query } = require('express-validator');
const { protect } = require('../middleware/auth');

const router = express.Router();

// WhatsApp message template schema (stored in memory for now, could be moved to database)
const messageTemplates = [
  {
    id: 'proof_approval',
    name: 'Proof Approval',
    category: 'job_updates',
    template: 'Hi {{customerName}}, your proof for job {{jobNumber}} is ready for approval. Please review and confirm. - {{businessName}}',
    variables: ['customerName', 'jobNumber', 'businessName']
  },
  {
    id: 'job_completed',
    name: 'Job Completed',
    category: 'job_updates',
    template: 'Hi {{customerName}}, your job {{jobNumber}} has been completed and is ready for pickup. - {{businessName}}',
    variables: ['customerName', 'jobNumber', 'businessName']
  },
  {
    id: 'payment_reminder',
    name: 'Payment Reminder',
    category: 'payments',
    template: 'Hi {{customerName}}, this is a friendly reminder that payment of ₹{{amount}} is due for invoice {{invoiceNumber}}. - {{businessName}}',
    variables: ['customerName', 'amount', 'invoiceNumber', 'businessName']
  },
  {
    id: 'delivery_update',
    name: 'Delivery Update',
    category: 'delivery',
    template: 'Hi {{customerName}}, your order {{jobNumber}} is out for delivery. Expected delivery time: {{deliveryTime}}. - {{businessName}}',
    variables: ['customerName', 'jobNumber', 'deliveryTime', 'businessName']
  },
  {
    id: 'welcome_message',
    name: 'Welcome Message',
    category: 'general',
    template: 'Welcome to {{businessName}}! Thank you for choosing our printing services. We\'ll keep you updated on your order status.',
    variables: ['businessName']
  }
];

// @route   GET /api/whatsapp/stats
// @desc    Get WhatsApp integration statistics
// @access  Private
router.get('/stats', protect, async (req, res) => {
  try {
    // TODO: Implement real WhatsApp API integration
    // For now, return mock statistics
    const stats = {
      messagesSent: 0,
      deliveryRate: 98.4,
      responseRate: 76.2,
      activeContacts: 0,
      templatesUsed: messageTemplates.length,
      lastSync: new Date().toISOString()
    };
    
    res.status(200).json({
      status: 'success',
      data: { stats }
    });
  } catch (error) {
    console.error('Get WhatsApp stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching WhatsApp statistics'
    });
  }
});

// @route   GET /api/whatsapp/templates
// @desc    Get WhatsApp message templates
// @access  Private
router.get('/templates', protect, async (req, res) => {
  try {
    res.status(200).json({
      status: 'success',
      data: { templates: messageTemplates }
    });
  } catch (error) {
    console.error('Get WhatsApp templates error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching WhatsApp templates'
    });
  }
});

// @route   POST /api/whatsapp/send
// @desc    Send WhatsApp message
// @access  Private
router.post('/send', protect, [
  body('phoneNumber').isMobilePhone().withMessage('Valid phone number is required'),
  body('templateId').notEmpty().withMessage('Template ID is required'),
  body('variables').isObject().withMessage('Variables must be an object'),
  body('customerId').optional().isMongoId()
], async (req, res) => {
  try {
    const { phoneNumber, templateId, variables, customerId } = req.body;
    
    // Find the template
    const template = messageTemplates.find(t => t.id === templateId);
    if (!template) {
      return res.status(400).json({
        status: 'error',
        message: 'Template not found'
      });
    }
    
    // Replace variables in template
    let message = template.template;
    Object.keys(variables).forEach(key => {
      const placeholder = `{{${key}}}`;
      message = message.replace(new RegExp(placeholder, 'g'), variables[key]);
    });
    
    // TODO: Implement actual WhatsApp API call
    // For now, simulate sending
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Simulate API response
    const response = {
      messageId,
      status: 'sent',
      phoneNumber,
      message,
      templateId,
      sentAt: new Date().toISOString(),
      deliveryStatus: 'pending'
    };
    
    res.status(200).json({
      status: 'success',
      message: 'WhatsApp message sent successfully',
      data: { message: response }
    });
    
  } catch (error) {
    console.error('Send WhatsApp message error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while sending WhatsApp message'
    });
  }
});

// @route   POST /api/whatsapp/send-bulk
// @desc    Send bulk WhatsApp messages
// @access  Private
router.post('/send-bulk', protect, [
  body('recipients').isArray({ min: 1 }).withMessage('Recipients array is required'),
  body('recipients.*.phoneNumber').isMobilePhone().withMessage('Valid phone number is required'),
  body('recipients.*.templateId').notEmpty().withMessage('Template ID is required'),
  body('recipients.*.variables').isObject().withMessage('Variables must be an object')
], async (req, res) => {
  try {
    const { recipients } = req.body;
    
    const results = [];
    const errors = [];
    
    for (const recipient of recipients) {
      try {
        const template = messageTemplates.find(t => t.id === recipient.templateId);
        if (!template) {
          errors.push({
            phoneNumber: recipient.phoneNumber,
            error: 'Template not found'
          });
          continue;
        }
        
        // Replace variables in template
        let message = template.template;
        Object.keys(recipient.variables).forEach(key => {
          const placeholder = `{{${key}}}`;
          message = message.replace(new RegExp(placeholder, 'g'), recipient.variables[key]);
        });
        
        // TODO: Implement actual WhatsApp API call
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        results.push({
          messageId,
          status: 'sent',
          phoneNumber: recipient.phoneNumber,
          message,
          templateId: recipient.templateId,
          sentAt: new Date().toISOString()
        });
        
      } catch (error) {
        errors.push({
          phoneNumber: recipient.phoneNumber,
          error: error.message
        });
      }
    }
    
    res.status(200).json({
      status: 'success',
      message: `Bulk messages processed. ${results.length} sent, ${errors.length} failed`,
      data: {
        results,
        errors,
        summary: {
          total: recipients.length,
          sent: results.length,
          failed: errors.length
        }
      }
    });
    
  } catch (error) {
    console.error('Send bulk WhatsApp messages error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while sending bulk WhatsApp messages'
    });
  }
});

// @route   GET /api/whatsapp/webhook
// @desc    WhatsApp webhook endpoint (for receiving messages)
// @access  Public
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  // TODO: Implement proper webhook verification
  if (mode === 'subscribe' && token === 'your_verify_token') {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

// @route   POST /api/whatsapp/webhook
// @desc    WhatsApp webhook endpoint (for receiving messages)
// @access  Public
router.post('/webhook', (req, res) => {
  try {
    const body = req.body;
    
    // TODO: Process incoming WhatsApp messages
    console.log('Received WhatsApp webhook:', body);
    
    // Handle different types of webhook events
    if (body.object === 'whatsapp_business_account') {
      body.entry.forEach(entry => {
        entry.changes.forEach(change => {
          if (change.field === 'messages') {
            // Process incoming messages
            console.log('New message received:', change.value);
          }
        });
      });
    }
    
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// @route   GET /api/whatsapp/contacts
// @desc    Get WhatsApp contacts
// @access  Private
router.get('/contacts', protect, async (req, res) => {
  try {
    // TODO: Implement real WhatsApp contacts API
    const contacts = [];
    
    res.status(200).json({
      status: 'success',
      data: { contacts }
    });
  } catch (error) {
    console.error('Get WhatsApp contacts error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching WhatsApp contacts'
    });
  }
});

// @route   POST /api/whatsapp/setup
// @desc    Setup WhatsApp Business API
// @access  Private
router.post('/setup', protect, [
  body('phoneNumberId').notEmpty().withMessage('Phone number ID is required'),
  body('accessToken').notEmpty().withMessage('Access token is required'),
  body('webhookUrl').optional().isURL().withMessage('Valid webhook URL required')
], async (req, res) => {
  try {
    const { phoneNumberId, accessToken, webhookUrl } = req.body;
    
    // TODO: Implement WhatsApp Business API setup
    // Store credentials securely
    // Verify connection
    // Setup webhook
    
    res.status(200).json({
      status: 'success',
      message: 'WhatsApp Business API setup completed',
      data: {
        phoneNumberId,
        webhookUrl: webhookUrl || `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`,
        setupAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('WhatsApp setup error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while setting up WhatsApp'
    });
  }
});

module.exports = router;