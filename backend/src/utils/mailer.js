const nodemailer = require('nodemailer');

// Values shipped in .env.example / the setup guide. If they're still in place,
// the SMTP server will reject them with a confusing 535 BadCredentials, so we
// treat them as "not configured" and say so up front.
const PLACEHOLDER_PATTERN = /^(your[-.]|xxxx)/i;

// The product name people see on system mail (invitations, codes).
const PRODUCT_SENDER_NAME = 'Carbon';
// Names left over from before the rebrand, e.g. EMAIL_FROM="SerpY ERP" <…> or
// COMPANY_NAME=SerpY on older installations. Never shown to anyone again.
const LEGACY_SENDER_NAME = /serpy/i;

const isPlaceholder = (value) => !value || PLACEHOLDER_PATTERN.test(value);

// Gmail App Passwords are displayed as "xxxx xxxx xxxx xxxx" but must be sent
// without the spaces.
const getCredentials = () => ({
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS ? process.env.EMAIL_PASS.replace(/\s+/g, '') : ''
});

const isEmailConfigured = () => {
  const { user, pass } = getCredentials();
  return !isPlaceholder(user) && !isPlaceholder(pass);
};

class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      'Email is not configured. Set EMAIL_USER to a real mailbox and EMAIL_PASS ' +
      'to a Gmail App Password (https://myaccount.google.com/apppasswords) in ' +
      'backend/.env, then restart the server. See EMAIL_SETUP_GUIDE.md.'
    );
    this.name = 'EmailNotConfiguredError';
    this.code = 'EMAIL_NOT_CONFIGURED';
  }
}

const createTransporter = () => {
  const { user, pass } = getCredentials();

  if (!isEmailConfigured()) {
    throw new EmailNotConfiguredError();
  }

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: { user, pass },
    // Nodemailer waits up to two minutes by default. The browser gives up after
    // 30 seconds, so an unreachable mail server must fail well before that and
    // be reported, not leave the admin looking at a timeout.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
};

/**
 * The From header. The mailbox is always the verified one (EMAIL_FROM's
 * address, else EMAIL_USER); only the display name varies: "Carbon" for
 * system mail, the business's own name for mail it sends to its customers.
 * Returned in nodemailer's { name, address } form so a name containing quotes
 * or non-ASCII characters is encoded correctly.
 */
const getFromAddress = (displayName = PRODUCT_SENDER_NAME) => {
  const configured = process.env.EMAIL_FROM;
  const address = configured && !isPlaceholder(configured)
    ? (configured.match(/<([^<>]+)>/)?.[1] || configured).trim()
    : process.env.EMAIL_USER;
  const name = String(displayName || '').replace(/[\r\n]+/g, ' ').trim();
  return {
    name: name && !LEGACY_SENDER_NAME.test(name) ? name : PRODUCT_SENDER_NAME,
    address
  };
};

const CONNECTION_ERRORS = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETLS'
]);

/**
 * Turns an SMTP/config failure into something an admin can act on:
 * { status, code, message }. The message never contains server internals.
 */
const describeMailError = (error = {}) => {
  const text = `${error.response || ''} ${error.message || ''}`;

  if (error.code === 'EMAIL_NOT_CONFIGURED') {
    return { status: 503, code: 'EMAIL_NOT_CONFIGURED', message: 'Email is not set up on the server yet.' };
  }
  if (error.code === 'EAUTH') {
    return { status: 503, code: 'EMAIL_AUTH_FAILED', message: "The server's email account refused to sign in, so nothing could be sent." };
  }
  if (/5\.4\.5|sending (limit|quota)|limit exceeded|quota exceeded/i.test(text)) {
    return { status: 503, code: 'EMAIL_QUOTA_EXCEEDED', message: 'The email account has reached its daily sending limit. Try again later.' };
  }
  const recipientRejected =
    error.code === 'EENVELOPE' ||
    (error.command === 'RCPT TO' && error.responseCode >= 500) ||
    (Array.isArray(error.rejected) && error.rejected.length > 0);
  if (recipientRejected) {
    return { status: 422, code: 'EMAIL_RECIPIENT_REJECTED', message: 'The mail server refused the email address. Check it for typos.' };
  }
  if (CONNECTION_ERRORS.has(error.code)) {
    return { status: 503, code: 'EMAIL_UNREACHABLE', message: 'The mail server could not be reached. Try again in a few minutes.' };
  }
  if (error.responseCode >= 400 && error.responseCode < 500) {
    return { status: 503, code: 'EMAIL_TEMPORARY_FAILURE', message: 'The mail server is busy and did not accept the email. Try again in a few minutes.' };
  }
  return { status: 502, code: 'EMAIL_SEND_FAILED', message: 'The mail server did not accept the email.' };
};

const logMailError = (action, error) => {
  if (error.code === 'EAUTH') {
    console.error(
      `❌ ${action} failed: SMTP rejected the credentials for ${process.env.EMAIL_USER}. ` +
      'For Gmail, EMAIL_PASS must be a 16-character App Password (2-Step Verification ' +
      'must be enabled), not the account password.'
    );
  } else if (error.code === 'EMAIL_NOT_CONFIGURED') {
    console.error(`❌ ${action} failed:`, error.message);
  } else {
    console.error(`❌ ${action} failed:`, error.code || '', error.responseCode || '', error.response || error.message);
  }
};

// Maps an SMTP/config failure onto an HTTP response. Never leaks stack traces.
// `options.message` replaces the default wording (it should include the reason
// from describeMailError); `options.data` adds fields to the body.
const sendMailErrorResponse = (res, error, action, options = {}) => {
  logMailError(action, error);
  const described = describeMailError(error);
  return res.status(described.status).json({
    status: 'error',
    code: described.code,
    message: options.message || described.message,
    ...(options.data ? { data: options.data } : {})
  });
};

module.exports = {
  PRODUCT_SENDER_NAME,
  createTransporter,
  isEmailConfigured,
  getFromAddress,
  describeMailError,
  logMailError,
  sendMailErrorResponse,
  EmailNotConfiguredError
};
