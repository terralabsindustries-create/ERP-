/**
 * Staff invitations.
 *
 * Admins never choose a password for the people they add. Instead the account is
 * created in the 'invited' state and a one-time link is emailed to them; the
 * link is the only place the raw token ever exists. We store nothing but its
 * SHA-256 hash, so a leaked database cannot be replayed into an account
 * takeover — the same pattern as a password-reset link.
 */

const crypto = require('crypto');

const INVITATION_EXPIRY_HOURS = parseInt(process.env.INVITATION_EXPIRY_HOURS, 10) || 24;

const hashInvitationToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

/**
 * Mint a fresh invitation.
 * @returns {{ token: string, tokenHash: string, expiresAt: Date }}
 *          `token` goes in the email, `tokenHash` goes in the database.
 */
const createInvitationToken = () => {
  const token = crypto.randomBytes(32).toString('hex');

  return {
    token,
    tokenHash: hashInvitationToken(token),
    expiresAt: new Date(Date.now() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000)
  };
};

const buildAcceptUrl = (token) => {
  const base = (process.env.FRONTEND_URL || 'https://app.serpy.in').replace(/\/+$/, '');
  return `${base}/accept-invitation/${token}`;
};

const titleCase = (value) =>
  value ? String(value).charAt(0).toUpperCase() + String(value).slice(1) : '';

/**
 * The invitation email. Deliberately contains no password — only the one-time
 * link the recipient uses to choose their own.
 */
const getInvitationEmailTemplate = ({ fullName, email, role, department, companyName, acceptUrl }) => {
  const company = companyName || 'SerpY ERP';
  const roleLine = department
    ? `${titleCase(role)} · ${department}`
    : titleCase(role);

  return {
    subject: `You've been invited to ${company}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>You've been invited to ${company}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background: #f4f4f7; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
          .header { background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 32px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 32px; }
          .details { background: #fafafa; padding: 20px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #f97316; }
          .details p { margin: 6px 0; }
          .button-wrap { text-align: center; margin: 32px 0; }
          .button { display: inline-block; padding: 14px 32px; background: #f97316; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: bold; }
          .expiry { color: #b45309; font-size: 14px; text-align: center; }
          .fallback { font-size: 12px; color: #666; word-break: break-all; }
          .footer { text-align: center; padding: 24px; color: #888; font-size: 12px; border-top: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>You've been invited to ${company}</h1>
          </div>

          <div class="content">
            <p>Hello ${fullName},</p>
            <p>Your administrator has created an account for you.</p>

            <div class="details">
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Role:</strong> ${roleLine}</p>
            </div>

            <p>Click the button below to set your password and activate your account.</p>

            <div class="button-wrap">
              <a href="${acceptUrl}" class="button">Accept Invitation</a>
            </div>

            <p class="expiry">This invitation expires in ${INVITATION_EXPIRY_HOURS} hours.</p>

            <p class="fallback">
              If the button doesn't work, paste this link into your browser:<br>
              ${acceptUrl}
            </p>

            <p>If you weren't expecting this invitation, you can safely ignore this email.</p>
          </div>

          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${company}. All rights reserved.</p>
            <p>This is an automated message. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `You've been invited to ${company}

Hello ${fullName},

Your administrator has created an account for you.

Email: ${email}
Role: ${roleLine}

Set your password and activate your account:
${acceptUrl}

This invitation expires in ${INVITATION_EXPIRY_HOURS} hours.

If you weren't expecting this invitation, you can safely ignore this email.

© ${new Date().getFullYear()} ${company}. All rights reserved.`
  };
};

module.exports = {
  INVITATION_EXPIRY_HOURS,
  createInvitationToken,
  hashInvitationToken,
  buildAcceptUrl,
  getInvitationEmailTemplate
};
