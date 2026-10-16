// Minimal valid records for tests, created straight through the models.
const Customer = require('../../src/models/Customer');
const Job = require('../../src/models/Job');
const Invoice = require('../../src/models/Invoice');
const Task = require('../../src/models/Task');
const Inventory = require('../../src/models/Inventory');
const Delivery = require('../../src/models/Delivery');
const Event = require('../../src/models/Event');
const DiscountRule = require('../../src/models/DiscountRule');
const Payment = require('../../src/models/Payment');

let n = 0;
const next = () => ++n;

const owned = (user) => ({ userId: user._id, createdBy: user._id, dataScope: user.dataScope });

const customer = (user, extra = {}) =>
  Customer.create({ name: `Customer ${next()}`, phone: `98${String(next()).padStart(8, '0')}`, email: `c${next()}@example.test`, status: 'active', ...owned(user), ...extra });

const job = (user, cust, extra = {}) =>
  Job.create({ title: `Job ${next()}`, customerId: cust._id, status: 'design_in_progress', priority: 'medium', ...owned(user), ...extra });

/**
 * An invoice with one line per entry in `lines` ([{ amount, rate }]). Tax is
 * split CGST/SGST unless interState. The pre-save hook totals it.
 */
const invoice = (user, cust, { lines = [{ amount: 1000, rate: 18 }], interState = false, ...extra } = {}) => {
  const items = lines.map(({ amount, rate }, i) => {
    const tax = Math.round(amount * rate) / 100;
    return {
      itemName: `Line ${i + 1}`,
      quantity: 1,
      unitPrice: amount,
      totalAmount: amount,
      gstRate: rate,
      cgstAmount: interState ? 0 : tax / 2,
      sgstAmount: interState ? 0 : tax / 2,
      igstAmount: interState ? tax : 0,
      gstAmount: tax,
      itemTotal: amount + tax
    };
  });
  const taxable = items.reduce((s, i) => s + i.totalAmount, 0);
  const gst = items.reduce((s, i) => s + i.gstAmount, 0);
  return Invoice.create({
    invoiceNumber: `INV-T-${next()}`,
    customerId: cust._id,
    customerName: cust.name,
    invoiceDate: new Date(),
    dueDate: new Date(Date.now() + 7 * 864e5),
    items,
    subtotal: taxable,
    taxableAmount: taxable,
    totalGstAmount: gst,
    totalAmount: taxable + gst,
    isInterState: interState,
    status: 'sent',
    ...owned(user),
    ...extra
  });
};

const task = (assigner, assignee, extra = {}) =>
  Task.create({ title: `Task ${next()}`, assignedTo: assignee._id, userId: assigner._id, dataScope: assigner.dataScope, priority: 'medium', ...extra });

const stockItem = (user, extra = {}) =>
  Inventory.create({ name: `Paper ${next()}`, category: 'Paper & Printing Materials', quantity: 2, unit: 'reams', unitCost: 100, minStockLevel: 5, status: 'active', ...owned(user), ...extra });

const delivery = (user, cust, j, extra = {}) =>
  Delivery.create({
    deliveryId: `DEL-T-${next()}`,
    jobId: j._id,
    customerId: cust._id,
    customerName: cust.name,
    deliveryAddress: { street: '1 Press Lane', city: 'Kochi', state: 'Kerala', pincode: '682011' },
    contactInfo: { phone: '9800000000' },
    deliveryDate: new Date(),
    status: 'scheduled',
    ...owned(user),
    ...extra
  });

const event = (user, extra = {}) =>
  Event.create({ title: `Event ${next()}`, startDate: new Date(), endDate: new Date(Date.now() + 3600e3), ...owned(user), ...extra });

const discountRule = (user, extra = {}) =>
  DiscountRule.create({ name: `Rule ${next()}`, type: 'percentage', value: 5, validFrom: new Date(), ...owned(user), ...extra });

const payment = (user, cust, extra = {}) =>
  Payment.create({ paymentId: `PAY-T-${next()}`, customerId: cust._id, customerName: cust.name, amount: 500, paymentMethod: 'cash', status: 'completed', ...owned(user), ...extra });

module.exports = { customer, job, invoice, task, stockItem, delivery, event, discountRule, payment };
