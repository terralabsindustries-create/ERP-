#!/usr/bin/env node
/**
 * Adds sales-order test data to the browser-test database created by
 * e2e-seed.js: an Agency customer and the "Star Flex" product with rate rules.
 * Local databases only (same guard as e2e-seed.js); never reads MONGODB_URI.
 */
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const uri = process.env.E2E_MONGODB_URI || 'mongodb://127.0.0.1:27017/terralabs_e2e';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri)) { console.error('Refusing a non-local E2E database'); process.exit(1); }
(async () => {
  await mongoose.connect(uri);
  const User = require('../src/models/User');
  const ProductRate = require('../src/models/ProductRate');
  const make = require('../tests/helpers/factories');
  const admin = await User.findOne({ email: 'e2e-admin@example.test' });
  await make.customer(admin, { name: 'Agency Annie', customerType: 'Agency', phone: '9000000002' });
  await ProductRate.create({
    userId: admin._id, dataScope: admin.dataScope, materialType: 'Flex', productName: 'Star Flex 280gsm', productCode: 'FLX280', unit: 'pieces', gstRate: 18,
    rules: [
      { slabs: [{ from: 1, to: 100, exclusiveRate: 15, inclusiveRate: 17.7, rateBasis: 'exclusive' }, { from: 101, to: null, exclusiveRate: 12, inclusiveRate: 14.16, rateBasis: 'exclusive' }] },
      { partyType: 'Agency', slabs: [{ from: 1, to: null, exclusiveRate: 8, inclusiveRate: 9.44, rateBasis: 'exclusive' }] }
    ]
  });
  await ProductRate.create({
    userId: admin._id, dataScope: admin.dataScope, materialType: 'Vinyl', productName: 'Agency Only Vinyl', productCode: 'VNL1', unit: 'pieces', gstRate: 18,
    rules: [{ partyType: 'Agency', slabs: [{ from: 1, to: null, exclusiveRate: 5, inclusiveRate: 5.9, rateBasis: 'exclusive' }] }]
  });
  console.log(`Sales-order E2E data ready: ${uri}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
