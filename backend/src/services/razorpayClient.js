const Razorpay = require('razorpay');

/*
  Lazily built so the keys are read from the environment when first needed (and
  so tests can swap the client). The key secret never leaves this module.
*/
let override = null;
let cached = null;

const PLACEHOLDER_ID = 'rzp_test_1D5C4F7B8E9A0B1C';
const PLACEHOLDER_SECRET = 'your_test_secret';

const keyId = () => process.env.RAZORPAY_KEY_ID || '';
const keySecret = () => process.env.RAZORPAY_KEY_SECRET || '';
const webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET || '';

const isConfigured = () => {
  const id = keyId();
  const secret = keySecret();
  return !!(id && secret && id !== PLACEHOLDER_ID && secret !== PLACEHOLDER_SECRET);
};

const getClient = () => {
  if (override) return override;
  if (!cached) cached = new Razorpay({ key_id: keyId(), key_secret: keySecret() });
  return cached;
};

const setClientForTests = (client) => { override = client; cached = null; };

module.exports = { getClient, setClientForTests, isConfigured, keyId, keySecret, webhookSecret };
