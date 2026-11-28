/**
 * Statutory payroll contributions (India): provident fund (EPF/EPS/EDLI) and
 * ESI. Effective-dated so a change of rate or ceiling is a new entry, never an
 * edit that rewrites how past months were calculated.
 *
 * VERIFICATION STATUS (checked 2026-11-27 against official pages; see
 * docs/audits/printing-erp-functional-remediation-report.md):
 *  - EPF: employee 12% and employer 12% of wages, wage ceiling ₹15,000/month
 *    since 01-09-2014; employer share = 8.33% EPS + 3.67% EPF; EDLI 0.5%.
 *    Sources: labour.gov.in EPF Scheme document; epfindia.gov.in FAQ.
 *  - ESI: employee 0.75% and employer 3.25% of wages w.e.f. 01-07-2019;
 *    coverage ceiling ₹21,000/month (₹25,000 for persons with disability) since
 *    01-01-2017; employee share waived at ≤ ₹176 average daily wage (employer
 *    still pays). Sources: esic.gov.in/contribution, esic.gov.in/coverage, FAQ.
 *  - NOT verified: the EPS monthly cap amount, rounding rules (ESI rounded up
 *    to the next rupee, PF to the nearest rupee), and whether any 2026
 *    revision (e.g. under the new labour codes) has changed these figures.
 *    Those are marked `verified: false` and must be confirmed with the
 *    current EPFO/ESIC notification before anyone relies on them.
 * Nothing is applied to an employee unless their record opts in
 * (employee.statutory.pfApplicable / esiApplicable).
 */
const STATUTORY_CONFIG = [
  {
    effectiveFrom: '2019-07-01',
    verifiedOn: '2026-11-27',
    pf: {
      verified: true,
      wageCeiling: 15000,
      employeeRate: 12,
      employerRate: 12,
      epsRate: 8.33,
      edliRate: 0.5,
      // EPF wages: components of the salary that count (earned, i.e. after loss of pay).
      wageComponents: ['basic'],
      rounding: { verified: false, mode: 'nearest' }
    },
    esi: {
      verified: true,
      wageCeiling: 21000,
      wageCeilingDisability: 25000,
      employeeRate: 0.75,
      employerRate: 3.25,
      employeeExemptDailyWage: 176,
      // Wages that count: all earnings except overtime and bonus is a judgement
      // call left to the employer; overtime counts for contribution (ESIC FAQ).
      wageComponents: ['basic', 'hra', 'allowances', 'specialAllowance', 'overtime', 'bonus'],
      rounding: { verified: false, mode: 'ceil' }
    }
  }
];

/** The configuration in force on a date (the latest entry that has started). */
function configFor(date = new Date(), configs = STATUTORY_CONFIG) {
  const t = new Date(date).getTime();
  const started = configs.filter((c) => new Date(c.effectiveFrom).getTime() <= t).sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
  return started[0] || null;
}

module.exports = { STATUTORY_CONFIG, configFor };
