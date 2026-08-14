// Shared helpers for sending messages through Meta's WhatsApp Business Cloud API.
// Used by both payment reminders and invoice sending so there is exactly one
// implementation of the Graph API call instead of divergent copies.

// Cache of phoneNumberId -> human-readable display number (e.g. "+91 90748 02446"), so we don't
// hit the Graph API on every single send just to print a log line.
const displayNumberCache = new Map();
async function getSendingDisplayNumber(waIntegration) {
  if (!waIntegration?.phoneNumberId || !waIntegration?.accessToken) return waIntegration?.phoneNumberId || 'unconfigured';
  if (displayNumberCache.has(waIntegration.phoneNumberId)) {
    return displayNumberCache.get(waIntegration.phoneNumberId);
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/v19.0/${waIntegration.phoneNumberId}?fields=display_phone_number`, {
      headers: { Authorization: `Bearer ${waIntegration.accessToken}` }
    });
    const data = await resp.json();
    const display = data.display_phone_number || waIntegration.phoneNumberId;
    displayNumberCache.set(waIntegration.phoneNumberId, display);
    return display;
  } catch {
    return waIntegration.phoneNumberId;
  }
}

// Helper: Send WhatsApp message via Meta Cloud API.
// `logContext` (e.g. { invoiceNumber }) is only used to make the console output traceable.
async function sendWhatsAppMessage(phoneNumber, message, metaPayload, waIntegration, logContext = {}) {
  const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');
  const fromDisplay = await getSendingDisplayNumber(waIntegration);
  const logPrefix = `📤 [WhatsApp] invoice=${logContext.invoiceNumber || '-'} from=${fromDisplay} to=${phoneNumber || '-'}`;

  if (!cleanPhone) {
    console.log(`${logPrefix} result=FAILED error="Customer phone number is invalid"`);
    return { success: false, status: 'failed', error: 'Customer phone number is invalid' };
  }

  if (!waIntegration?.phoneNumberId || !waIntegration?.accessToken) {
    console.log(`${logPrefix} result=FAILED error="WhatsApp Business API is not configured"`);
    return { success: false, status: 'failed', error: 'WhatsApp Business API is not configured (missing phone number ID or access token)' };
  }

  const body = metaPayload
    ? {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'template',
        template: {
          name: metaPayload.templateName,
          language: { code: metaPayload.languageCode || 'en_US' },
          ...(metaPayload.variables?.length ? { components: [{ type: 'body', parameters: metaPayload.variables }] } : {})
        }
      }
    : {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: message }
      };

  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/${waIntegration.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${waIntegration.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Meta API Send Error:', data);
      console.log(`${logPrefix} template=${metaPayload?.templateName || 'free-text'} result=FAILED error="${data.error?.message || 'Failed to send WhatsApp message via Meta'}"`);
      return { success: false, status: 'failed', error: data.error?.message || 'Failed to send WhatsApp message via Meta' };
    }

    const messageId = data.messages?.[0]?.id;
    console.log(`${logPrefix} template=${metaPayload?.templateName || 'free-text'} result=SUCCESS messageId=${messageId}`);
    return { success: true, status: 'sent', messageId };
  } catch (error) {
    console.error('WhatsApp send error:', error);
    console.log(`${logPrefix} result=FAILED error="${error.message}"`);
    return { success: false, status: 'failed', error: error.message };
  }
}

// Helper: Build Meta template variable components from a mapping (Map or plain object) + context data.
// Meta's {{n}} placeholders are positional (no explicit index sent per param), so a gap must be
// filled with an empty string rather than skipped — skipping would shift every later variable
// into the wrong slot.
function buildTemplateVariables(mapping, contextData) {
  if (!mapping) return [];
  const entries = mapping instanceof Map ? Array.from(mapping.entries()) : Object.entries(mapping);
  const numericKeys = entries.map(([key]) => Number(key)).filter(Number.isFinite);
  if (numericKeys.length === 0) return [];

  const maxKey = Math.max(...numericKeys);
  const valueByKey = new Map(entries.map(([key, contextKey]) => [Number(key), contextKey]));

  const variablesArray = [];
  for (let position = 1; position <= maxKey; position++) {
    const contextKey = valueByKey.get(position);
    variablesArray.push({ type: 'text', text: contextData[contextKey] || '' });
  }
  return variablesArray;
}

module.exports = { getSendingDisplayNumber, sendWhatsAppMessage, buildTemplateVariables };
