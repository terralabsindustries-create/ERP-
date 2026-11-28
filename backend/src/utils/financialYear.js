/**
 * Indian financial year (1 April – 31 March), reckoned in India time so a
 * document dated just after midnight IST on 1 April falls in the new year even
 * on a server running in UTC.
 *
 *   financialYearOf(new Date('2026-11-14')) → { start: 2026, label: '2026-27', code: '2627',
 *                                               from: 2026-04-01T00:00+05:30, to: 2027-04-01T00:00+05:30 }
 */
const IST_OFFSET_MS = 330 * 60 * 1000;

function financialYearOf(date = new Date()) {
  const ist = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1; // April is month 3
  return financialYearStarting(start);
}

function financialYearStarting(start) {
  const end = start + 1;
  return {
    start,
    label: `${start}-${String(end).slice(-2)}`,
    code: `${String(start).slice(-2)}${String(end).slice(-2)}`,
    from: new Date(Date.UTC(start, 3, 1) - IST_OFFSET_MS),
    to: new Date(Date.UTC(end, 3, 1) - IST_OFFSET_MS)
  };
}

/** "2026-27" → the financial year starting April 2026; null if not of that form. */
function parseFinancialYear(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label || ''));
  if (!m) return null;
  const start = Number(m[1]);
  if (String(start + 1).slice(-2) !== m[2]) return null;
  return financialYearStarting(start);
}

module.exports = { financialYearOf, financialYearStarting, parseFinancialYear, IST_OFFSET_MS };
