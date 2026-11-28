const express = require('express');
const mongoose = require('mongoose');
const CreditNote = require('../models/CreditNote');
const Invoice = require('../models/Invoice');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const svc = require('../services/creditNotes');

/*
  GST credit and debit notes. Mounted in app.js behind moduleGuard:
  reading needs Invoicing (or Accounts/Reports); every change needs
  "Invoicing: Credit & Debit Notes". The business logic and its limits live in
  services/creditNotes.js.
*/
const router = express.Router();
router.use(protect);

const fail = (res, error, what) => {
  if (error instanceof svc.NoteError) {
    return res.status(error.status).json({ status: 'error', message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  if (error.name === 'ValidationError') return res.status(400).json({ status: 'error', message: error.message });
  console.error(`Credit note ${what} error:`, error);
  return res.status(500).json({ status: 'error', message: `Could not ${what} the note. Please try again.` });
};

const log = (req, note, action, actionType, severity = 'medium', extra = {}) =>
  ActivityLog.logActivity({
    action,
    description: `${note.noteType === 'credit' ? 'Credit' : 'Debit'} note ${note.noteNumber} (invoice ${note.invoiceNumber}) — ${action.toLowerCase()}`,
    entityType: 'invoice',
    entityId: note.invoiceId,
    entityName: note.noteNumber,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    changes: { noteId: String(note._id), totalAmount: note.totalAmount, ...extra },
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error('Activity log (credit note) failed:', err.message));

// GET /api/credit-notes?invoiceId=&customerId=&noteType=&status=&from=&to=&page=&limit=
router.get('/', async (req, res) => {
  try {
    const q = { ...svc.scopeOf(req.user) };
    for (const field of ['invoiceId', 'customerId']) {
      if (req.query[field]) {
        if (!mongoose.isValidObjectId(req.query[field])) return res.json({ status: 'success', data: { notes: [], pagination: { current: 1, total: 0, count: 0, totalNotes: 0 } } });
        q[field] = req.query[field];
      }
    }
    if (['credit', 'debit'].includes(req.query.noteType)) q.noteType = req.query.noteType;
    if (CreditNote.STATUSES.includes(req.query.status)) q.status = req.query.status;
    if (req.query.from || req.query.to) {
      q.noteDate = {};
      if (req.query.from) q.noteDate.$gte = new Date(req.query.from);
      if (req.query.to) q.noteDate.$lt = new Date(req.query.to);
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const [notes, total] = await Promise.all([
      CreditNote.find(q).sort({ noteDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CreditNote.countDocuments(q)
    ]);
    res.json({ status: 'success', data: { notes, pagination: { current: page, total: Math.ceil(total / limit), count: notes.length, totalNotes: total } } });
  } catch (error) { fail(res, error, 'list'); }
});

// GET /api/credit-notes/invoice/:invoiceId/lines — what each invoice line can still be credited
router.get('/invoice/:invoiceId/lines', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.invoiceId)) return res.status(404).json({ status: 'error', message: 'Invoice not found' });
    const invoice = await Invoice.findOne({ _id: req.params.invoiceId, ...svc.scopeOf(req.user) });
    if (!invoice) return res.status(404).json({ status: 'error', message: 'Invoice not found' });
    const remaining = await svc.remainingByLine(invoice);
    res.json({
      status: 'success',
      data: {
        invoice: { _id: invoice._id, invoiceNumber: invoice.invoiceNumber, status: invoice.status, isInterState: invoice.isInterState, totalAmount: invoice.totalAmount, balanceAmount: invoice.balanceAmount },
        lines: [...remaining.values()].map((l) => ({
          invoiceLineRef: l.ref, itemName: l.itemName, hsnCode: l.hsnCode, sacCode: l.sacCode, unit: l.unit, gstRate: l.gstRate,
          quantity: l.quantity, taxableValue: l.taxableValue, creditableValue: Math.max(0, l.creditable), creditableQuantity: Math.max(0, l.creditableQty)
        }))
      }
    });
  } catch (error) { fail(res, error, 'load'); }
});

router.get('/:id', async (req, res) => {
  try {
    const note = await svc.findOwn(req.user, req.params.id);
    res.json({ status: 'success', data: { note } });
  } catch (error) { fail(res, error, 'load'); }
});

// POST /api/credit-notes { noteType, invoiceId, reason, reasonText?, noteDate?, items: [{ invoiceLineRef, quantity, taxableValue }] | full: true, notes?, idempotencyKey? }
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body, idempotencyKey: req.body?.idempotencyKey || req.get('Idempotency-Key') };
    const { note, duplicate } = await svc.createNote(req.user, body);
    if (!duplicate) log(req, note, 'Credit/Debit Note Drafted', 'create', 'low');
    res.status(duplicate ? 200 : 201).json({ status: 'success', data: { note, duplicate } });
  } catch (error) { fail(res, error, 'create'); }
});

router.put('/:id', async (req, res) => {
  try {
    const note = await svc.updateDraft(req.user, req.params.id, req.body || {});
    log(req, note, 'Credit/Debit Note Draft Updated', 'update', 'low');
    res.json({ status: 'success', data: { note } });
  } catch (error) { fail(res, error, 'update'); }
});

router.delete('/:id', async (req, res) => {
  try {
    const note = await svc.deleteDraft(req.user, req.params.id);
    log(req, note, 'Credit/Debit Note Draft Deleted', 'delete', 'low');
    res.json({ status: 'success', message: 'Draft note deleted' });
  } catch (error) { fail(res, error, 'delete'); }
});

router.patch('/:id/issue', async (req, res) => {
  try {
    const { note, invoice } = await svc.issueNote(req.user, req.params.id);
    log(req, note, 'Credit/Debit Note Issued', 'update', 'high', { appliedToInvoice: note.appliedToInvoice, unappliedAmount: note.unappliedAmount });
    res.json({ status: 'success', message: `${note.noteNumber} issued`, data: { note, invoice: { _id: invoice._id, invoiceNumber: invoice.invoiceNumber, balanceAmount: invoice.balanceAmount, paymentStatus: invoice.paymentStatus, status: invoice.status } } });
  } catch (error) { fail(res, error, 'issue'); }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const { note } = await svc.cancelNote(req.user, req.params.id, req.body?.reason);
    log(req, note, 'Credit/Debit Note Cancelled', 'cancel', 'high', { reason: note.cancellationReason });
    res.json({ status: 'success', message: `${note.noteNumber} cancelled`, data: { note } });
  } catch (error) { fail(res, error, 'cancel'); }
});

// GET /api/credit-notes/:id/pdf
router.get('/:id/pdf', async (req, res) => {
  try {
    const note = await svc.findOwn(req.user, req.params.id);
    const PDFService = require('../services/PDFService');
    const { getCompanyInfo } = require('./invoices');
    const company = await getCompanyInfo(req.user);
    if (!company.isConfigured) return res.status(400).json({ status: 'error', message: company.error, code: 'COMPANY_NOT_CONFIGURED' });
    const pdf = await PDFService.generateCreditNotePDF(note.toObject(), company);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${note.noteNumber}.pdf"`);
    res.send(pdf);
  } catch (error) { fail(res, error, 'download'); }
});

module.exports = router;
