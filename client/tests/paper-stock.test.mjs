/**
 * The paper picked on a job ticket becomes one priced line: sheets × the
 * paper's selling rate. Run from client/: `npm run test:paper`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paperStock, withPaperLine } from "../src/lib/paperStock.ts";

const rate = (p) => (Number(p.sellingPrice) > 0 ? Number(p.sellingPrice) : Number(p.unitCost) || 0);
const blank = () => ({ itemName: "", quantity: 1, unitPrice: 0, gstRate: 18, unit: "pieces", itemType: "Numbers" });

const artCard = { name: "Art Card 300 GSM", unit: "sheets", category: "Paper & Printing Materials", sellingPrice: 6, unitCost: 4, hsnCode: "4810", gstRate: 12 };
const maplitho = { name: "Maplitho 70 GSM", unit: "reams", category: "Paper & Printing Materials", unitCost: 320 };
const flex = { name: "Flex 10 oz", unit: "sqft", category: "Paper & Printing Materials", sellingPrice: 12 };
const ink = { name: "Cyan ink", unit: "liters", category: "Ink & Toner", sellingPrice: 900 };
const oldCard = { ...artCard, name: "Old card", status: "discontinued" };

test("only active paper counted in sheets or reams can be picked", () => {
  assert.deepEqual(paperStock([artCard, maplitho, flex, ink, oldCard]).map((p) => p.name), ["Art Card 300 GSM", "Maplitho 70 GSM"]);
  // Kept in sheets but filed elsewhere still counts as paper.
  assert.equal(paperStock([{ name: "Sticker sheet", unit: "sheets", category: "Other" }]).length, 1);
});

test("paper and sheets add one line at the selling rate per sheet", () => {
  const items = withPaperLine([], artCard, 250, rate, blank);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { ...items[0] },
    { itemName: "Art Card 300 GSM", quantity: 250, unitPrice: 6, gstRate: 12, unit: "sheets", itemType: "Numbers", hsnCode: "4810", fromPaper: true }
  );
});

test("no selling price falls back to the purchase price", () => {
  assert.equal(withPaperLine([], maplitho, 2, rate, blank)[0].unitPrice, 320);
});

test("changing the sheets updates the same line and keeps a rate the user typed", () => {
  const other = { itemName: "Lamination", quantity: 1, unitPrice: 150, gstRate: 18 };
  let items = withPaperLine([other], artCard, 100, rate, blank);
  items = items.map((i) => (i.fromPaper ? { ...i, unitPrice: 5.5 } : i));
  items = withPaperLine(items, artCard, 400, rate, blank);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], other);
  assert.equal(items[1].quantity, 400);
  assert.equal(items[1].unitPrice, 5.5);
});

test("a different paper replaces the line at its own rate", () => {
  let items = withPaperLine([], artCard, 100, rate, blank);
  items = withPaperLine(items, maplitho, 3, rate, blank);
  assert.equal(items.length, 1);
  assert.equal(items[0].itemName, "Maplitho 70 GSM");
  assert.equal(items[0].unitPrice, 320);
  assert.equal(items[0].unit, "reams");
  assert.equal(items[0].gstRate, 18);
});

test("no sheets, or a paper that is not in stock, takes the line off", () => {
  const other = { itemName: "Lamination", quantity: 1, unitPrice: 150, gstRate: 18 };
  const items = withPaperLine([other], artCard, 100, rate, blank);
  assert.deepEqual(withPaperLine(items, artCard, 0, rate, blank), [other]);
  assert.deepEqual(withPaperLine(items, undefined, 100, rate, blank), [other]);
  // Nothing to take off: the same list comes back.
  const plain = [other];
  assert.equal(withPaperLine(plain, undefined, 0, rate, blank), plain);
});
