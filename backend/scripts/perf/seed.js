/** Representative data for the perf scripts: one business plus noise from another. */
const mongoose = require('mongoose');

async function seed() {
  const { createOrg } = require('../../tests/helpers/fixtures');
  const Customer = require('../../src/models/Customer');
  const Job = require('../../src/models/Job');
  const Invoice = require('../../src/models/Invoice');
  const Notification = require('../../src/models/Notification');
  const WalkInJob = require('../../src/models/WalkInJob');
  const Task = require('../../src/models/Task');

  const org = await createOrg('bench', { staffPermissions: ['Dashboard', 'Jobs', 'Customers'] });
  const own = { userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope };
  // Noise from other businesses so scoped queries must use indexes.
  const other = await createOrg('noise');
  const otherOwn = { userId: other.admin._id, createdBy: other.admin._id, dataScope: other.dataScope };

  const mkCustomers = (n, o, tag) => Array.from({ length: n }, (_, i) => ({
    name: `${tag} Customer ${i}`, company: `${tag} Co ${i % 50}`, phone: `9${String(100000000 + i).slice(-9)}`,
    email: `${tag.toLowerCase()}${i}@example.test`, status: 'active', ...o
  }));
  const customers = await Customer.insertMany(mkCustomers(1500, own, 'Bench'));
  await Customer.insertMany(mkCustomers(3000, otherOwn, 'Noise'));

  const STAGES = ['inquiry', 'quotation_sent', 'design_in_progress', 'production_ready', 'ready_for_print', 'quality_check', 'completed', 'delivered'];
  const jobs = await Job.insertMany(Array.from({ length: 2000 }, (_, i) => ({
    title: `Bench Job ${i}`, description: 'Visiting cards 300gsm matt lamination', customerId: customers[i % customers.length]._id,
    status: STAGES[i % STAGES.length], priority: ['low', 'medium', 'high', 'urgent'][i % 4],
    dueDate: new Date(Date.now() + ((i % 20) - 5) * 864e5), ...own
  })));
  const items = Array.from({ length: 6 }, (_, k) => ({
    itemName: `Line ${k}`, description: 'Art paper 170gsm, 4 colour both sides, matt lamination, cut to size',
    quantity: 1000, unitPrice: 2, totalAmount: 2000, gstRate: 18, cgstAmount: 180, sgstAmount: 180, igstAmount: 0, gstAmount: 360, itemTotal: 2360
  }));
  const invoiceDocs = jobs.slice(0, 1800).map((j, i) => ({
    invoiceNumber: `INV-B-${i}`, customerId: j.customerId, customerName: 'Bench', invoiceDate: new Date(Date.now() - i * 36e5),
    dueDate: new Date(Date.now() + ((i % 30) - 15) * 864e5), items, subtotal: 12000, taxableAmount: 12000, totalGstAmount: 2160,
    totalAmount: 14160, balanceAmount: i % 3 ? 0 : 14160, paymentStatus: i % 3 ? 'paid' : 'pending', status: 'sent', jobId: j._id, ...own
  }));
  const invoices = await Invoice.insertMany(invoiceDocs);
  await Job.bulkWrite(invoices.map((inv) => ({ updateOne: { filter: { _id: inv.jobId }, update: { $set: { invoices: [inv._id] } } } })));

  await WalkInJob.collection.insertMany(Array.from({ length: 600 }, (_, i) => ({
    jobNumber: `WJ-${i}`, customerName: `Walk ${i}`, customerPhone: '9800000000', jobType: 'printing', description: 'A4 prints',
    specifications: { quantity: 10 }, timeline: { promisedTime: new Date(), priority: 'normal', estimatedCompletion: new Date() },
    status: ['waiting', 'in_progress', 'ready', 'collected'][i % 4], createdAt: new Date(), updatedAt: new Date(), ...own
  })));
  await Notification.insertMany(Array.from({ length: 400 }, (_, i) => ({
    recipient: org.admin._id, dataScope: org.dataScope, type: 'task_assigned', title: `Task ${i}`, readAt: i % 2 ? new Date() : null
  })));
  await Task.insertMany(Array.from({ length: 500 }, (_, i) => ({
    title: `Task ${i}`, assignedTo: org.staff1._id, userId: org.admin._id, dataScope: org.dataScope, priority: 'medium',
    status: i % 3 ? 'pending' : 'completed', dueDate: new Date(Date.now() + ((i % 10) - 5) * 864e5)
  })));
  // Indexes must exist before measuring (autoIndex builds them in the background).
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).syncIndexes().catch(() => null)));
  org.someCustomer = customers[7]._id;
  org.someJob = jobs[7]._id;
  return org;
}


module.exports = { seed };
