/**
 * 004: indexes for the Pricing Master collections (PriceItem, CustomerItemRate).
 * Additive: the collections are new, no existing document is read or changed,
 * and invoices/quotations without a priced item behave exactly as before.
 * Historical documents keep their stored prices; only new lines carry a pricingSnapshot.
 */
exports.id = '004-pricing-master-collections';
exports.description = 'Create indexes for PriceItem and CustomerItemRate';
exports.recovery = 'Drop the two collections (priceitems, customeritemrates) if the feature is withdrawn; no other data depends on them except pricingSnapshot copies stored on documents.';

const MODELS = ['PriceItem', 'CustomerItemRate'];
exports.up = async (ctx) => {
  for (const name of MODELS) {
    const Model = require(`../../src/models/${name}`);
    const have = new Set((await Model.collection.indexes().catch(() => [])).map((i) => JSON.stringify(i.key)));
    const gaps = Model.schema.indexes().filter(([f]) => !have.has(JSON.stringify(f)));
    ctx.count(`${name}.missingIndexes`, gaps.length);
    if (!ctx.dryRun && gaps.length) await Model.createIndexes();
  }
};
exports.validate = async () => [];
