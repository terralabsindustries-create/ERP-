/**
 * The Express application: middleware, every /api route, and the error
 * handlers. No database connection, timers or listening port live here, so
 * tests can load the app on its own; src/server.js boots it for real.
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const path = require('path');


const app = express();

// Security Middleware
app.use(helmet());
app.use(compression());

// CORS configuration
app.use(cors({
  origin: [
    // TODO: switch back to production URL when done testing locally
    // process.env.FRONTEND_URL || 'https://serpy.synxautomate.com',
    process.env.FRONTEND_URL || 'http://localhost:8080',
    'https://serpy-silk.vercel.app',
    'http://localhost:8081',
    'http://localhost:8080',
    'https://app.serpy.in',
    // The Electron desktop app serves the same bundle over its own scheme, so
    // its requests arrive from this fixed origin (see desktop/main.cjs).
    'app://serpy'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Portal-Session']
}));


app.use(express.json({
  limit: '10mb',
  // The WhatsApp webhook checks Meta's signature over the exact bytes received.
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/whatsapp/webhook')) req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Data sanitization against XSS
app.use(xss());

// Logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Serve static files from public/temp directory for temporary PDFs
app.use('/temp', express.static(path.join(__dirname, '../public/temp')));

// Serve static files from client build directory
app.use('/assets', express.static(path.join(__dirname, '../../client/dist/assets')));

// Routes
//
// Every module is mounted behind `protect` and a moduleGuard (see
// middleware/moduleGuard.js), so the backend enforces the same permissions the
// sidebar uses: a login without a module cannot read it, and creating, editing
// or deleting needs the matching action. Routers still apply their own checks
// and record-level scoping on top of this.
const { protect } = require('./middleware/auth');
const { moduleGuard, AUTHENTICATED } = require('./middleware/moduleGuard');
const { userCan } = require('./middleware/requirePermission');
const { isOrgViewer } = require('./utils/accessScope');

const SALES_LOOKUPS = ['Customers', 'Jobs', 'Quotations', 'Invoicing', 'Walk-In Jobs', 'Payments', 'Customer Portal', 'Delivery', 'Emergency Orders', 'Payment Reminders', 'Accounts'];
const JOB_READERS = ['Jobs', 'Invoicing', 'Quotations', 'Staff & Tasks', 'Designer Timer', 'Delivery', 'Job Proofing', 'Walk-In Jobs', 'Emergency Orders', 'Calendar'];
const ITEM_READERS = ['Inventory', 'Jobs', 'Quotations', 'Invoicing', 'Purchase Bills', 'Walk-In Jobs'];
const TAX_CODE_READERS = ['Invoicing', 'Quotations', 'Jobs', 'Inventory', 'Purchase Bills'];

const guarded = (mount, router, guard) => app.use(mount, protect, moduleGuard(guard), router);

app.use('/api/auth', require('./routes/auth'));

guarded('/api/customers', require('./routes/customers'), {
  read: SALES_LOOKUPS,
  write: 'Customers: Create & Edit',
  remove: 'Customers: Delete',
  rules: [{ method: 'POST', path: /^\/[^/]+\/update-stats$/, allow: ['Customers: Create & Edit', 'Invoicing: Create & Edit', 'Payments: Record Payment'] }]
});
guarded('/api/jobs', require('./routes/jobs'), {
  read: JOB_READERS,
  write: 'Jobs: Create & Edit',
  remove: 'Jobs: Delete',
  rules: [
    // A login's own design-charge total and the jobs they handle or have tasks on
    { method: 'GET', path: /^\/(staff\/stats|mine)$/, allow: AUTHENTICATED },
    { method: 'GET', path: /^\/stats\/dashboard$/, allow: 'Jobs' },
    { method: 'POST', path: /^\/[^/]+\/(update-status|update-flow-stage)$/, allow: 'Jobs: Change Status' }
  ]
});
guarded('/api/walk-in-jobs', require('./routes/walkInJobs'), { read: 'Walk-In Jobs', write: 'Walk-In Jobs: Create & Edit' });
guarded('/api/quotations', require('./routes/quotations'), {
  read: 'Quotations',
  write: 'Quotations: Create & Edit',
  remove: 'Quotations: Delete',
  rules: [
    { method: 'PATCH', path: /^\/[^/]+\/status$/, allow: 'Quotations: Change Status' },
    { method: 'POST', path: /^\/[^/]+\/convert-to-invoice$/, allow: 'Quotations: Convert to Invoice' },
    { method: 'POST', path: /^\/[^/]+\/send-email$/, allow: 'Quotations: Send Email' },
    { method: 'POST', path: /^\/[^/]+\/send-whatsapp$/, allow: 'WhatsApp: Send Messages' }
  ]
});
guarded('/api/invoices', require('./routes/invoices'), {
  read: ['Invoicing', 'Invoicing (View No GST)', 'Payments'],
  write: 'Invoicing: Create & Edit',
  remove: 'Invoicing: Delete',
  rules: [
    { method: 'PATCH', path: /^\/[^/]+\/payment-status$/, allow: 'Invoicing: Record Payment' },
    { method: 'POST', path: /^\/[^/]+\/send-email$/, allow: 'Invoicing: Send Email' },
    { method: 'POST', path: /^\/[^/]+\/send-whatsapp$/, allow: 'WhatsApp: Send Messages' }
  ]
});
guarded('/api/payments', require('./routes/payments'), { read: 'Payments', write: 'Payments: Record Payment', remove: 'Payments: Delete' });
guarded('/api/inventory', require('./routes/inventory'), {
  read: ITEM_READERS,
  write: 'Inventory: Create & Edit',
  remove: 'Inventory: Delete',
  rules: [
    { method: 'GET', path: /^\/(analytics|movements|reports\/.*)$/, allow: 'Inventory' },
    { method: 'POST', path: /^\/([^/]+\/adjust|bulk-update)$/, allow: 'Inventory: Adjust Stock' }
  ]
});
guarded('/api/categories', require('./routes/categories'), { read: ITEM_READERS, write: 'Inventory: Create & Edit' });
guarded('/api/units', require('./routes/units'), { read: ITEM_READERS, write: 'Inventory: Create & Edit' });
guarded('/api/purchase-orders', require('./routes/purchaseOrders'), {
  read: ['Inventory', 'Purchase Bills', 'Vendors'],
  write: ['Inventory: Create & Edit', 'Purchase Bills: Create & Edit']
});
guarded('/api/purchase-bills', require('./routes/purchaseBills'), { read: 'Purchase Bills', write: 'Purchase Bills: Create & Edit', remove: 'Purchase Bills: Delete' });
guarded('/api/vendors', require('./routes/vendors'), {
  read: ['Vendors', 'Purchase Bills', 'Inventory'],
  write: 'Vendors: Create & Edit',
  remove: 'Vendors: Delete',
  rules: [{ method: 'POST', path: /^\/[^/]+\/payment$/, allow: ['Purchase Bills: Record Payment', 'Vendors: Create & Edit'] }]
});
guarded('/api/staff', require('./routes/staff'), {
  read: 'Staff & Tasks',
  write: 'Staff & Tasks: Manage Schedule',
  rules: [
    // Anyone may read their own schedule; the router refuses other people's
    // unless the caller manages schedules or sees all staff data.
    { method: 'GET', path: /^\/[^/]+\/schedule$/, allow: AUTHENTICATED },
    { method: 'PUT', path: /^\/[^/]+\/(email|password)$/, allow: ['User Management', 'Staff & Tasks'] }
  ]
});
// Tasks are personal work records: the router decides per task (assignee,
// assigner, or a login that sees all staff data).
guarded('/api/tasks', require('./routes/tasks'), { read: AUTHENTICATED, write: AUTHENTICATED });
guarded('/api/notifications', require('./routes/notifications'), { read: AUTHENTICATED, write: AUTHENTICATED });
// Team workload and evaluation: the admin, or a login that both manages staff
// and has "Can view all staff data".
guarded('/api/team', require('./routes/team'), {
  read: (user) => user.role === 'admin' || (isOrgViewer(user) && userCan(user, 'Staff & Tasks')),
  write: () => false
});
guarded('/api/hsn-codes', require('./routes/hsnCodes'), { read: ['HSN Codes', ...TAX_CODE_READERS], write: 'HSN Codes: Create & Edit', remove: 'HSN Codes: Delete' });
guarded('/api/sac-codes', require('./routes/sacCodes'), { read: ['SAC Codes', ...TAX_CODE_READERS], write: 'SAC Codes: Create & Edit', remove: 'SAC Codes: Delete' });
guarded('/api/accounts', require('./routes/accounts'), { read: 'Accounts', write: 'Accounts: Create & Edit', remove: 'Accounts: Delete' });
guarded('/api/costs', require('./routes/costs'), { read: 'Cost & Profit', write: 'Cost & Profit' });
guarded('/api/proofs', require('./routes/proofs'), {
  read: 'Job Proofing',
  write: 'Job Proofing',
  rules: [
    { method: 'PUT', path: /^\/[^/]+\/approve$/, allow: 'Job Proofing: Approve' },
    { method: 'PUT', path: /^\/[^/]+\/reject$/, allow: 'Job Proofing: Reject' }
  ]
});
// Meta calls the webhook without a login, so it is the one public path here.
app.use('/api/whatsapp', (req, res, next) => (req.path.startsWith('/webhook') ? next() : protect(req, res, next)), (req, res, next) =>
  req.path.startsWith('/webhook')
    ? next()
    : moduleGuard({
        read: ['WhatsApp', 'Payment Reminders'],
        write: 'WhatsApp: Send Messages',
        rules: [{ method: ['POST', 'DELETE'], path: /^\/(settings|meta-templates)/, allow: 'Settings: Edit' }]
      })(req, res, next),
  require('./routes/whatsapp'));
guarded('/api/embedded-signup', require('./routes/embeddedSignup'), { read: ['WhatsApp', 'Settings'], write: 'Settings: Edit' });
guarded('/api/reports', require('./routes/reports'), {
  read: 'Reports',
  write: 'Reports: Export'
});
guarded('/api/files', require('./routes/files'), { read: ['Jobs', 'Customers', 'Job Proofing'], write: ['Jobs: Create & Edit', 'Customers: Create & Edit', 'Job Proofing'] });
guarded('/api/dashboard', require('./routes/dashboard'), {
  // The stats route only returns the sections the caller's permissions cover;
  // the monthly target is stored with the caller's own settings.
  read: AUTHENTICATED,
  write: AUTHENTICATED
});
guarded('/api/emergency-orders', require('./routes/emergencyOrders'), { read: 'Emergency Orders', write: 'Emergency Orders: Create & Edit' });
guarded('/api/deliveries', require('./routes/deliveries'), {
  read: 'Delivery',
  write: 'Delivery: Create & Edit',
  rules: [{ method: 'PUT', path: /^\/[^/]+\/status$/, allow: 'Delivery: Update Status' }]
});
guarded('/api/time-entries', require('./routes/timeEntries'), { read: ['Designer Timer', 'Staff & Tasks'], write: 'Designer Timer: Track Time' });
guarded('/api/calendar', require('./routes/calendar'), { read: 'Calendar', write: 'Calendar: Create & Edit', remove: 'Calendar: Delete' });
guarded('/api/discounts', require('./routes/discounts'), {
  read: ['Discounts', 'Invoicing', 'Quotations'],
  write: 'Discounts: Create & Edit',
  remove: 'Discounts: Delete',
  rules: [{ method: 'POST', path: /^\/calculate$/, allow: ['Discounts', 'Invoicing', 'Quotations'] }]
});
// Customer-facing routes authenticate with a portal session; the staff routes
// for issuing access links apply protect + requirePermission themselves.
app.use('/api/portal', require('./routes/portal'));
guarded('/api/activity-log', require('./routes/activityLog'), { read: 'Activity Log', write: () => false, remove: (user) => user.role === 'admin' });
app.use('/api/users', require('./routes/users'));
// Roles (named permission sets) and teams for User Management.
guarded('/api/access-roles', require('./routes/accessRoles'), { read: 'User Management', write: 'User Management: Edit Permissions' });
guarded('/api/teams', require('./routes/teams'), { read: ['User Management', 'Staff & Tasks'], write: 'User Management: Edit Permissions' });
guarded('/api/settings', require('./routes/settings'), {
  // Settings are stored per login, so reading your own is always allowed;
  // changing business settings needs Settings: Edit. Theme and notification
  // preferences are personal.
  read: AUTHENTICATED,
  write: 'Settings: Edit',
  rules: [{ method: 'PUT', path: /^\/(theme|notifications)$/, allow: AUTHENTICATED }]
});
app.use('/api/email', require('./routes/email'));
app.use('/api/razorpay', require('./routes/razorpay'));
// HR & Payroll
guarded('/api/hr/employees', require('./routes/employees'), { read: ['Human Resources', 'Payroll'], write: 'Human Resources: Create & Edit', remove: 'Human Resources: Delete' });
guarded('/api/hr/attendance', require('./routes/attendance'), { read: 'Human Resources', write: 'Human Resources: Create & Edit', remove: 'Human Resources: Create & Edit' });
guarded('/api/hr/leaves', require('./routes/leaves'), {
  read: 'Human Resources',
  write: 'Human Resources: Create & Edit',
  rules: [{ method: 'PATCH', path: /^\/[^/]+\/status$/, allow: 'Human Resources: Manage Leaves' }]
});
guarded('/api/hr/payroll', require('./routes/payroll'), { read: 'Payroll', write: 'Payroll: Process Payroll' });
guarded('/api/payment-reminders', require('./routes/paymentReminders'), {
  read: 'Payment Reminders',
  write: 'Payment Reminders: Send Reminders',
  rules: [{ method: 'PUT', path: /^\/settings$/, allow: 'Settings: Edit' }]
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Terralabs ERP API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      status: 'error',
      message: 'Validation Error',
      errors
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    return res.status(400).json({
      status: 'error',
      message: 'Duplicate field value'
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      status: 'error',
      message: 'Token expired'
    });
  }

  // Default error
  res.status(err.statusCode || 500).json({
    status: 'error',
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Serve the frontend app in production.
// Registered AFTER every /api route: Express matches in order, so a catch-all
// mounted earlier would answer API requests before they ever reach a router.
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')));
  
  // Serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/temp')) {
      return res.status(404).json({
        status: 'error',
        message: `Route ${req.originalUrl} not found`
      });
    }
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
  });
}

// 404 handler for API routes only
app.use('/api/*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `API Route ${req.originalUrl} not found`
  });
});

module.exports = app;
