const { rateLimit } = require('express-rate-limit');

/**
 * Rate limits for signing in.
 *
 * Only failed attempts count (a wrong password, an unknown email, a request
 * the server refuses): a successful sign-in is taken off the count again, so
 * people who sign in normally — however often, however many share an office
 * connection — are never held up. Two limits, over 15 minutes:
 *
 *  - 10 failures for one email from one address: guessing one account's
 *    password. Other accounts on the same connection are not affected, and
 *    an administrator can still reset the password meanwhile.
 *  - 50 failures from one address across any emails: trying many accounts.
 *    This one only applies where the client's address is known. Behind a
 *    reverse proxy that address is the proxy's unless TRUST_PROXY is set (see
 *    app.js); a shared address would add every user's typos together, so the
 *    limit stands aside rather than lock everybody out.
 *
 * Counts are kept in memory, per server process.
 */
const WINDOW_MS = 15 * 60 * 1000;

const normalisedEmail = (req) => String(req.body?.email || '').trim().toLowerCase();

const tooMany = (req, res) => {
  const resetAt = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime).getTime() : Date.now() + WINDOW_MS;
  const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60000));
  res.status(429).json({
    status: 'error',
    code: 'TOO_MANY_LOGIN_ATTEMPTS',
    message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask your administrator to reset your password.`
  });
};

const common = {
  windowMs: WINDOW_MS,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooMany,
  // The proxy check is ours (see addressUnknown); don't log it as a misconfiguration.
  validate: { xForwardedForHeader: false }
};

/** True when req.ip is a proxy's address rather than the client's. */
const addressUnknown = (req) => !req.app.get('trust proxy') && Boolean(req.headers['x-forwarded-for']);

const perAccount = rateLimit({
  ...common,
  limit: 10,
  keyGenerator: (req) => `${req.ip}|${normalisedEmail(req)}`
});

const perAddress = rateLimit({
  ...common,
  limit: 50,
  keyGenerator: (req) => req.ip,
  skip: addressUnknown
});

module.exports = { loginRateLimit: [perAccount, perAddress], LOGIN_WINDOW_MS: WINDOW_MS };

/**
 * Forgot / reset password, per client address over 15 minutes: 20 code
 * requests and 30 reset attempts. Each email address is also limited to one
 * code a minute in the route, and each code to five guesses, so these only
 * stop bulk use.
 */
const resetLimiter = (limit) => rateLimit({
  ...common,
  skipSuccessfulRequests: false,
  limit,
  keyGenerator: (req) => req.ip,
  skip: addressUnknown,
  handler: (req, res) => res.status(429).json({
    status: 'error',
    code: 'TOO_MANY_RESET_REQUESTS',
    message: 'Too many password reset requests. Try again in a few minutes.'
  })
});

module.exports.forgotPasswordRateLimit = resetLimiter(20);
module.exports.resetPasswordRateLimit = resetLimiter(30);
