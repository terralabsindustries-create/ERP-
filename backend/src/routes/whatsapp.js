const express = require('express');
const crypto = require('crypto');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { protect } = require('../middleware/auth');
const PaymentReminder = require('../models/PaymentReminder');

const router = express.Router();

// Apply a Meta message status callback ('sent' | 'delivered' | 'read' | 'failed') to whichever
// PaymentReminder we sent with that WhatsApp message ID.
async function applyWhatsAppStatusUpdate(status) {
  const messageId = status?.id;
  const metaStatus = status?.status;
  if (!messageId || !metaStatus) return;

  const update = {};
  if (metaStatus === 'delivered' || metaStatus === 'read') {
    update.status = 'delivered';
    update.deliveredAt = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();
  } else if (metaStatus === 'failed') {
    update.status = 'failed';
    update.failureReason = status.errors?.[0]?.title || status.errors?.[0]?.message || 'Message delivery failed';
  } else {
    // 'sent' is already recorded synchronously when we make the send call — nothing to do
    return;
  }

  try {
    await PaymentReminder.updateOne({ whatsappMessageId: messageId }, { $set: update });
  } catch (error) {
    console.error('Failed to apply WhatsApp status update:', error);
  }
}

// @route   POST /api/whatsapp/send
// @desc    Send WhatsApp message
// @access  Private
router.post('/send', protect, [
  body('phoneNumber').matches(/^\+?[\d\s()-]{7,20}$/).withMessage('Enter a valid phone number'),
  body('templateId').notEmpty().withMessage('Template ID is required'),
  body('variables').isObject().withMessage('Variables must be an object'),
  body('customerId').optional({ values: 'falsy' }).isMongoId()
], validate, async (req, res) => {
  try {
    const { phoneNumber, templateId, variables, customerId, language } = req.body;
    
    const settings = await Settings.findOne({ userId: await settingsOwnerId(req.user) });
    const { wabaId, phoneNumberId, accessToken } = settings?.whatsappIntegration || {};
    
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp API credentials are not configured.' });
    }

    // Prepare components if variables exist
    const components = [];
    if (variables && Object.keys(variables).length > 0) {
      // {{1}}, {{2}}… in order, whatever order the keys arrived in
      const parameters = Object.keys(variables)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => ({ type: "text", text: String(variables[k]) }));
      components.push({
        type: "body",
        parameters
      });
    }

    // Call Meta API
    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phoneNumber.replace(/[^0-9]/g, ''), // Strip non-numeric chars
        type: "template",
        template: {
          name: templateId,
          language: { code: typeof language === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(language) ? language : "en_US" },
          ...(components.length > 0 && { components })
        }
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('Meta API Send Error:', data);
      return res.status(400).json({ status: 'error', message: data.error?.message || 'Failed to send message via Meta' });
    }
    
    res.status(200).json({
      status: 'success',
      message: 'WhatsApp message sent successfully',
      data: { messageId: data.messages?.[0]?.id }
    });
    
  } catch (error) {
    console.error('Send WhatsApp message error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while sending WhatsApp message'
    });
  }
});

// @route   GET /api/whatsapp/webhook
// @desc    WhatsApp webhook endpoint (for receiving messages)
// @access  Public
router.get('/webhook', (req, res) => {
  // express-mongo-sanitize (applied globally) strips any query key containing a dot, which wipes
  // out Meta's hub.* verification params before they reach req.query. Meta's handshake always
  // sends these exact fixed keys by protocol, so read them straight from the raw query string.
  const rawQuery = new URLSearchParams(req.url.split('?')[1] || '');
  const mode = rawQuery.get('hub.mode');
  const token = rawQuery.get('hub.verify_token');
  const challenge = rawQuery.get('hub.challenge');

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '14551411';
  
  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

// @route   POST /api/whatsapp/webhook
// @desc    WhatsApp webhook endpoint (for receiving messages)
// @access  Public
router.post('/webhook', async (req, res) => {
  // Meta signs every webhook with the app secret (X-Hub-Signature-256). Without
  // this check anyone could post fake delivery/read updates.
  const secret = process.env.FACEBOOK_APP_SECRET;
  if (secret) {
    const given = String(req.get('x-hub-signature-256') || '');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
    const valid = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!valid) {
      console.warn('WhatsApp webhook ignored: signature does not match FACEBOOK_APP_SECRET');
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  // Acknowledge immediately — Meta retries aggressively (and eventually disables the webhook)
  // if it doesn't get a fast 200, so processing happens after the response is sent.
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};

        // Delivery/read/failed status callbacks for messages we sent
        for (const status of value.statuses || []) {
          await applyWhatsAppStatusUpdate(status);
        }

        // Inbound messages from customers replying — not yet acted on beyond logging
        for (const message of value.messages || []) {
          console.log('New WhatsApp message received:', message);
        }
      }
    }
  } catch (error) {
    console.error('WhatsApp webhook processing error:', error);
  }
});

const Settings = require('../models/Settings');
const { settingsOwnerId, businessSettings } = require('../utils/businessSettings');

