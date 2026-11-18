/**
 * The Accounts page headline figures: cash and bank balances, and this
 * month's money in and out. They come from two requests that succeed or fail
 * on their own — a failed monthly total never turns loaded balances into ₹0,
 * and a failed balance request is shown as unavailable, never as ₹0.
 *
 * No imports, so it can be tested with plain Node (tests/accounts-summary.test.mjs).
 */

export type Loaded<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; error: string };

export interface Balances {
  cashBalance: number;
  bankBalance: number;
}
export interface MonthTotals {
  in: number;
  out: number;
}

export interface SummaryApi {
  getAccountBalances(): Promise<unknown>;
  getAccountPeriodTotals(params: { startDate: string; endDate: string }): Promise<unknown>;
}

const message = (reason: unknown) => (reason instanceof Error && reason.message ? reason.message : "Could not load");

/** This calendar month in the viewer's timezone, as the server's [startDate, endDate). */
export function monthRange(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

export async function loadAccountsSummary(api: SummaryApi, now = new Date()): Promise<{ balances: Loaded<Balances>; month: Loaded<MonthTotals> }> {
  const [b, t] = await Promise.allSettled([api.getAccountBalances(), api.getAccountPeriodTotals(monthRange(now))]);

  let balances: Loaded<Balances>;
  if (b.status === "fulfilled") {
    const current = (b.value as { currentBalances?: { cashBalance?: number; bankBalance?: number } } | undefined)?.currentBalances;
    balances = current
      ? { state: "ready", value: { cashBalance: current.cashBalance || 0, bankBalance: current.bankBalance || 0 } }
      : { state: "failed", error: "The balances response was empty" };
  } else {
    balances = { state: "failed", error: message(b.reason) };
  }

  let month: Loaded<MonthTotals>;
  if (t.status === "fulfilled") {
    const totals = t.value as { income?: number; expense?: number } | undefined;
    month = totals && typeof totals === "object"
      ? { state: "ready", value: { in: totals.income || 0, out: totals.expense || 0 } }
      : { state: "failed", error: "The monthly totals response was empty" };
  } else {
    month = { state: "failed", error: message(t.reason) };
  }

  return { balances, month };
}
