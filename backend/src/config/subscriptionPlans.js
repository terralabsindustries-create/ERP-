/*
  Carbon Print Flow's own software plans — the single source of truth for what a
  pack costs and how long it lasts. Prices are final INR amounts (no tax or fee is
  added on top), one payment per pack, prepaid: nothing renews by itself.

  The browser only ever sends a pack id. Amount, duration and savings come from
  here.
*/
const BASE_MONTHLY_PAISE = 199900;

const PACKS = [
  { id: 'M1', months: 1, perMonthPaise: 199900, tag: 'Start here' },
  { id: 'M3', months: 3, perMonthPaise: 179900, tag: null },
  { id: 'M6', months: 6, perMonthPaise: 159900, tag: 'Recommended' },
  { id: 'M12', months: 12, perMonthPaise: 139900, tag: 'Best value' }
];

// Charge amounts are fixed by the product table, not derived from the effective
// monthly price (e.g. 3 x 1799 = 5397), and asserted against it below.
const CHARGE_PAISE = { M1: 199900, M3: 539700, M6: 959400, M12: 1678800 };

const CATALOG = Object.freeze(
  Object.fromEntries(
    PACKS.map((pack) => {
      const amountPaise = CHARGE_PAISE[pack.id];
      if (amountPaise !== pack.perMonthPaise * pack.months) {
        throw new Error(`Plan catalog is inconsistent for ${pack.id}`);
      }
      const fullPricePaise = BASE_MONTHLY_PAISE * pack.months;
      const savingsPaise = fullPricePaise - amountPaise;
      return [pack.id, Object.freeze({
        id: pack.id,
        label: pack.months === 1 ? '1 month' : `${pack.months} months`,
        months: pack.months,
        currency: 'INR',
        amountPaise,
        perMonthPaise: pack.perMonthPaise,
        savingsPaise,
        savingsPercent: Math.round((savingsPaise / fullPricePaise) * 100),
        tag: pack.tag
      })];
    })
  )
);

const getPack = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, id) ? CATALOG[id] : null);
const listPacks = () => PACKS.map((p) => CATALOG[p.id]);

/*
  Calendar-month arithmetic on Indian wall-clock time (IST, UTC+05:30, no DST):
  the same day-of-month and time of day, clamped to the last day of a shorter
  month — 31 Jan + 1 month = 28/29 Feb, not 3 Mar.
*/
const IST_OFFSET_MS = 330 * 60 * 1000;
const addCalendarMonthsIST = (date, months) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const day = shifted.getUTCDate();
  const target = new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth() + months, 1,
    shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(), shifted.getUTCMilliseconds()
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return new Date(target.getTime() - IST_OFFSET_MS);
};

module.exports = { CATALOG, getPack, listPacks, addCalendarMonthsIST, BASE_MONTHLY_PAISE };
