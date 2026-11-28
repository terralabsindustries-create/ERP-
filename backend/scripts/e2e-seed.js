#!/usr/bin/env node
/**
 * Seeds the browser-test database (E2E_MONGODB_URI, default
 * mongodb://127.0.0.1:27017/terralabs_e2e) with one business and a login.
 * Drops that database first. Refuses any non-local URI and never reads
 * MONGODB_URI, so it cannot touch a real database.
 *
 *   login: e2e-admin@example.test / Passw0rd!
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
const mongoose = require('mongoose');
const uri = process.env.E2E_MONGODB_URI || 'mongodb://127.0.0.1:27017/terralabs_e2e';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) { console.error('Refusing a non-local E2E database'); process.exit(1); }

(async () => {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  const { createOrg } = require('../tests/helpers/fixtures');
  const make = require('../tests/helpers/factories');
  const User = require('../src/models/User');
  const org = await createOrg('e2e');
  await User.updateOne({ _id: org.admin._id }, { $set: { email: 'e2e-admin@example.test', fullName: 'E2E Admin', companyName: 'E2E Printers' } });
  // A running paid plan, so the "Choose your plan" prompt does not cover the app.
  const svc = require('../src/services/subscriptionService');
  const SubscriptionPurchase = require('../src/models/SubscriptionPurchase');
  await SubscriptionPurchase.create({ workspaceKey: svc.workspaceKeyFor(org.admin), dataScope: org.dataScope, purchasedBy: org.admin._id, packId: 'm12', months: 12, amountPaise: 1, orderId: `order_e2e_${Date.now()}`, status: 'paid', paidAt: new Date(), settledAt: new Date(), settledVia: 'sync' });
  const customer = await make.customer(org.admin, { name: 'Seed Customer', phone: '9812345678' });
  await make.job(org.admin, customer, { title: 'Seed Job Ticket', estimatedCost: 5000 });
  await make.stockItem(org.admin, { name: 'Seed Paper', quantity: 100, unit: 'sheets', sellingPrice: 5 });
  await make.invoice(org.admin, customer, { lines: [{ amount: 1000, rate: 18 }] });
  console.log(`E2E database ready: ${uri}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