// @route   GET /api/whatsapp/settings
// @desc    Get WhatsApp Business API settings
// @access  Private
router.get('/settings', protect, async (req, res) => {
  try {
    const settings = await businessSettings(req.user);
    // The Meta access token never leaves the server; the page only needs to know one is saved.
    const { accessToken, ...integration } = settings.toObject({ flattenMaps: true }).whatsappIntegration || {};
    res.status(200).json({
      status: 'success',
      data: { settings: { ...integration, hasAccessToken: !!accessToken } }
    });
  } catch (error) {
    console.error('Get WhatsApp settings error:', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// @route   POST /api/whatsapp/settings
// @desc    Setup WhatsApp Business API settings
// @access  Private
router.post('/settings', protect, [
  body('enabled').optional({ values: 'falsy' }).isBoolean(),
  body('wabaId').optional({ values: 'falsy' }).isString(),
  body('phoneNumberId').optional({ values: 'falsy' }).isString(),
  body('accessToken').optional({ values: 'falsy' }).isString()
], validate, async (req, res) => {
  try {
    const { enabled, wabaId, phoneNumberId, accessToken } = req.body;
    
    const updateData = {};
    if (enabled !== undefined) updateData['whatsappIntegration.enabled'] = enabled;
    if (wabaId !== undefined) updateData['whatsappIntegration.wabaId'] = wabaId;
    if (phoneNumberId !== undefined) updateData['whatsappIntegration.phoneNumberId'] = phoneNumberId;
    // An empty token means "keep the saved one".
    if (accessToken) updateData['whatsappIntegration.accessToken'] = accessToken;
    
    const settings = await Settings.findOneAndUpdate(
      { userId: await settingsOwnerId(req.user) },
      { $set: updateData },
      { new: true, upsert: true }
    );
    
    res.status(200).json({
      status: 'success',
      message: 'WhatsApp Business API settings updated',
      data: { settings: { ...(({ accessToken: token, ...rest }) => ({ ...rest, hasAccessToken: !!token }))(settings.toObject({ flattenMaps: true }).whatsappIntegration || {}) } }
    });
  } catch (error) {
    console.error('WhatsApp setup error:', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// @route   GET /api/whatsapp/meta-templates
// @desc    Fetch templates from Meta Graph API
// @access  Private
router.get('/meta-templates', protect, async (req, res) => {
  try {
    const settings = await Settings.findOne({ userId: await settingsOwnerId(req.user) });
    const { wabaId, accessToken } = settings?.whatsappIntegration || {};
    
    if (!wabaId || !accessToken) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp Business API credentials not configured.' });
    }

    // Meta Graph API Bug: If you don't explicitly request fields, it sometimes throws an "Object does not exist" error for System Users
    const fields = 'name,status,category,language,components,id';
    const response = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=${fields}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Meta API Error (Fetch Templates):', data);
      return res.status(400).json({ status: 'error', message: data.error?.message || 'Failed to fetch templates from Meta' });
    }

    res.status(200).json({
      status: 'success',
      data: { templates: data.data || [] }
    });
  } catch (error) {
    console.error('Fetch Meta templates error:', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// @route   POST /api/whatsapp/meta-templates
// @desc    Create a new template via Meta Graph API
// @access  Private
router.post('/meta-templates', protect, [
  body('name').notEmpty().withMessage('Template name is required'),
  body('language').notEmpty().withMessage('Language is required'),
  body('category').notEmpty().withMessage('Category is required'),
  body('components').isArray().withMessage('Components must be an array')
], validate, async (req, res) => {
  try {
    const settings = await Settings.findOne({ userId: await settingsOwnerId(req.user) });
    const { wabaId, accessToken } = settings?.whatsappIntegration || {};
    
    if (!wabaId || !accessToken) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp credentials not configured.' });
    }

    const { name, language, category, components } = req.body;

    const response = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/message_templates`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, language, category, components })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Meta API Error (Create Template):', data);
      return res.status(400).json({ status: 'error', message: data.error?.error_user_msg || data.error?.message || 'Failed to create template' });
    }

    res.status(200).json({
      status: 'success',
      message: 'Template created successfully',
      data: { templateId: data.id }
    });
  } catch (error) {
    console.error('Create Meta template error:', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// @route   DELETE /api/whatsapp/meta-templates/:name
// @desc    Delete a template via Meta Graph API
// @access  Private
router.delete('/meta-templates/:name', protect, async (req, res) => {
  try {
    const settings = await Settings.findOne({ userId: await settingsOwnerId(req.user) });
    const { wabaId, accessToken } = settings?.whatsappIntegration || {};
    
    if (!wabaId || !accessToken) {
      return res.status(400).json({ status: 'error', message: 'WhatsApp credentials not configured.' });
    }

    const templateName = req.params.name;

    const response = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/message_templates?name=${templateName}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Meta API Error (Delete Template):', data);
      return res.status(400).json({ status: 'error', message: data.error?.message || 'Failed to delete template' });
    }

    res.status(200).json({
      status: 'success',
      message: 'Template deleted successfully'
    });
  } catch (error) {
    console.error('Delete Meta template error:', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

module.exports = router;