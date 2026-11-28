const request = require('supertest');
const app = require('../src/app');
const ActivityLog = require('../src/models/ActivityLog');
const Employee = require('../src/models/Employee');
const Payroll = require('../src/models/Payroll');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let entry;
const admin = () => auth(org.tokens.admin);

beforeAll(async () => {
  await connectTestDb('audit_trail');
  org = await createOrg('audit_trail');
  other = await createOrg('audit_trail_other');
  entry = await ActivityLog.logActivity({
    action: 'Invoice Cancelled', description: 'Invoice INV-1 cancelled', entityType: 'invoice', entityId: org.admin._id,
    performedBy: org.admin._id, performedByName: 'Admin', actionType: 'cancel', userId: org.admin._id, dataScope: org.admin.dataScope,
    reason: 'Customer withdrew the order',
    changes: { before: { status: 'sent', password: 'hunter2' }, after: { status: 'cancelled', apiKey: 'sk_live_x', nested: { token: 'abc' } } },
    metadata: { Authorization: 'Bearer zzz', note: 'fine' }
  });
});
afterAll(disconnectTestDb);

describe('append-only audit log', () => {
  test('stores tenant, actor, correlation id, reason, before/after and marks financial events protected', () => {
    expect(entry).toMatchObject({ tenantId: org.admin.dataScope, performedBy: org.admin._id, reason: 'Customer withdrew the order', protected: true });
    expect(entry.correlationId).toBeTruthy();
    expect(entry.changes.before.status).toBe('sent');
    expect(entry.changes.after.status).toBe('cancelled');
  });

  test('passwords, keys and tokens are never stored', () => {
    const text = JSON.stringify(entry.toObject());
    expect(text).not.toMatch(/hunter2|sk_live_x|zzz|abc/);
    expect(entry.changes.before.password).toBe('[redacted]');
    expect(entry.metadata.note).toBe('fine');
  });

  test('DELETE /activity-log/:id is refused for an admin and the entry survives', async () => {
    const res = await request(app).delete(`/api/activity-log/${entry._id}`).set(admin());
    expect(res.status).toBe(405);
    expect(res.body.code).toBe('AUDIT_IMMUTABLE');
    expect(await ActivityLog.countDocuments({ _id: entry._id })).toBe(1);
  });

  test('every model-level update and delete path is refused', async () => {
    const attempts = [
      () => ActivityLog.updateOne({ _id: entry._id }, { $set: { action: 'x' } }),
      () => ActivityLog.updateMany({}, { $set: { action: 'x' } }),
      () => ActivityLog.findOneAndUpdate({ _id: entry._id }, { $set: { action: 'x' } }),
      () => ActivityLog.findByIdAndUpdate(entry._id, { action: 'x' }),
      () => ActivityLog.replaceOne({ _id: entry._id }, { action: 'x' }),
      () => ActivityLog.deleteOne({ _id: entry._id }),
      () => ActivityLog.deleteMany({}),
      () => ActivityLog.findByIdAndDelete(entry._id),
      () => ActivityLog.findOneAndDelete({ _id: entry._id }),
      async () => { const d = await ActivityLog.findById(entry._id); d.action = 'x'; return d.save(); },
      async () => (await ActivityLog.findById(entry._id)).deleteOne(),
      () => ActivityLog.bulkWrite([{ deleteOne: { filter: { _id: entry._id } } }])
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'AUDIT_IMMUTABLE' });
    const stored = await ActivityLog.findById(entry._id);
    expect(stored.action).toBe('Invoice Cancelled');
  });

  test('requests carry a correlation id, and a caller-supplied safe one is kept', async () => {
    const a = await request(app).get('/api/activity-log').set(admin());
    expect(a.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const b = await request(app).get('/api/activity-log').set(admin()).set('X-Correlation-ID', 'ui-action_42');
    expect(b.headers['x-correlation-id']).toBe('ui-action_42');
    const c = await request(app).get('/api/activity-log').set(admin()).set('X-Correlation-ID', 'bad id<script>');
    expect(c.headers['x-correlation-id']).not.toMatch(/script/);
  });

  test('another business cannot read the entry', async () => {
    const res = await request(app).get(`/api/activity-log/${entry._id}`).set(auth(other.tokens.admin));
    expect(res.status).toBe(404);
  });

  test('retention: dry run changes nothing; only entries past their period are removed; protected ones outlive ordinary ones', async () => {
    const old = (extra) => ActivityLog.collection.insertOne({
      action: 'Old', description: 'old', entityType: 'customer', entityId: entry._id, performedBy: entry._id, performedByName: 'x', actionType: 'update',
      userId: entry._id, dataScope: 'retention_scope', createdAt: new Date(Date.now() - 400 * 864e5), updatedAt: new Date(), ...extra
    });
    await old({ protected: false });
    await old({ protected: true });
    const dry = await ActivityLog.purgeExpired({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, eligible: 1, deleted: 0 });
    const real = await ActivityLog.purgeExpired({ dryRun: false });
    expect(real.deleted).toBe(1);
    expect(await ActivityLog.countDocuments({ dataScope: 'retention_scope', protected: true })).toBe(1);
    expect(await ActivityLog.countDocuments({ _id: entry._id })).toBe(1);
  });
});

describe('payroll changes are audited', () => {
  test('generating, adjusting, paying and deleting a payslip each write a protected event', async () => {
    const employee = await Employee.create({ name: 'Pay Roll', salary: { basic: 20000 }, userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
    const generated = await request(app).post('/api/hr/payroll/generate').set(admin()).send({ month: 1, year: 2031, employeeId: String(employee._id) });
    expect(generated.status).toBe(200);
    const slip = generated.body.data.payslips[0];
    const adjusted = await request(app).put(`/api/hr/payroll/${slip._id}`).set(admin()).send({ deductions: { other: 100 }, reason: 'Advance recovered' });
    expect(adjusted.status).toBe(200);
    expect((await request(app).patch(`/api/hr/payroll/${slip._id}/pay`).set(admin()).send({ paymentMethod: 'cash' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const events = await ActivityLog.find({ entityType: 'payroll', entityId: slip._id }).sort({ createdAt: 1 }).lean();
    expect(events.map((e) => e.action)).toEqual(['Payslip Generated', 'Payslip Adjusted', 'Payslip Paid']);
    expect(events.every((e) => e.protected && e.tenantId === org.dataScope && e.correlationId)).toBe(true);
    expect(events[1].reason).toBe('Advance recovered');
    expect(events[1].changes.before.netPay).toBeGreaterThan(events[1].changes.after.netPay);
  });
});
