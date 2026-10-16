require('dotenv').config();
// Dates are reckoned in India time (day boundaries for overdue, "today",
// monthly figures) unless the host sets TZ explicitly.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const mongoose = require('mongoose');
const app = require('./app');

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
setInterval(autoCheckPaymentReminders, 3600000);
// Also run once after a short delay on startup
setTimeout(autoCheckPaymentReminders, 30000);

const PORT = process.env.PORT || 4001;

// Secrets are shown as a length plus their last 4 characters — enough to tell at
// a glance that the right value loaded, without putting the credential itself in
// a log file, a screenshot, or a support thread.
const maskSecret = (value) =>
  !value ? '❌ MISSING' : `✅ set (${value.length} chars, ends ${value.slice(-4)})`;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('🔧 Integration config loaded from .env:');
  console.log(`   FACEBOOK_APP_ID     ${process.env.FACEBOOK_APP_ID || '❌ MISSING'}`);
  console.log(`   FACEBOOK_APP_SECRET ${maskSecret(process.env.FACEBOOK_APP_SECRET)}`);
  console.log(`   EMAIL_USER          ${process.env.EMAIL_USER || '❌ MISSING'}`);
  console.log(`   MONGODB_URI         ${process.env.MONGODB_URI ? '✅ set' : '❌ MISSING'}`);
});

module.exports = app;
