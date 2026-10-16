/**
 * Proofing & approvals: creating proofs from uploaded files, the send /
 * approve / changes requested / new version workflow, the list views and
 * counts, validation, and isolation between businesses.
 */
const request = require('supertest');
const app = require('../src/app');
const Proof = require('../src/models/Proof');
const File = require('../src/models/File');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a; // the business under test
let b; // another business
let aJob;
let aCust;
let bJob;
let designerToken;

const fileFor = (user, name = 'artwork.pdf') =>
  File.create({
    fileName: `file-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
    originalName: name,
    fileUrl: `/uploads/files/${name}`,
    fileType: '.pdf',
    fileSize: 2048,
    mimeType: 'application/pdf',
    category: 'proof',
    uploadedBy: user._id,
    uploadedByName: user.fullName,
    userId: user._id
  });

const asA = (method, url) => request(app)[method](url).set(auth(a.tokens.admin));
const asB = (method, url) => request(app)[method](url).set(auth(b.tokens.admin));

const newProof = async (overrides = {}) => {
  const f = await fileFor(a.admin);
  const res = await asA('post', '/api/proofs').send({
    jobId: aJob._id,
    title: 'Visiting card front and back',
    specifications: { paperSize: '3.5 x 2 in', paperType: '350gsm art card', colorMode: 'color', quantity: 1000, finishing: ['Matt lamination'] },
    files: [{ fileId: f._id }],
    ...overrides
  });
  return res;
};

beforeAll(async () => {
  await connectTestDb('proofs');
  a = await createOrg('pa', { staffPermissions: ['Job Proofing', 'Job Proofing: View'] });
  b = await createOrg('pb');
  aCust = await make.customer(a.admin, { name: 'Malabar Traders', phone: '9847000000' });
  aJob = await make.job(a.admin, aCust, { title: 'Malabar visiting cards' });
  const bCust = await make.customer(b.admin, { name: 'Other Shop Customer' });
  bJob = await make.job(b.admin, bCust, { title: 'Other shop job' });
  designerToken = a.tokens.staff1;
  await Proof.init(); // build the unique index before testing duplicates
});
afterAll(disconnectTestDb);

describe('creating a proof', () => {
  test('saves a draft with a generated number, the job\'s customer and the business scope', async () => {
    const res = await newProof();
    expect(res.status).toBe(201);
    const p = res.body.data.proof;
    expect(p.proofNumber).toMatch(/^PRF\d{6}\d{3}$/);
    expect(p.status).toBe('draft');
    expect(p.version).toBe(1);
    expect(p.customerName).toBe('Malabar Traders');
    expect(p.customerPhone).toBe('9847000000');
    expect(p.jobId.title).toBe('Malabar visiting cards');
    expect(p.files).toHaveLength(1);
    expect(p.files[0].fileName).toBe('artwork.pdf');
    expect(p.files[0].fileId).toBeTruthy();
    expect(p.specifications.quantity).toBe(1000);
    const stored = await Proof.findById(p._id);
    expect(stored.dataScope).toBe(a.dataScope);
    expect(String(stored.userId)).toBe(String(a.admin._id));
  });

  test('can be created as sent, which starts the reply-by clock', async () => {
    const res = await newProof({ status: 'sent', sentVia: 'whatsapp' });
    expect(res.status).toBe(201);
    const p = res.body.data.proof;
    expect(p.status).toBe('sent');
    expect(p.notifications.sentAt).toBeTruthy();
    expect(p.notifications.whatsappSent).toBe(true);
    expect(new Date(p.approval.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 864e5);
  });

  test('numbers are unique across businesses and count up', async () => {
    const first = (await newProof()).body.data.proof.proofNumber;
    const fb = await fileFor(b.admin);
    const other = await asB('post', '/api/proofs').send({ jobId: bJob._id, title: 'Other proof', files: [{ fileId: fb._id }] });
    expect(other.status).toBe(201);
    const second = other.body.data.proof.proofNumber;
    expect(second).not.toBe(first);
    expect(Number(second.slice(9))).toBe(Number(first.slice(9)) + 1);
  });

  test('picks another number when the one it chose was just taken', async () => {
    const taken = (await newProof()).body.data.proof.proofNumber;
    const spy = jest.spyOn(Proof, 'nextProofNumber').mockResolvedValueOnce(taken);
    try {
      const res = await newProof();
      expect(res.status).toBe(201);
      expect(res.body.data.proof.proofNumber).not.toBe(taken);
    } finally {
      spy.mockRestore();
    }
  });

  test('rejects invalid input with 400', async () => {
    const f = await fileFor(a.admin);
    const cases = [
      { body: { jobId: aJob._id, files: [{ fileId: f._id }] }, msg: /title/i },
      { body: { jobId: aJob._id, title: '   ', files: [{ fileId: f._id }] }, msg: /title/i },
      { body: { jobId: aJob._id, title: 'No files', files: [] }, msg: /files/i },
      { body: { jobId: 'nope', title: 'Bad job', files: [{ fileId: f._id }] }, msg: /job/i },
      { body: { jobId: aJob._id, title: 'Bad file', files: [{ fileName: 'x.pdf' }] }, msg: /uploaded file/i },
      { body: { jobId: aJob._id, title: 'Bad status', status: 'approved', files: [{ fileId: f._id }] }, msg: /draft or as sent/i },
      { body: { jobId: aJob._id, title: 'Bad qty', specifications: { quantity: -4 }, files: [{ fileId: f._id }] }, msg: /quantity/i },
      { body: { jobId: aJob._id, title: 'Bad colour', specifications: { colorMode: 'neon' }, files: [{ fileId: f._id }] }, msg: /colour/i }
    ];
    for (const c of cases) {
      const res = await asA('post', '/api/proofs').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(c.msg);
    }
  });

  test("cannot use another business's job or uploaded file", async () => {
    const f = await fileFor(a.admin);
    const otherJob = await asA('post', '/api/proofs').send({ jobId: bJob._id, title: 'Steal job', files: [{ fileId: f._id }] });
    expect(otherJob.status).toBe(400);
    expect(otherJob.body.message).toMatch(/job not found/i);

    const fb = await fileFor(b.admin);
    const otherFile = await asA('post', '/api/proofs').send({ jobId: aJob._id, title: 'Steal file', files: [{ fileId: fb._id }] });
    expect(otherFile.status).toBe(400);
    expect(otherFile.body.message).toMatch(/not found/i);
  });
});

describe('the workflow', () => {
  let id;

  beforeAll(async () => {
    id = (await newProof({ title: 'Wedding card proof' })).body.data.proof._id;
  });

  test('mark as sent', async () => {
    const res = await asA('post', `/api/proofs/${id}/send`).send({ sentVia: 'whatsapp' });
    expect(res.status).toBe(200);
    expect(res.body.data.proof.status).toBe('sent');
    expect(res.body.data.proof.approval.expiresAt).toBeTruthy();
  });

  test('changes requested needs a reason', async () => {
    const empty = await asA('put', `/api/proofs/${id}/reject`).send({ rejectionReason: '  ' });
    expect(empty.status).toBe(400);
    const res = await asA('put', `/api/proofs/${id}/reject`).send({ rejectionReason: 'Make the names bigger' });
    expect(res.status).toBe(200);
    const p = res.body.data.proof;
    expect(p.status).toBe('rejected');
    expect(p.approval.rejectionReason).toBe('Make the names bigger');
    expect(p.feedback.revisions).toHaveLength(1);
    const again = await asA('put', `/api/proofs/${id}/reject`).send({ rejectionReason: 'Twice' });
    expect(again.status).toBe(400);
  });

  test('a rejected version cannot be re-sent; a new version is uploaded instead', async () => {
    const resend = await asA('post', `/api/proofs/${id}/send`).send({});
    expect(resend.status).toBe(400);

    const f = await fileFor(a.admin, 'wedding-v2.pdf');
    const res = await asA('post', `/api/proofs/${id}/versions`).send({ files: [{ fileId: f._id }], notes: 'Names enlarged to 14pt' });
    expect(res.status).toBe(200);
    const p = res.body.data.proof;
    expect(p.version).toBe(2);
    expect(p.status).toBe('revised');
    expect(p.versionNotes).toBe('Names enlarged to 14pt');
    expect(p.files[0].fileName).toBe('wedding-v2.pdf');
    expect(p.previousVersions).toHaveLength(1);
    expect(p.previousVersions[0].version).toBe(1);
    expect(p.previousVersions[0].status).toBe('rejected');
    expect(p.previousVersions[0].rejectionReason).toBe('Make the names bigger');
    expect(p.previousVersions[0].files[0].fileName).toBe('artwork.pdf');
    expect(p.approval.status).toBe('pending');
    expect(p.approval.rejectionReason).toBeUndefined();
    expect(p.feedback.revisions[0].status).toBe('completed');
  });

  test('a new version needs files', async () => {
    const res = await asA('post', `/api/proofs/${id}/versions`).send({ files: [] });
    expect(res.status).toBe(400);
  });

  test('editing details does not need the files again and cannot change the status', async () => {
    const res = await asA('put', `/api/proofs/${id}`).send({ title: 'Wedding card, gold foil', status: 'approved', specifications: { paperType: '300gsm pearl', quantity: 250 } });
    expect(res.status).toBe(200);
    expect(res.body.data.proof.title).toBe('Wedding card, gold foil');
    expect(res.body.data.proof.status).toBe('revised');
    expect(res.body.data.proof.files).toHaveLength(1);
    expect(res.body.data.proof.specifications.quantity).toBe(250);

    const bad = await asA('put', `/api/proofs/${id}`).send({ title: '' });
    expect(bad.status).toBe(400);
  });

  test('internal notes', async () => {
    const res = await asA('post', `/api/proofs/${id}/comments`).send({ comment: 'Customer will reply after 5 pm' });
    expect(res.status).toBe(200);
    const c = res.body.data.proof.feedback.comments;
    expect(c).toHaveLength(1);
    expect(c[0].commentedByName).toBe(a.admin.fullName);
    expect((await asA('post', `/api/proofs/${id}/comments`).send({ comment: '' })).status).toBe(400);
  });

  test('a login without the Approve action cannot record approval', async () => {
    const res = await request(app).put(`/api/proofs/${id}/approve`).set(auth(designerToken)).send({});
    expect(res.status).toBe(403);
  });

  test('record approval', async () => {
    const res = await asA('put', `/api/proofs/${id}/approve`).send({ approvedByName: 'Anil (groom)', channel: 'whatsapp', approvalNotes: 'OK to print' });
    expect(res.status).toBe(200);
    const p = res.body.data.proof;
    expect(p.status).toBe('approved');
    expect(p.approval.approvedByName).toBe('Anil (groom)');
    expect(p.approval.recordedByName).toBe(a.admin.fullName);
    expect(p.approval.approvedAt).toBeTruthy();
    expect((await asA('put', `/api/proofs/${id}/approve`).send({})).status).toBe(400);
  });
});

describe('list, views and counts', () => {
  test('the list shows the business\'s proofs with per-view counts', async () => {
    const res = await asA('get', '/api/proofs?limit=100');
    expect(res.status).toBe(200);
    const { proofs, summary, pagination } = res.body.data;
    expect(proofs.length).toBe(pagination.totalProofs);
    expect(summary.all).toBe(proofs.length);
    expect(summary.approved).toBe(proofs.filter((p) => p.status === 'approved').length);
    expect(summary.draft).toBe(proofs.filter((p) => p.status === 'draft').length);
    expect(summary.waiting).toBe(proofs.filter((p) => ['sent', 'revised'].includes(p.status)).length);
    expect(proofs.every((p) => p.customerName === 'Malabar Traders')).toBe(true);
  });

  test('views and search filter the list', async () => {
    const approved = (await asA('get', '/api/proofs?view=approved')).body.data.proofs;
    expect(approved.length).toBeGreaterThan(0);
    expect(approved.every((p) => p.status === 'approved')).toBe(true);

    const byJob = (await asA('get', '/api/proofs?search=malabar visiting')).body.data;
    expect(byJob.proofs.length).toBe(byJob.summary.all);
    expect(byJob.proofs.length).toBeGreaterThan(0);

    const one = approved[0];
    const byNumber = (await asA('get', `/api/proofs?search=${one.proofNumber}`)).body.data.proofs;
    expect(byNumber.map((p) => p._id)).toEqual([one._id]);

    const regexy = await asA('get', '/api/proofs?search=(((');
    expect(regexy.status).toBe(200);

    expect((await asA('get', '/api/proofs?view=bogus')).status).toBe(400);
  });

  test('overdue counts proofs waiting past their reply-by date', async () => {
    const created = (await newProof({ status: 'sent', title: 'Late reply' })).body.data.proof;
    await Proof.updateOne({ _id: created._id }, { 'approval.expiresAt': new Date(Date.now() - 864e5) });
    const { summary, proofs } = (await asA('get', '/api/proofs?view=overdue')).body.data;
    expect(summary.overdue).toBeGreaterThanOrEqual(1);
    expect(proofs.map((p) => p._id)).toContain(created._id);
    expect(proofs.find((p) => p._id === created._id).isOverdue).toBe(true);

    const stats = (await asA('get', '/api/proofs/stats/summary')).body.data.stats;
    expect(stats.overdue).toBe(summary.overdue);
    expect(stats.approvedThisMonth).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBe(summary.all);
  });
});

describe('isolation between businesses', () => {
  let id;
  beforeAll(async () => {
    id = (await newProof({ title: 'Private proof' })).body.data.proof._id;
  });

  test('another business cannot see, change or delete the proof', async () => {
    const list = (await asB('get', '/api/proofs?limit=100')).body.data.proofs;
    expect(list.map((p) => p._id)).not.toContain(id);
    expect(list.every((p) => p.customerName !== 'Malabar Traders')).toBe(true);
    expect((await asB('get', `/api/proofs/${id}`)).status).toBe(404);
    expect((await asB('put', `/api/proofs/${id}`).send({ title: 'Hacked' })).status).toBe(404);
    expect((await asB('post', `/api/proofs/${id}/send`).send({})).status).toBe(404);
    expect((await asB('put', `/api/proofs/${id}/approve`).send({})).status).toBe(404);
    expect((await asB('put', `/api/proofs/${id}/reject`).send({ rejectionReason: 'x' })).status).toBe(404);
    expect((await asB('post', `/api/proofs/${id}/comments`).send({ comment: 'x' })).status).toBe(404);
    const fb = await fileFor(b.admin);
    expect((await asB('post', `/api/proofs/${id}/versions`).send({ files: [{ fileId: fb._id }] })).status).toBe(404);
    expect((await asB('delete', `/api/proofs/${id}`)).status).toBe(404);
    expect((await Proof.findById(id)).title).toBe('Private proof');

    const stats = (await asB('get', '/api/proofs/stats/summary')).body.data.stats;
    expect(stats.total).toBe(1); // only its own proof
  });

  test('a teammate in the same business sees it; a login without the module does not', async () => {
    const res = await request(app).get(`/api/proofs/${id}`).set(auth(designerToken));
    expect(res.status).toBe(200);
    const noModule = await request(app).get('/api/proofs').set(auth(a.tokens.manager));
    expect(noModule.status).toBe(403);
  });

  test('proofs saved before dataScope was stored are still found by creator', async () => {
    await Proof.collection.updateOne({ _id: new Proof.base.Types.ObjectId(id) }, { $unset: { dataScope: '' } });
    expect((await asA('get', `/api/proofs/${id}`)).status).toBe(200);
    expect((await asB('get', `/api/proofs/${id}`)).status).toBe(404);
  });

  test('the owner can delete it', async () => {
    const res = await asA('delete', `/api/proofs/${id}`);
    expect(res.status).toBe(200);
    expect(await Proof.findById(id)).toBeNull();
    expect((await asA('delete', `/api/proofs/${id}`)).status).toBe(404);
  });
});

