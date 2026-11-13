const crypto = require('crypto');
const { DEFAULT_APP_URL, appBaseUrl } = require('./appUrl');

/**
 * Generate a 6-digit OTP
 * @returns {string} 6-digit OTP
 */
const generateOTP = () => {
  // Codes stand in for a password, so they come from the CSPRNG.
  return crypto.randomInt(100000, 1000000).toString();
};

/**
 * Generate a secure token for email verification links
 * @returns {string} Secure token
 */
const generateSecureToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Hash OTP for secure storage
 * @param {string} otp - Plain OTP
 * @returns {string} Hashed OTP
 */
const hashOTP = (otp) => {
  return crypto.createHash('sha256').update(otp).digest('hex');
};

/**
 * Verify OTP against hash
 * @param {string} plainOTP - Plain OTP to verify
 * @param {string} hashedOTP - Hashed OTP from database
 * @returns {boolean} True if OTP matches
 */
const verifyOTP = (plainOTP, hashedOTP) => {
  const hashedInput = hashOTP(plainOTP);
  return hashedInput === hashedOTP;
};

/**
 * Generate email OTP template
 * @param {string} otp - 6-digit OTP
 * @param {string} fullName - User's full name
 * @returns {object} Email template with HTML and text versions
 */
const getOTPEmailTemplate = (otp, fullName) => {
  const name = escapeHtml(String(fullName || 'there').replace(/\s+/g, ' ').trim());
  const code = escapeHtml(otp);
  const base = appBaseUrl();
  const logoBase = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(base) ? DEFAULT_APP_URL : base;
  const logo = escapeHtml(process.env.EMAIL_LOGO_URL || `${logoBase}/brand/carbon-logo.png`);
  return {
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <title>Verify your email · Carbon</title>
  <style>@media only screen and (max-width:480px){.card-px{padding-left:24px!important;padding-right:24px!important}.code{font-size:34px!important;letter-spacing:6px!important}}</style>
</head>
<body style="margin:0;padding:0;background-color:#fbf7f0;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Your Carbon verification code expires in 10 minutes.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fbf7f0;">
    <tr><td align="center" style="padding:32px 16px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td align="center" style="padding:0 0 24px;">
          <img src="${logo}" width="144" alt="Carbon · Print Flow Engine" style="display:block;width:144px;max-width:144px;height:auto;border:0;font-family:Arial,sans-serif;font-size:18px;font-weight:700;color:#704a00;">
        </td></tr>
        <tr><td style="background-color:#ffffff;border:1px solid #eadfcd;border-radius:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="height:6px;line-height:6px;font-size:0;background-color:#f5a000;border-radius:15px 15px 0 0;">&nbsp;</td></tr>
            <tr><td class="card-px" style="padding:34px 40px 0;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0 0 10px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#704a00;">Account verification</p>
              <h1 style="margin:0 0 20px;font-size:27px;line-height:34px;font-weight:700;color:#1f1609;">Verify your email</h1>
              <p style="margin:0 0 12px;font-size:16px;line-height:24px;color:#5b4b36;">Hi ${name},</p>
              <p style="margin:0;font-size:16px;line-height:24px;color:#5b4b36;">Enter this code in Carbon to finish setting up your account.</p>
            </td></tr>
            <tr><td class="card-px" style="padding:26px 40px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fbf7f0;border:1px solid #eadfcd;border-radius:12px;">
                <tr><td align="center" style="padding:24px 12px 22px;font-family:Arial,Helvetica,sans-serif;">
                  <p style="margin:0 0 12px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#85735a;">Your verification code</p>
                  <p class="code" style="margin:0;font-family:Consolas,Menlo,Monaco,monospace;font-size:40px;line-height:48px;font-weight:700;letter-spacing:8px;color:#704a00;">${code}</p>
                  <p style="margin:14px 0 0;font-size:13px;line-height:20px;color:#5b4b36;">Expires in <strong>10 minutes</strong></p>
                </td></tr>
              </table>
            </td></tr>
            <tr><td class="card-px" style="padding:24px 40px 34px;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0;padding:14px 16px;background-color:#f6e7c8;border-radius:8px;font-size:13px;line-height:20px;color:#5b4b36;">For your security, never share this code. If you didn't sign up for Carbon, you can ignore this email.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:22px 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#85735a;">Carbon is part of <a href="https://terralabsindustries.com/" style="color:#704a00;text-decoration:underline;">TerraLabs Industries</a>.<br>This is an automated message from Carbon · Print Flow Engine.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: [
      'Verify your email · Carbon',
      '',
      `Hi ${String(fullName || 'there').replace(/\s+/g, ' ').trim()},`,
      '',
      'Enter this code in Carbon to finish setting up your account:',
      '',
      otp,
      '',
      'This code expires in 10 minutes. Never share it with anyone.',
      "If you didn't sign up for Carbon, you can ignore this email.",
      '',
      'Carbon · Print Flow Engine',
      'Parent company: TerraLabs Industries · https://terralabsindustries.com/'
    ].join('\n')
  };
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Email carrying a password reset code.
 * @param {string} otp - 6-digit code
 * @param {string} fullName - Account holder's name
 */
const getPasswordResetEmailTemplate = (otp, fullName) => {
  const name = escapeHtml(fullName || 'there');
  return {
    subject: 'Reset your password - Carbon',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Reset your password - Carbon</title></head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%); padding: 30px; text-align: center; color: white;">
            <h1 style="margin: 0;">Reset your password</h1>
            <p style="margin: 8px 0 0;">Carbon — Print Flow Engine</p>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <p>Hi ${name},</p>
            <p>We received a request to reset the password for your Carbon account. Enter this code on the sign-in page to choose a new password:</p>
            <div style="background: white; padding: 24px; border-radius: 8px; margin: 20px 0; text-align: center; border-left: 4px solid #ff6b35;">
              <div style="font-size: 32px; font-weight: bold; color: #ff6b35; letter-spacing: 8px;">${otp}</div>
              <p style="margin: 12px 0 0;">This code expires in <strong>10 minutes</strong>.</p>
            </div>
            <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px;">
              <strong>Didn't ask for this?</strong> Ignore this email — your password stays the same. Never share this code with anyone.
            </div>
          </div>
          <div style="text-align: center; padding: 20px; color: #666; font-size: 12px;">
            <p>&copy; 2026 TerraLabs Industries. All rights reserved.</p>
            <p>This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: [
      'Reset your password - Carbon',
      '',
      `Hi ${fullName || 'there'},`,
      '',
      'We received a request to reset the password for your Carbon account. Enter this code on the sign-in page to choose a new password:',
      '',
      `    ${otp}`,
      '',
      'This code expires in 10 minutes.',
      '',
      "Didn't ask for this? Ignore this email - your password stays the same. Never share this code with anyone.",
      '',
      '© 2026 TerraLabs Industries. All rights reserved.'
    ].join('\n')
  };
};

module.exports = {
  generateOTP,
  getPasswordResetEmailTemplate,
  generateSecureToken,
  hashOTP,
  verifyOTP,
  getOTPEmailTemplate
};
