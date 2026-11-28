const { configFor } = require('../config/statutory');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const roundBy = (mode, n) => (mode === 'ceil' ? Math.ceil(n - 1e-9) : Math.round(n));

/**
 * PF and ESI for one payslip, from the employee's opt-in flags and the
 * effective-dated configuration. All wages are the EARNED amounts (after loss
 * of pay). Returns the employee deductions, the employer contributions (not
 * part of net pay) and what each was based on, so the payslip can show its work.
 *
 *   earned      – the payslip's earnings after loss of pay { basic, hra, ... }
 *   grossFull   – the full-month gross (eligibility is tested on contract wages)
 *   paidDays    – days paid, for the ESI daily-wage exemption
 */
function computeStatutory({ employee, earned, grossFull, paidDays, asOf, configs }) {
  const config = configFor(asOf, configs);
  const flags = employee?.statutory || {};
  const out = {
    configEffectiveFrom: config?.effectiveFrom || null,
    employee: { pf: 0, esi: 0 },
    employer: { pf: 0, eps: 0, epf: 0, edli: 0, esi: 0 },
    basis: { pfWage: 0, esiWage: 0 },
    notes: [],
    unverified: []
  };
  if (!config) return out;
  const sum = (components) => components.reduce((s, k) => s + (Number(earned?.[k]) || 0), 0);

  if (flags.pfApplicable) {
    const pf = config.pf;
    const pfWage = sum(pf.wageComponents);
    const capped = flags.pfOnFullWage ? pfWage : Math.min(pfWage, pf.wageCeiling);
    out.basis.pfWage = round2(capped);
    out.employee.pf = roundBy(pf.rounding.mode, (capped * pf.employeeRate) / 100);
    // Employer: 12% of the same wage; EPS is on the ceiling-capped wage only.
    const epsWage = Math.min(pfWage, pf.wageCeiling);
    out.employer.eps = roundBy(pf.rounding.mode, (epsWage * pf.epsRate) / 100);
    out.employer.pf = roundBy(pf.rounding.mode, (capped * pf.employerRate) / 100);
    out.employer.epf = Math.max(0, out.employer.pf - out.employer.eps);
    out.employer.edli = roundBy(pf.rounding.mode, (epsWage * pf.edliRate) / 100);
    if (!pf.rounding.verified) out.unverified.push('PF rounding rule');
  }

  if (flags.esiApplicable) {
    const esi = config.esi;
    const limit = flags.disability ? esi.wageCeilingDisability : esi.wageCeiling;
    if ((Number(grossFull) || 0) > limit) {
      out.notes.push(`ESI not applicable: monthly wages exceed ₹${limit}`);
    } else {
      const esiWage = sum(esi.wageComponents);
      out.basis.esiWage = round2(esiWage);
      const daily = paidDays > 0 ? esiWage / paidDays : 0;
      out.employer.esi = roundBy(esi.rounding.mode, (esiWage * esi.employerRate) / 100);
      if (daily <= esi.employeeExemptDailyWage) {
        out.notes.push(`ESI employee share waived: average daily wage ₹${round2(daily)} is within ₹${esi.employeeExemptDailyWage}`);
      } else {
        out.employee.esi = roundBy(esi.rounding.mode, (esiWage * esi.employeeRate) / 100);
      }
      if (!esi.rounding.verified) out.unverified.push('ESI rounding rule');
    }
  }
  return out;
}

module.exports = { computeStatutory };
