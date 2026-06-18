require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
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
    process.env.FRONTEND_URL || 'https://serpy.synxautomate.com',
    'https://serpy-silk.vercel.app',
    'http://localhost:8081',
    'http://localhost:8080',
    'https://app.serpy.in'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));


app.use(express.json({ limit: '10mb' }));
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

// Serve the frontend app in production
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

// Database connection
let mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/print_arts_flow';
// Force IPv4 connection by replacing localhost with 127.0.0.1
mongoUri = mongoUri.replace('localhost', '127.0.0.1');
mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/walk-in-jobs', require('./routes/walkInJobs'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/units', require('./routes/units'));
app.use('/api/purchase-orders', require('./routes/purchaseOrders'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/hsn-codes', require('./routes/hsnCodes'));
app.use('/api/sac-codes', require('./routes/sacCodes'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/costs', require('./routes/costs'));
app.use('/api/proofs', require('./routes/proofs'));
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/files', require('./routes/files'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/emergency-orders', require('./routes/emergencyOrders'));
app.use('/api/deliveries', require('./routes/deliveries'));
app.use('/api/time-entries', require('./routes/timeEntries'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/discounts', require('./routes/discounts'));
app.use('/api/portal', require('./routes/portal'));
app.use('/api/activity-log', require('./routes/activityLog'));
app.use('/api/users', require('./routes/users'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/email', require('./routes/email'));
app.use('/api/razorpay', require('./routes/razorpay'));
// HR & Payroll
app.use('/api/hr/employees', require('./routes/employees'));
app.use('/api/hr/attendance', require('./routes/attendance'));
app.use('/api/hr/leaves', require('./routes/leaves'));
app.use('/api/hr/payroll', require('./routes/payroll'));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'SerpY ERP API is running',
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

// 404 handler for API routes only
app.use('/api/*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `API Route ${req.originalUrl} not found`
  });
});

const PORT = process.env.PORT || 4001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
