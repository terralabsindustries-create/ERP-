require('dotenv').config();
// Dates are reckoned in India time (day boundaries for overdue, "today",
// monthly figures) unless the host sets TZ explicitly.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const mongoose = require('mongoose');
const app = require('./app');

// Database connection is awaited in startServer below. Listening before it
// resolves lets login queries sit in Mongoose's buffer and time out.

// Auto-check for overdue invoices and send reminders (runs every hour)
const PaymentReminder = require('./models/PaymentReminder');
const Invoice = require('./models/Invoice');
const Customer = require('./models/Customer');
const Settings = require('./models/Settings');
const User = require('./models/User');
const { buildAndSendReminder } = require('./routes/paymentReminders');
const { settingsOwnerId } = require('./utils/businessSettings');

async function autoCheckPaymentReminders() {
  try {
    console.log('⏰ Running automatic payment reminder check...');

    // Find all users with autoSend enabled
    const allSettings = await Settings.find({ 'paymentReminders.autoSend': true, 'paymentReminders.enabled': true });

    for (const settings of allSettings) {
      try {
        const userId = settings.userId;
        const user = await User.findById(userId);
        if (!user || !user.isActive) continue;
        // Reminder rules belong to the business owner's settings; skip stray
        // copies other logins of the same business may have saved earlier.
        if (String(await settingsOwnerId(user)) !== String(user._id)) continue;

        const dataScope = user.dataScope;
        const config = settings.paymentReminders;
        const now = new Date();

        const invoiceQuery = dataScope ? { dataScope } : { userId };
        const invoices = await Invoice.find({
          ...invoiceQuery,
          paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
          dueDate: { $lt: now },
          status: { $nin: ['cancelled', 'refunded'] },
          balanceAmount: { $gt: 0 }
        });

        let sentCount = 0;
        for (const invoice of invoices) {
          try {
            const customer = await Customer.findById(invoice.customerId);
            if (!customer?.phone || customer.whatsappConsent === false) continue;

            const daysOverdue = Math.ceil((now.getTime() - new Date(invoice.dueDate).getTime()) / (1000 * 60 * 60 * 24));
            if (daysOverdue < (config.daysAfterDue || 1)) continue;

            const reminderCount = await PaymentReminder.getReminderCountForInvoice(invoice._id, userId);
            if (reminderCount >= (config.maxReminders || 5)) continue;

            const lastDate = await PaymentReminder.getLastReminderDate(invoice._id, userId);
            if (lastDate) {
              const daysSince = Math.ceil((now.getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24));
              if (daysSince < (config.reminderInterval || 3)) continue;
            }

            const { whatsappResult } = await buildAndSendReminder({ invoice, customer, settings, userId, dataScope, reminderCount });
            if (whatsappResult.success) sentCount++;
          } catch (err) {
            console.error(`Auto-reminder error for invoice ${invoice.invoiceNumber}:`, err.message);
          }
        }
        if (sentCount > 0) {
          console.log(`✅ Auto-sent ${sentCount} payment reminders for user ${user.email}`);
        }
      } catch (err) {
        console.error('Auto-reminder user error:', err.message);
      }
    }
  } catch (error) {
    console.error('❌ Auto payment reminder check failed:', error.message);
  }
}

// Run auto-check every hour (3600000ms)

const PORT = process.env.PORT || 4001;

// Secrets are shown as a length plus their last 4 characters — enough to tell at
// a glance that the right value loaded, without putting the credential itself in
// a log file, a screenshot, or a support thread.
const maskSecret = (value) =>
  !value ? '❌ MISSING' : `✅ set (${value.length} chars, ends ${value.slice(-4)})`;

async function startServer() {
  const mongoUri = (process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/print_arts_flow')
    .replace('localhost', '127.0.0.1');
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exitCode = 1;
    return;
  }

  // Starter roles from an older release pick up what the current one adds.
  require('./utils/upgradePresetRoles').upgradePresetRoles()
    .then(({ upgraded }) => upgraded && console.log(`🔐 Updated ${upgraded} starter role(s) to the current permissions`))
    .catch((err) => console.error('Starter role upgrade failed:', err.message));

  setInterval(autoCheckPaymentReminders, 3600000);
  setTimeout(autoCheckPaymentReminders, 30000);

  return app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('🔧 Integration config loaded from .env:');
    console.log(`   FACEBOOK_APP_ID     ${process.env.FACEBOOK_APP_ID || '❌ MISSING'}`);
    console.log(`   FACEBOOK_APP_SECRET ${maskSecret(process.env.FACEBOOK_APP_SECRET)}`);
    console.log(`   EMAIL_USER          ${process.env.EMAIL_USER || '❌ MISSING'}`);
    console.log(`   MONGODB_URI         ${process.env.MONGODB_URI ? '✅ set' : '❌ MISSING'}`);
  });
}

if (require.main === module) startServer();

module.exports = app;
module.exports.startServer = startServer;
