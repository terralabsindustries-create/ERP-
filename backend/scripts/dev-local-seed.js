#!/usr/bin/env node
/**
 * Creates a LOCAL development database with one business and a login, for
 * working without the Atlas cluster (e.g. when this machine's IP is not on
 * Atlas's Network Access list). Never reads MONGODB_URI, refuses non-local
 * databases, and refuses to run if the database already has users.
 *
 *   npm run dev:seed          (from backend/)
 *   login: dev-admin@example.test / Passw0rd!
 */
process.env.NODE_ENV = 'test'; // fixtures use cheap password hashing
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-local-secret';
const mongoose = require('mongoose');
const uri = process.env.DEV_MONGODB_URI || 'mongodb://127.0.0.1:27017/terra_dev';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) { console.error('Refusing a non-local database'); process.exit(1); }

(async () => {
  await mongoose.connect(uri);
  const User = require('../src/models/User');
  if (await User.countDocuments()) { console.log(`${uri} already has users; nothing changed.`); await mongoose.disconnect(); return; }
  const { createOrg } = require('../tests/helpers/fixtures');
  const make = require('../tests/helpers/factories');
  const svc = require('../src/services/subscriptionService');
  const SubscriptionPurchase = require('../src/models/SubscriptionPurchase');
  const org = await createOrg('dev');
  await User.updateOne({ _id: org.admin._id }, { $set: { email: 'dev-admin@example.test', fullName: 'Dev Admin', companyName: 'Dev Printers' } });
  await SubscriptionPurchase.create({ workspaceKey: svc.workspaceKeyFor(org.admin), dataScope: org.dataScope, purchasedBy: org.admin._id, packId: 'm12', months: 12, amountPaise: 1, orderId: `order_dev_${Date.now()}`, status: 'paid', paidAt: new Date(), settledAt: new Date(), settledVia: 'sync' });
  await make.customer(org.admin, { name: 'Sample Customer', phone: '9812345678' });
  await make.stockItem(org.admin, { name: 'Sample Paper', quantity: 500, unit: 'sheets', sellingPrice: 5 });
  console.log(`Local dev database ready: ${uri}\nLogin: dev-admin@example.test / Passw0rd!`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
