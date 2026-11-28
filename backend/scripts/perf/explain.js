#!/usr/bin/env node
/**
 * Query-plan check for the hot list/count queries, on a seeded throwaway DB.
 *   node scripts/perf/explain.js
 * Prints, per query, the winning plan's stages and docs examined vs returned.
 * An in-memory SORT or COLLSCAN on a scoped list means an index is missing.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'bench';
const mongoose = require('mongoose');
const origLog = console.log;
console.log = () => {}; console.warn = () => {};
const out = (...a) => origLog(...a);

const stages = (p, acc = []) => { if (!p) return acc; acc.push(p.stage); (p.inputStages || []).forEach((s) => stages(s, acc)); if (p.inputStage) stages(p.inputStage, acc); return acc; };

(async () => {
  const db = `terralabs_explain_${process.pid}`;
  await mongoose.connect(`mongodb://127.0.0.1:27017/${db}`);
  const { seed } = require('./seed');
  require('../../src/models/SubscriptionPurchase');
  const org = await seed();
  const M = (n) => mongoose.model(n);
  const ds = org.dataScope;
  const OPEN = { $nin: ['completed', 'delivered', 'cancelled'] };
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const queries = [
    ['Job list newest', () => M('Job').find({ dataScope: ds }).sort({ createdAt: -1 }).limit(25)],
    ['Job open count', () => M('Job').find({ dataScope: ds, status: OPEN })],
    ['Job overdue count', () => M('Job').find({ dataScope: ds, status: OPEN, dueDate: { $lt: today } })],
    ['Job by customer', () => M('Job').find({ dataScope: ds, customerId: org.someCustomer }).sort({ createdAt: -1 })],
    ['Customer list newest', () => M('Customer').find({ dataScope: ds }).sort({ createdAt: -1 }).limit(100)],
    ['Customer list by name', () => M('Customer').find({ dataScope: ds }).sort({ name: 1 }).limit(100)],
    ['Invoice list by date', () => M('Invoice').find({ dataScope: ds }).sort({ invoiceDate: -1 }).limit(25)],
    ['Invoices of jobs (job list)', () => M('Invoice').find({ jobId: { $in: [org.someJob] } })],
    ['Invoice by customer', () => M('Invoice').find({ dataScope: ds, customerId: org.someCustomer })],
    ['Invoice unpaid overdue', () => M('Invoice').find({ dataScope: ds, status: { $nin: ['draft', 'cancelled'] }, balanceAmount: { $gt: 0 }, dueDate: { $lt: today } })],
    ['Counter jobs active', () => M('WalkInJob').find({ dataScope: ds, status: { $in: ['waiting', 'in_progress', 'ready'] } }).sort({ createdAt: -1 }).limit(100)],
    ['Admins of business', () => M('User').find({ dataScope: ds, role: 'admin' })],
    ['Notifications', () => M('Notification').find({ recipient: org.admin._id }).sort({ createdAt: -1 }).limit(30)],
    ['My overdue tasks', () => M('Task').find({ assignedTo: org.staff1._id, status: { $nin: ['completed', 'cancelled'] }, dueDate: { $lt: today } })],
    ['Paid purchases', () => M('SubscriptionPurchase').find({ workspaceKey: `scope:${ds}`, status: 'paid' })]
  ];
  for (const [label, q] of queries) {
    const e = await q().explain('executionStats');
    const s = e.executionStats || e[0]?.executionStats;
    const plan = stages((e.queryPlanner || e[0]?.queryPlanner).winningPlan.queryPlan || (e.queryPlanner || e[0]?.queryPlanner).winningPlan);
    const flag = plan.includes('COLLSCAN') ? 'COLLSCAN' : plan.includes('SORT') ? 'IN-MEMORY SORT' : 'ok';
    out(`${label.padEnd(26)} ${flag.padEnd(15)} examined ${String(s.totalDocsExamined).padStart(6)} keys ${String(s.totalKeysExamined).padStart(6)} returned ${String(s.nReturned).padStart(5)}  [${plan.join(' < ')}]`);
  }
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
})().catch(async (e) => { origLog(e); await mongoose.connection.dropDatabase().catch(() => {}); process.exit(1); });
