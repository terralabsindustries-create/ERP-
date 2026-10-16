const mongoose = require('mongoose');
const Invoice = require('./src/models/Invoice');
require('dotenv').config();

// The connection string comes from backend/.env only; it is never written in code.
mongoose.connect(process.env.MONGODB_URI)
.then(async () => {
  try {
    const invoices = await Invoice.find({
      invoiceNumber: { $regex: 'INV-202603' }
    }).select('invoiceNumber createdAt');
    
    console.log('Existing invoices for March 2026:');
    console.log(JSON.stringify(invoices, null, 2));
    
    // Also check for the specific duplicate
    const duplicate = await Invoice.findOne({
      invoiceNumber: 'INV-202603-0001'
    });
    
    if (duplicate) {
      console.log('\nFound duplicate invoice:');
      console.log(JSON.stringify(duplicate, null, 2));
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
})
.catch(err => {
  console.error('Connection error:', err);
  process.exit(1);
});
