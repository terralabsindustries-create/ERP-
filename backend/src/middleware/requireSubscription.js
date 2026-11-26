const { protect } = require('./auth');
const { getEntitlement } = require('../services/subscriptionService');

const ACCOUNT_ROUTES = new Set([
  '/auth/send-otp', '/auth/verify-otp', '/auth/register',
  '/auth/forgot-password', '/auth/reset-password', '/auth/login',
  '/auth/me', '/auth/logout', '/auth/profile', '/auth/password'
]);

// Login, account recovery and billing must keep working after a plan expires.
// Customer-facing links and provider webhooks use their own authentication.
const isOpenWithoutPlan = (req) => {
  const path = req.path;
  if (path === '/health' || path === '/email/test-public' || path.startsWith('/razorpay/')) return true;
  if (path.startsWith('/proof-share/')) return true;
  if (path.startsWith('/whatsapp/webhook')) return true;
  if (path.startsWith('/portal/') && !path.startsWith('/portal/access')) return true;
  if (path.startsWith('/auth/invitation/')) return true;
  return ACCOUNT_ROUTES.has(path);
};

const requireSubscription = (req, res, next) => {
  if (isOpenWithoutPlan(req)) return next();
  return protect(req, res, async () => {
    try {
      const entitlement = await getEntitlement(req.user);
      if (!entitlement.isActive) {
        return res.status(402).json({
          status: 'error',
          code: 'SUBSCRIPTION_EXPIRED',
          message: 'Your business plan has ended. Ask your admin to renew it in Plan & billing.'
        });
      }
      next();
    } catch (error) {
      console.error('Could not check subscription:', error);
      res.status(503).json({
        status: 'error',
        code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
        message: 'Could not check your plan right now. Please try again shortly.'
      });
    }
  });
};

module.exports = { requireSubscription };
