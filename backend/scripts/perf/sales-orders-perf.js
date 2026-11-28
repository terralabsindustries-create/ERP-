#!/usr/bin/env node
/**
 * Timing of the sales-order queue and the server-side price call at volume, on a
 * disposable local database (dropped at the end). Refuses non-local URIs.
 *   node scripts/perf/sales-orders-perf.js [products=5000] [orders=20000]
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'perf';
const mongoose = require('mongoose');
const request = require('supertest');
const uri = `mongodb://127.0.0.1:27017/terralabs_perf_so_${process.pid}`;
const PRODUCTS = Number(process.argv[2]) || 5000;
const ORDERS = Number(process.argv[3]) || 20000;

(async () => {
  await mongoose.connect(uri);
  const app = require('../../src/app');
  const { createOrg, auth } = require('../../tests/helpers/fixtures');
  const make = require('../../tests/helpers/factories');
  const ProductRate = require('../../src/models/ProductRate');
  const Job = require('../../src/models/Job');
  await ProductRate.init(); await Job.init();
  const org = await createOrg('perf');
  const cust = await make.customer(org.admin, { name: 'Perf Customer', customerType: 'Agency', phone: '9000000009' });
  const mk = (i) => ({ userId: org.admin._id, dataScope: org.dataScope, materialType: ['Flex', 'Vinyl', 'Paper', 'Card'][i % 4], productName: `Product ${i}`, productCode: `P${i}`, unit: 'pieces', gstRate: 18,
    rules: [{ slabs: [{ from: 1, to: 100, exclusiveRate: 15, inclusiveRate: 17.7 }, { from: 101, to: null, exclusiveRate: 12, inclusiveRate: 14.16 }] }, { partyType: 'Agency', slabs: [{ from: 1, to: null, exclusiveRate: 8, inclusiveRate: 9.44 }] }, { customerId: cust._id, slabs: [{ from: 1, to: null, exclusiveRate: 7, inclusiveRate: 8.26 }] }] });
  for (let i = 0; i < PRODUCTS; i += 1000) await ProductRate.insertMany(Array.from({ length: Math.min(1000, PRODUCTS - i) }, (_, k) => mk(i + k)));
  const jobs = (i) => ({ title: `Order ${i}`, customerId: cust._id, customerName: 'Perf Customer', isSalesOrder: true, orderNumber: `SO-202611-${String(i).padStart(6, '0')}`, orderDate: new Date(Date.now() - i * 60000), orderTotals: { total: 1000 + i }, approval: { status: ['pending', 'approved', 'cancelled'][i % 3] }, customerSnapshot: { mobile: '9000000009' }, status: 'inquiry', createdBy: org.admin._id, userId: org.admin._id, dataScope: org.dataScope });
  for (let i = 0; i < ORDERS; i += 2000) await Job.collection.insertMany(Array.from({ length: Math.min(2000, ORDERS - i) }, (_, k) => ({ ...jobs(i + k), createdAt: new Date(), updatedAt: new Date() })));
  const get = (u) => request(app).get(u).set(auth(org.tokens.admin));
  const time = async (label, fn, n = 20) => { const ts = []; for (let i = 0; i < n; i += 1) { const t = process.hrtime.bigint(); const r = await fn(); if (r.status >= 400) throw new Error(`${label}: ${r.status}`); ts.push(Number(process.hrtime.bigint() - t) / 1e6); } ts.sort((a, b) => a - b); console.log(`${label.padEnd(44)} median ${ts[Math.floor(n / 2)].toFixed(1)} ms   p95 ${ts[Math.floor(n * 0.95)].toFixed(1)} ms`); };
  const ids = (await ProductRate.find({}).limit(8).select('_id').lean()).map((p) => String(p._id));
  console.log(`${PRODUCTS} products, ${ORDERS} orders`);
  await time('GET /sales-orders (page 1)', () => get('/api/sales-orders?limit=15'));
  await time('GET /sales-orders?approval=pending', () => get('/api/sales-orders?approval=pending&limit=15'));
  await time('GET /sales-orders?search=SO-202611-0123', () => get('/api/sales-orders?search=SO-202611-0123'));
  await time('GET /sales-orders?search=Perf (customer)', () => get('/api/sales-orders?search=Perf&limit=15'));
  await time('GET /sales-orders deep page 500', () => get('/api/sales-orders?page=500&limit=15'));
  await time('GET /product-rates?search=Product 42', () => get('/api/product-rates?search=Product%2042&limit=8'));
  await time('GET /product-rates?materialType=Flex', () => get('/api/product-rates?materialType=Flex&limit=15'));
  await time('POST /product-rates/price (1 line)', () => request(app).post('/api/product-rates/price').set(auth(org.tokens.admin)).send({ customerId: String(cust._id), salesType: 'Retail', lines: [{ productId: ids[0], copies: 250 }] }));
  await time('POST /product-rates/price (8 lines, cached)', () => request(app).post('/api/product-rates/price').set(auth(org.tokens.admin)).send({ customerId: String(cust._id), salesType: 'Retail', lines: ids.map((productId) => ({ productId, copies: 250 })), otherCharges: [{ name: 'Delivery', amount: 100, gstRate: 18 }] }));
  const explain = await Job.find({ dataScope: org.dataScope, isSalesOrder: true, 'approval.status': 'pending' }).sort({ orderDate: -1 }).limit(15).explain('executionStats');
  console.log('queue index used:', JSON.stringify(explain.queryPlanner.winningPlan).includes('IXSCAN'), '· docs examined', explain.executionStats.totalDocsExamined, 'for', explain.executionStats.nReturned, 'returned');
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => { console.error(e); try { await mongoose.connection.dropDatabase(); } catch { /* ignore */ } process.exit(1); });
