const nodemailer = require('nodemailer');

// Values shipped in .env.example / the setup guide. If they're still in place,
// the SMTP server will reject them with a confusing 535 BadCredentials, so we
// treat them as "not configured" and say so up front.
const PLACEHOLDER_PATTERN = /^(your[-.]|xxxx)/i;

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
    auth: { user, pass }
  });
};

const getFromAddress = (companyName = 'Terralabs ERP') =>
  process.env.EMAIL_FROM && !PLACEHOLDER_PATTERN.test(process.env.EMAIL_FROM)
    ? process.env.EMAIL_FROM
    : `"${companyName}" <${process.env.EMAIL_USER}>`;

// Maps an SMTP/config failure onto an HTTP response. Never leaks stack traces.
const sendMailErrorResponse = (res, error, action) => {
  if (error.code === 'EMAIL_NOT_CONFIGURED') {
    console.error(`❌ ${action} failed:`, error.message);
    return res.status(503).json({
      status: 'error',
      message: 'Email service is not configured on the server.',
      code: 'EMAIL_NOT_CONFIGURED'
    });
  }

  if (error.code === 'EAUTH') {
    console.error(
      `❌ ${action} failed: SMTP rejected the credentials for ${process.env.EMAIL_USER}. ` +
      'For Gmail, EMAIL_PASS must be a 16-character App Password (2-Step Verification ' +
      'must be enabled), not the account password.'
    );
    return res.status(503).json({
      status: 'error',
      message: 'Email service authentication failed.',
      code: 'EMAIL_AUTH_FAILED'
    });
  }

  console.error(`❌ ${action} failed:`, error);
  return res.status(500).json({
    status: 'error',
    message: `Failed to ${action.toLowerCase()}.`
  });
};

module.exports = {
  createTransporter,
  isEmailConfigured,
  getFromAddress,
  sendMailErrorResponse,
  EmailNotConfiguredError
};
