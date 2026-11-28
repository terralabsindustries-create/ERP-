/**
 * 005 — indexes for phase-2 features: case-insensitive customer name order
 * (paged Customers list), recurring invoices and their once-per-date run claims,
 * GST compliance records (one IRN record per invoice, one active e-way bill per
 * invoice), document numbering, Tally export history, invoice place of supply,
 * and each job's deliveries (Job Tickets list).
 * Only CREATES missing indexes (compared by index NAME, so a collation variant of
 * an existing key is detected); never drops one, never touches a document.
 */
const MODELS = [
  ['Customer'], ['Invoice'], ['RecurringInvoice'], ['RecurringInvoice', 'RecurringInvoiceRun'],
  ['GstCompliance', 'ComplianceSettings'], ['GstCompliance', 'EInvoiceRecord'], ['GstCompliance', 'EwayBillRecord'],
  ['DocumentNumbering'], ['Delivery']
];

exports.id = '005-phase2-compliance-and-recurring-indexes';
exports.description = 'Indexes for paged customers, recurring invoices, e-invoice/e-way bill records, numbering, Tally history';
exports.recovery = 'Indexes are additive; drop one by name with db.collection.dropIndex(name) if it must be removed.';

const modelOf = ([file, exportName]) => {
  const mod = require(`../../src/models/${file}`);
  return exportName ? mod[exportName] || mod : mod;
};
const nameOf = (fields, opts) => opts.name || Object.entries(fields).map(([k, v]) => `${k}_${v}`).join('_');

const missing = async (Model) => {
  const existing = await Model.collection.indexes().catch(() => []);
  const names = new Set(existing.map((i) => i.name));
  const hasText = existing.some((i) => i.key && i.key._fts === 'text');
  return Model.schema.indexes().filter(([fields, opts]) => (Object.values(fields).includes('text') ? !hasText : !names.has(nameOf(fields, opts))));
};

const models = () => {
  const list = MODELS.map(modelOf);
  list.push(require('../../src/services/tallyExport').TallyExport);
  return list;
};

exports.up = async (ctx) => {
  for (const Model of models()) {
    const gaps = await missing(Model);
    ctx.count(`${Model.modelName}.missingIndexes`, gaps.length);
    if (!ctx.dryRun && gaps.length) await Model.createIndexes();
  }
};

exports.validate = async () => {
  const problems = [];
  for (const Model of models()) {
    const gaps = await missing(Model);
    if (gaps.length) problems.push(`${Model.modelName} still lacks ${gaps.length} index(es)`);
  }
  return problems;
};
