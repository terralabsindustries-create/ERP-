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
const { DEFAULT_APP_URL, appBaseUrl } = require('./appUrl');

const INVITATION_EXPIRY_HOURS = parseInt(process.env.INVITATION_EXPIRY_HOURS, 10) || 24;

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i;
// Business names left over from before the rebrand must never reach an invitee.
const LEGACY_NAME = /serpy|synx automation/i;

const hashInvitationToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

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

const isLive = (invitation) =>
  !!invitation && !!invitation.expiresAt && new Date(invitation.expiresAt).getTime() > Date.now();

const buildAcceptUrl = (token) =>
  `${appBaseUrl()}/accept-invitation/${encodeURIComponent(token)}`;

// The logo is the Carbon logo the web app already serves. A mail client can't
// load anything from a developer's localhost, so local builds point at the
// hosted copy.
const logoUrl = () => {
  if (process.env.EMAIL_LOGO_URL) return process.env.EMAIL_LOGO_URL;
  const base = appBaseUrl();
  return `${LOCAL_HOST.test(base) ? DEFAULT_APP_URL : base}/brand/carbon-logo.png`;
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const titleCase = (value) =>
  value ? String(value).charAt(0).toUpperCase() + String(value).slice(1) : '';

const expiryPhrase = (hours = INVITATION_EXPIRY_HOURS) =>
  hours >= 48 && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hour${hours === 1 ? '' : 's'}`;

const BRAND = {
  ink: '#1f1a14',
  body: '#4a4238',
  muted: '#7a7064',
  brown: '#704a00',
  link: '#8a5a00',
  amber: '#f5a524',
  page: '#f6f3ee',
  panel: '#fbf8f3',
  line: '#ebe4d8'
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The invitation email: subject, HTML and a plain-text alternative. It never
 * contains a password — only the one-time link the recipient uses to choose
 * their own.
 */
const getInvitationEmailTemplate = ({
  fullName,
  email,
  role,
  roleName,
  department,
  companyName,
  invitedByName,
  acceptUrl
}) => {
  const company = oneLine(companyName);
  const hasCompany = !!company && !LEGACY_NAME.test(company);
  const workspace = hasCompany ? company : 'your team';
  const name = oneLine(fullName) || 'there';
  const inviter = oneLine(invitedByName);
  const roleLabel = oneLine(roleName) || titleCase(oneLine(role));
  const dept = oneLine(department);
  const expiry = expiryPhrase();

  const subject = `You're invited to join ${workspace} on Carbon`;
  const heading = hasCompany ? `Join ${company} on Carbon` : 'Join your team on Carbon';
  // When the inviting login is named after the business ("TERRALABS INDUSTRIES
  // has invited you to join TERRALABS INDUSTRIES"), say it once.
  const inviterIsCompany = !!inviter && hasCompany && inviter.toLowerCase() === company.toLowerCase();
  const intro = inviterIsCompany
    ? `${company} has invited you to join their team on Carbon, where they manage job tickets, production and billing. Set a password to activate your login.`
    : `${inviter ? `${inviter} has invited you` : "You've been invited"} to join ${workspace} on Carbon, where the team manages job tickets, production and billing. Set a password to activate your login.`;
  const reason = `You're receiving this because ${hasCompany ? company : 'a Carbon workspace'} added ${email} as a team member. If you weren't expecting it, you can ignore this email; nothing is activated until a password is set.`;
  const preheader = `Set your password to join ${workspace}. The link expires in ${expiry}.`;

  const details = [
    ['Sign-in email', email],
    roleLabel && ['Role', roleLabel],
    dept && ['Department', dept]
  ].filter(Boolean);

  const detailRows = details.map(([label, value], index) => `
                <tr>
                  <td class="detail-label" style="padding:${index ? '10px' : '0'} 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.muted};width:120px;vertical-align:top;">${escapeHtml(label)}</td>
                  <td style="padding:${index ? '10px' : '0'} 0 0;font-family:${FONT};font-size:14px;line-height:20px;color:${BRAND.ink};font-weight:600;word-break:break-word;">${escapeHtml(value)}</td>
                </tr>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(subject)}</title>
  <style>
    @media only screen and (max-width: 480px) {
      .card-px { padding-left: 24px !important; padding-right: 24px !important; }
      .detail-label { width: 96px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.page};">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.page};">
    <tr>
      <td align="center" style="padding:32px 16px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <tr>
            <td align="center" style="padding:0 0 24px;">
              <img src="${escapeHtml(logoUrl())}" width="144" alt="Carbon — Print Flow Engine" style="display:block;width:144px;max-width:144px;height:auto;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:2px;color:${BRAND.brown};">
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border:1px solid ${BRAND.line};border-radius:16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:6px;line-height:6px;font-size:0;background-color:${BRAND.amber};border-radius:15px 15px 0 0;">&nbsp;</td>
                </tr>
                <tr>
                  <td class="card-px" style="padding:34px 40px 0;">
                    <p style="margin:0 0 10px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.brown};">Team invitation</p>
                    <h1 style="margin:0 0 20px;font-family:${FONT};font-size:26px;line-height:32px;font-weight:700;color:${BRAND.ink};">${escapeHtml(heading)}</h1>
                    <p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.body};">Hi ${escapeHtml(name)},</p>
                    <p style="margin:0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.body};">${escapeHtml(intro)}</p>
                  </td>
                </tr>
                <tr>
                  <td class="card-px" style="padding:24px 40px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;">
                      <tr>
                        <td style="padding:16px 20px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${detailRows}
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="card-px" style="padding:28px 40px 0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" bgcolor="${BRAND.brown}" style="border-radius:10px;background-color:${BRAND.brown};">
                          <a href="${escapeHtml(acceptUrl)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">Set your password</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="card-px" style="padding:14px 40px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${BRAND.muted};">This link works once and expires in ${escapeHtml(expiry)}.</td>
                </tr>
                <tr>
                  <td class="card-px" style="padding:28px 40px 34px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="border-top:1px solid ${BRAND.line};padding-top:20px;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.muted};">
                          Button not working? Copy this link into your browser:<br>
                          <a href="${escapeHtml(acceptUrl)}" target="_blank" style="color:${BRAND.link};text-decoration:underline;word-break:break-all;">${escapeHtml(acceptUrl)}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 24px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">
              ${escapeHtml(reason)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 24px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">
              <span style="font-weight:700;letter-spacing:2px;color:${BRAND.brown};">CARBON</span>&nbsp;&nbsp;·&nbsp;&nbsp;Print Flow Engine
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 24px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">
              Part of <a href="https://terralabsindustries.com/" target="_blank" style="color:${BRAND.brown};text-decoration:underline;">TerraLabs Industries</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const labelWidth = Math.max(...details.map(([label]) => label.length)) + 1;
  const text = [
    heading,
    '',
    `Hi ${name},`,
    '',
    intro,
    '',
    ...details.map(([label, value]) => `  ${`${label}:`.padEnd(labelWidth)} ${value}`),
    '',
    'Set your password:',
    acceptUrl,
    '',
    `This link works once and expires in ${expiry}.`,
    '',
    reason,
    '',
    'Carbon · Print Flow Engine',
    'Parent company: TerraLabs Industries · https://terralabsindustries.com/'
  ].join('\n');

  return { subject, html, text };
};

module.exports = {
  INVITATION_EXPIRY_HOURS,
  createInvitationToken,
  hashInvitationToken,
  isLive,
  appBaseUrl,
  buildAcceptUrl,
  getInvitationEmailTemplate
};
