/**
 * Monthly report download (PDF / Excel): figures come from the server's report
 * of the caller's business, the notes are included, and the export permission
 * is required.
 */
const request = require('supertest');
const ExcelJS = require('exceljs');
const app = require('../src/app');
const User = require('../src/models/User');
const ActivityLog = require('../src/models/ActivityLog');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
const month = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  await connectTestDb('reports_download');
  org = await createOrg('rd');
  const other = await createOrg('rdx');
  const cust = await make.customer(org.admin, { name: 'Lotus Publications' });
  await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 18 }, { amount: 500, rate: 5 }] });
  await make.invoice(org.admin, cust, { status: 'draft', lines: [{ amount: 9999, rate: 18 }] });
  await make.invoice(other.admin, await make.customer(other.admin), { lines: [{ amount: 7777, rate: 18 }] });
});
afterAll(disconnectTestDb);

describe('monthly report download', () => {
  test('Excel carries the issued figures of this business and the notes', async () => {
    const res = await request(app).post('/api/reports/revenue/download').set(auth(org.tokens.admin))
      .send({ month, format: 'xlsx', notes: 'Two credit notes expected next month' })
      .buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`Monthly_report_.*_${month}\\.xlsx`));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const rows = [];
    wb.worksheets[0].eachRow((r) => rows.push(r.values.slice(1)));
    const find = (label) => rows.find((r) => r[0] === label);
    expect(find('Invoices issued')[1]).toBe(1);
    expect(find('Taxable value')[1]).toBe(1500);
    expect(find('GST')[1]).toBe(205);
    expect(find('18%')).toEqual(['18%', 1, 1000, 180]);
    expect(rows.some((r) => r[0] === 'Two credit notes expected next month')).toBe(true);
    // Neither the draft nor the other business's invoice leaks in.
    expect(JSON.stringify(rows)).not.toMatch(/9999|7777/);
    expect(await ActivityLog.countDocuments({ action: 'Monthly Report Downloaded', userId: org.admin._id })).toBeGreaterThan(0);
  });

  test('PDF is a real PDF', async () => {
    const res = await request(app).post('/api/reports/revenue/download').set(auth(org.tokens.admin))
      .send({ month, format: 'pdf' }).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(2000);
  });

  test('rejects a bad month or format', async () => {
    const send = (body) => request(app).post('/api/reports/revenue/download').set(auth(org.tokens.admin)).send(body);
    expect((await send({ month: '2026-13', format: 'pdf' })).status).toBe(400);
    expect((await send({ month, format: 'docx' })).status).toBe(400);
  });

  test('needs Reports: Export', async () => {
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Reports', 'Reports: View'] });
    const res = await request(app).post('/api/reports/revenue/download').set(auth(org.tokens.staff1)).send({ month, format: 'pdf' });
    expect(res.status).toBe(403);
  });
});
