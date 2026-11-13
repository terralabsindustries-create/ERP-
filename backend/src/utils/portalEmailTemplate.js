const { DEFAULT_APP_URL } = require('./appUrl');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const cleanLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

const getPortalEmailTemplate = ({ customerName, companyName, link, expiresAt }) => {
  const customer = cleanLine(customerName) || 'there';
  const company = cleanLine(companyName) || 'your print shop';
  const expiry = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata'
  }).format(new Date(expiresAt));
  const logo = process.env.EMAIL_LOGO_URL || `${DEFAULT_APP_URL}/brand/carbon-logo.png`;
  const subject = `Your customer portal is ready · ${company}`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(subject)}</title>
  <style>@media only screen and (max-width:480px){.card-px{padding-left:24px!important;padding-right:24px!important}}</style>
</head>
<body style="margin:0;padding:0;background-color:#fbf7f0;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Follow your orders, invoices and deliveries with ${escapeHtml(company)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fbf7f0;">
    <tr><td align="center" style="padding:32px 16px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td align="center" style="padding:0 0 24px;">
          <img src="${escapeHtml(logo)}" width="144" alt="Carbon · Print Flow Engine" style="display:block;width:144px;max-width:144px;height:auto;border:0;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;color:#704a00;">
        </td></tr>
        <tr><td style="background-color:#ffffff;border:1px solid #eadfcd;border-radius:16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="height:6px;line-height:6px;font-size:0;background-color:#f5a000;border-radius:15px 15px 0 0;">&nbsp;</td></tr>
            <tr><td class="card-px" style="padding:34px 40px 0;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0 0 10px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#704a00;">Customer portal</p>
              <h1 style="margin:0 0 20px;font-size:27px;line-height:34px;font-weight:700;color:#1f1609;">Your orders, all in one place</h1>
              <p style="margin:0 0 12px;font-size:16px;line-height:24px;color:#5b4b36;">Hi ${escapeHtml(customer)},</p>
              <p style="margin:0;font-size:16px;line-height:24px;color:#5b4b36;">${escapeHtml(company)} has shared a personal portal where you can follow your orders, view invoices and check deliveries.</p>
            </td></tr>
            <tr><td class="card-px" style="padding:28px 40px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#704a00" style="border-radius:10px;background-color:#704a00;">
                <a href="${escapeHtml(link)}" target="_blank" style="display:inline-block;padding:14px 24px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:20px;font-weight:700;color:#fff8ec;text-decoration:none;">Open customer portal</a>
              </td></tr></table>
            </td></tr>
            <tr><td class="card-px" style="padding:16px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#5b4b36;">Your personal link works until <strong>${escapeHtml(expiry)}</strong>.</td></tr>
            <tr><td class="card-px" style="padding:24px 40px 0;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0;padding:14px 16px;background-color:#f6e7c8;border-radius:8px;font-size:13px;line-height:20px;color:#5b4b36;">For your privacy, please keep this link to yourself. Anyone with the link may be able to view your portal until it expires or is revoked.</p>
            </td></tr>
            <tr><td class="card-px" style="padding:26px 40px 34px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#85735a;border-top:0;">
              Button not working? Copy this link into your browser:<br>
              <a href="${escapeHtml(link)}" style="color:#704a00;text-decoration:underline;word-break:break-all;">${escapeHtml(link)}</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:22px 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#85735a;">Sent by ${escapeHtml(company)} using Carbon · Print Flow Engine<br>Carbon is part of <a href="https://terralabsindustries.com/" style="color:#704a00;text-decoration:underline;">TerraLabs Industries</a>.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Your customer portal · ${company}`,
    '',
    `Hi ${customer},`,
    '',
    `${company} has shared a personal portal where you can follow your orders, view invoices and check deliveries.`,
    '',
    `Open your portal: ${link}`,
    '',
    `This link works until ${expiry}. Keep it to yourself; anyone with the link may be able to view your portal until it expires or is revoked.`,
    '',
    `Sent by ${company} using Carbon · Print Flow Engine.`,
    'Carbon is part of TerraLabs Industries · https://terralabsindustries.com/'
  ].join('\n');

  return { subject, html, text };
};

module.exports = { getPortalEmailTemplate };
