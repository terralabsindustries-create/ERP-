/** "2026-27" for a date, by the Indian financial year (April–March) in India time. */
export function financialYearLabel(date: Date = new Date()): string {
  const ist = new Date(date.getTime() + 330 * 60e3);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}
