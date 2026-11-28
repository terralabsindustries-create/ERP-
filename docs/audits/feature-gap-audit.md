# Feature gap audit: Wave 0 update

The original audit is `PRINTING_ERP_FEATURE_GAP_AUDIT.md` (27 Nov 2026; 19 F / 56 = 33.9%). Scoring rule unchanged: only **F** (implemented and verified at repository/API-test level) counts.

## Re-scoring
Only capabilities whose evidence changed are re-scored; no module is upgraded on the strength of new infrastructure alone.

| Module / capability | Was | Now | Evidence |
|---|---|---|---|
| 2 Printing estimation: imposition/cost calculator | U | **F** | `client/tests/print-estimate.test.mjs` hand-computed expectations; UI path traced earlier |
| 23 Audit logs: comprehensive immutable audit trail | P | **P** | Append-only and broad, but not tamper-proof at database level and not every event verified; stays P |
| 24 Data migration: bulk imports | U/M | unchanged | Framework added for schema migrations only, not customer/vendor import |
| 16 Accounting: balanced GL | M | M | unchanged |

**Updated score: 20 F / 56 = 35.7%** (one capability moved: imposition calculator). The audit trail, reconciliation, idempotency, migration runner and Playwright smoke suite are real improvements but map to no additional F capability under the original methodology. The score is not inflated for them.

Playwright smoke tests (15) verify sign-in, ten modules open with seeded data and error/retry states against a seeded local stack; they are API+UI smoke checks, not full workflow acceptance, so they did not upgrade any "U" capability by themselves.
