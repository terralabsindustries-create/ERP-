/**
 * The Accounts page headline figures load independently: one failed request
 * never shows the other figure, or itself, as ₹0. Run from client/:
 * `npm run test:accounts` (Node strips the module's TypeScript types).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAccountsSummary, monthRange } from "../src/lib/accountsSummary.ts";

const balancesOk = async () => ({ currentBalances: { cashBalance: 1200, bankBalance: 54000 } });
const totalsOk = async () => ({ income: 9000, expense: 2500, net: 6500 });
const fail = (text) => async () => { throw new Error(text); };

test("both figures load", async () => {
  const s = await loadAccountsSummary({ getAccountBalances: balancesOk, getAccountPeriodTotals: totalsOk });
  assert.deepEqual(s.balances, { state: "ready", value: { cashBalance: 1200, bankBalance: 54000 } });
  assert.deepEqual(s.month, { state: "ready", value: { in: 9000, out: 2500 } });
});

test("a failed monthly total keeps the loaded balances", async () => {
  const s = await loadAccountsSummary({ getAccountBalances: balancesOk, getAccountPeriodTotals: fail("totals down") });
  assert.deepEqual(s.balances, { state: "ready", value: { cashBalance: 1200, bankBalance: 54000 } });
  assert.deepEqual(s.month, { state: "failed", error: "totals down" });
});

test("failed balances are unavailable, not zero, and the month still loads", async () => {
  const s = await loadAccountsSummary({ getAccountBalances: fail("balances down"), getAccountPeriodTotals: totalsOk });
  assert.deepEqual(s.balances, { state: "failed", error: "balances down" });
  assert.equal(s.month.state, "ready");
});

test("an empty balances response is a failure, not ₹0", async () => {
  const s = await loadAccountsSummary({ getAccountBalances: async () => undefined, getAccountPeriodTotals: totalsOk });
  assert.equal(s.balances.state, "failed");
});

test("the totals request covers this calendar month", async () => {
  let asked;
  await loadAccountsSummary({ getAccountBalances: balancesOk, getAccountPeriodTotals: async (p) => { asked = p; return {}; } }, new Date(2026, 10, 18, 15, 0));
  assert.deepEqual(asked, monthRange(new Date(2026, 10, 18)));
  assert.equal(new Date(asked.startDate).getDate(), 1);
  assert.equal(new Date(asked.endDate).getMonth(), 11);
});
