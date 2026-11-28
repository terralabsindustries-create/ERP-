# Performance comparison

**Method:** `backend/scripts/perf/bench.js`: seeded throwaway local MongoDB (1,500 customers + noise tenant), real Express app, TCP proxy adding a simulated database round trip (RTT). Medians of 15 samples. Raw files: `docs/audits/perf/`.

**Limits (read before quoting):** this is a **local simulation**, not production. The original 7 s / 14 s / 24 s / 30 s timeouts were **not reproduced**: with RTT 0 every endpoint answers in 15–210 ms. With 80 ms simulated RTT, latency is dominated by number of DB round trips. No production-equivalent environment was available, so **no production improvement is claimed**; the likely production cause (remote database × many sequential round trips, cold start, un-indexed scoped queries) is a hypothesis to verify on staging.

| Endpoint (RTT 80 ms) | Before p50 | After p50 (earlier run) | Final run p50 |
|---|---|---|---|
| auth/me | 263 ms | 170 ms | 85 ms |
| customers list (100) | 682 | 445 | 380 |
| jobs list (limit 500) | 865 (1,383 KB) | 627 (686 KB) | 540 |
| jobs list (25) | 561 | 393 | 282 |
| notifications | 446 | 365 | 259 |
| dashboard stats | 539 | 379 | 280 |
| invoices list (25) | 530 | 461 | 364 |
| razorpay subscription | 255 | 174 | 176 |
| job board | 500 error | 788 (200) | 641 |

"Final run" is `perf/wave0-final-rtt80.json` (also taken after Wave 0 edits; note its customers list does more work, 15.6 DB commands, from the new financial aggregation).

## Confirmed causes fixed (earlier work in the working tree, verified here)
Missing scoped compound indexes (migration 002), plan-entitlement lookup on every request (60 s cache, invalidated on purchase), jobs list returning full invoice lines (payload halved), job board 500, repeated Razorpay order-status checks (rate limited), `Server-Timing` header and slow-request log added for diagnosis. Frontend: `useLoader`/`ErrorState` give distinct loading / empty / timeout / error / retry states; browser smoke tests prove a 500 and a refused connection show an error with Retry, not "No job tickets".

## Wave 0 cost
Customer list now runs one aggregation set for financials (3 extra queries per page of ≤100). Measured above; acceptable but should be re-measured on staging.

## Blockers
Production MongoDB topology/region, app-to-DB latency and Atlas tier were not provided. Needed: a staging run with `bench.js` against equivalent infrastructure and `explain.js` on a copy of real data.
