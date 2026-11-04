/**
 * The address of the Carbon web app, for links that leave the server in email
 * (invitations, customer portal links, the invitation logo).
 */

// Where the Carbon web app lives when the server has not been told otherwise.
const DEFAULT_APP_URL = 'https://erp-delta-one-83.vercel.app';

// The SerpY-era web app is still online at these addresses, but it is a
// different, retired application: it shows a "SerpY desktop" page instead of
// Carbon's. Older .env files still name it in FRONTEND_URL, so a link must
// never be built on it.
const RETIRED_APP_HOST = /(^|\.)serpy\.in$|^serpy\.synxautomate\.com$|^serpy-silk\.vercel\.app$/i;

let warnedAbout = null;

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/**
 * INVITATION_FRONTEND_URL, else FRONTEND_URL, when it is a web address of the
 * Carbon app. Anything else — unset, the desktop app's app:// origin, or the
 * retired SerpY app — falls back to the hosted Carbon app.
 */
const appBaseUrl = () => {
  const configured = String(process.env.INVITATION_FRONTEND_URL || process.env.FRONTEND_URL || '').trim();
  const host = /^https?:\/\//i.test(configured) ? hostOf(configured) : '';

  if (host && !RETIRED_APP_HOST.test(host)) return configured.replace(/\/+$/, '');

  if (host && warnedAbout !== configured) {
    warnedAbout = configured;
    console.warn(
      `⚠️  FRONTEND_URL is ${configured}, the retired SerpY app. Links in emails use ` +
      `${DEFAULT_APP_URL} instead. Set FRONTEND_URL to the Carbon web app.`
    );
  }
  return DEFAULT_APP_URL;
};

module.exports = { DEFAULT_APP_URL, appBaseUrl };
