# Printing ERP — Performance Report

**Date:** 27 Nov 2026 · **Scope:** Phase 1 (backend, database, frontend load) and Phase 3 (subscription requests) of the upgrade brief.
**Raw data:** `docs/audits/perf/` (`before-rtt80.json`, `after-rtt80.json`, `after-rtt0.json`, `explain-before.txt`, `explain-after.txt`).

## 1. What could and could not be measured

| Item | Status |
|---|---|
| Production API timings (the 7 s / 14 s / 24 s / 30 s timeouts in the manual audit) | **Not reproduced.** No production access, logs or APM data were provided, and no request was sent to the production Atlas cluster. |
| Hosting region, instance size, Atlas tier/region, cold starts | **Unknown.** The repo shows an EC2 key (`terrralabs-erp.pem`) and an Atlas SRV host; their regions were not inspected. |
| Backend latency under a remote database | **Measured** with a local harness (below) that adds a fixed network round trip between the API and MongoDB. |
| Query plans | **Measured** with `explain('executionStats')` on seeded data. |
| Frontend bundle | **Measured** from production-mode builds of the old and new code. |
| Browser page load (initial usable page, cached navigation) | **Not measured** — no browser automation was run. |

## 2. Method

`backend/scripts/perf/bench.js` seeds a throwaway database on the **local** MongoDB (one business with 1,500 customers, 2,000 jobs, 1,800 invoices with 6 lines each, 600 counter jobs, 400 notifications, 500 tasks, plus a second "noise" business with 3,000 customers), starts the API on an ephemeral port, and routes every MongoDB packet through a TCP proxy that delays it by RTT/2 in each direction. **RTT = 80 ms** approximates an app server and its Atlas cluster in different regions. Each endpoint gets a warm-up request and 15–20 sequential samples; P50/P95/P99, MongoDB commands per request and payload size are recorded. The database is dropped afterwards.

"Before" is the `HEAD` commit (`39087e9`) run from a separate git worktree with the same harness and seed; "after" is the working tree. Machine: Apple Silicon Mac, Node v26.7.0, MongoDB Community (Homebrew), single process.

```
cd backend
node scripts/perf/bench.js --rtt 80 --samples 20 --out ../docs/audits/perf/after-rtt80.json
node scripts/perf/explain.js
```

## 3. Root causes found (evidence-based)

| # | Finding | Evidence | Effect |
|---|---|---|---|
| R1 | **Customers page fetched every customer 100 at a time, one page after another** (`pages/Customers.tsx` `fetchAllCustomers`) | 15 sequential requests for 1,500 customers = **9.4 s at 80 ms RTT** | Each page costs ~5–8 DB round trips; at ~200 ms RTT this is the reported ~24 s. |
| R2 | **Job Tickets page also downloaded every customer** for a `customers` prop the create-job dialog never used | `CreateJobDialog.tsx` declares but never reads `customers` | Same ~9 s of requests on every Jobs visit, competing with the job list. |
| R3 | Dashboard (every 30 s) and Production Board (every 60 s) each downloaded **500 full jobs with every invoice line item** | jobs list (limit 500) = **1.38 MB**, 810 ms | Heavy polling; counts were also wrong beyond 500 jobs. |
| R4 | **No index for `Invoice.jobId`** — `Job.invoices` is a virtual populated by `jobId` | `explain-before.txt`: `COLLSCAN`, examined **all** invoices of **all** businesses | Job list cost grows with the whole database, not the tenant. |
| R5 | Missing tenant-first sort indexes | In-memory `SORT` over all scoped docs for customers (newest/by name), invoices by date, notifications; `COLLSCAN` for "my overdue tasks" | Grows linearly with data. |
| R6 | Every API request resolved the plan entitlement with **two sequential queries** (`requireSubscription` → `getEntitlement`) | auth/me = 5–6 commands, 255 ms at 80 ms RTT | Adds ~160 ms to every request on a remote DB. |
| R7 | Lists ran the page query and its count **sequentially**; dashboard read settings before starting its counts | Code review + commands/request | One extra round trip per list. |
| R8 | **A slow `/auth/me` signed the user out** (`AuthContext` cleared the token on any error, including a timeout) | Code review | A slow server looked like a logout. |
| R9 | **One 2.2 MB JavaScript bundle** (all ~45 pages eager-imported) | Build output: 2,229,310 B raw / 597,153 B gzip | Slow first load. |
| R10 | Plan prompt refetched `/razorpay/plans` + `/razorpay/subscription` whenever the auth context re-rendered (unstable `refreshUser`), and re-checked recent open orders with Razorpay on **every** app load | Code review (`usePlanCheckout`, `PlanPromptDialog`) | Duplicate requests and Razorpay calls. |

## 4. Fixes

- **Indexes** (non-destructive; `backend/migrations/2026-11-27-performance-and-lifecycle-indexes.js`, which only *creates* indexes and was validated dry-run → run → re-run on a local copy): `Invoice{jobId}`, `Invoice{dataScope,invoiceDate}`, `{dataScope,createdAt}`, `{dataScope,customerId,invoiceDate}`, `{dataScope,dueDate}`; `Customer{dataScope,createdAt}`, `{dataScope,name}`; `Job{dataScope,createdAt}`, `{dataScope,status,dueDate}`, `{dataScope,customerId,createdAt}`; `Task{assignedTo,status,dueDate}`, `{dataScope,status,dueDate}`; `Notification{recipient,createdAt}`; `User{dataScope,role}`; `SubscriptionPurchase{workspaceKey,status}`, `{status,createdAt}`. Every query in `explain-after.txt` is now an index scan with docs examined ≈ docs returned.
- **Entitlement cache** (`services/subscriptionService.js`): both lookups run in parallel and the result is cached per business — active for 60 s (never past the plan's end date), inactive for 10 s; any write to a plan purchase clears it immediately; concurrent misses share one lookup. `ENTITLEMENT_CACHE_MS=0` disables it.
- **Parallel page + count** in jobs and customers lists; dashboard reads settings in parallel with its counts.
- **Light job payloads**: the job list's invoice summary no longer carries line items (−50 % for 500 jobs); new `GET /api/jobs/board` returns stage counts (one aggregation) + light open-job cards, used by both Dashboard and Production Board.
- **Client**: route-level code splitting with per-page error boundaries; React Query defaults (30 s fresh data, no refetch on focus, 2 retries with backoff, no retry on 401/402/403/404/validation); identical in-flight GETs share one request; `listAll` fetches remaining pages 4 at a time; Jobs page no longer loads all customers; caller-cancellable requests; typed request errors.
- **Connection pool**: `minPoolSize 5` (warm connections), `maxPoolSize 50`, idle timeout, zlib wire compression (all env-tunable).
- **Observability**: every API response carries `Server-Timing: app;dur=…`; requests slower than `PERF_SLOW_MS` (default 1000) log one JSON line with method, route (ids masked), status, ms — no query string, body, token or user data.

## 5. Results (80 ms simulated DB round trip, same seed, P50 / P95 in ms)

| Endpoint or operation | Before | After | DB cmds/req | Payload KB | Target | Result |
|---|---|---|---|---|---|---|
| `GET /auth/me` | 254.8 / 264.5 | **86.4 / 94.4** | 5.7 → 5.3* | 3.3 | < 300 | Met |
| Customers list (100) | 628 / 644 | **369 / 380** | 12.7 → 11.9 | 87 → 104† | < 500 | Met |
| Customer search | 716 / 741 | **450 / 461** | 8.4 → 9 | 18 → 21† | < 500 | Met |
| Jobs list, limit 25 | 517 / 535 | **268 / 279** | 8 → 6 | 28.5 | < 500 | Met |
| Jobs list, limit 500 (old dashboard/board call) | 810 / 845 | 536 / 556 | 11 → 9 | **1,383 → 686** | < 500 | Not met — no longer used by Dashboard/Board |
| Job board (new; replaces the 500-job call) | n/a | **660 / 676** | 10 | 625 (1,500 open jobs) | < 1,000 (dashboard) | Met |
| Counter jobs (active) | 440 / 459 | **267 / 285** | 6 → 4 | 78.5 | < 500 | Met |
| Notifications | 433 / 445 | **262 / 280** | 13 → 11 | 8.3 | < 500 | Met |
| Razorpay subscription | 258 / 265 | **174 / 178** | 4 → 2 | 0.2 | < 500 | Met |
| Dashboard stats | 534 / 552 | **272 / 288** | 18 → 17 | 1.2 | < 1,000 | Met |
| Invoices list (25) | 539 / 547 | **351 / 366** | 7 → 5 | 89 | < 500 | Met |
| Global search (new `/api/search`) | 404 | **349 / 366** | 8 | 3.2 | < 500 | Met |
| 8 concurrent job lists (25) | 564 / 606 | **284 / 314** | — | — | < 500 | Met |
| **Customers page, all 1,500 rows** (old: sequential pages, old server) | **9,395** | — | — | — | — | — |
| **Customers page, all 1,500 rows** (new: batched ×4, new server) | — | **1,920** | — | — | < 2,000 | Met (at 80 ms) |

\* The command counter also counts connection-pool heartbeats/`getMore`, so it is approximate; latency is the reliable figure.
† The customer list grew by ~16 KB because of concurrent, separate work in this working tree (customer financial figures, `services/customerFinancials.js`), not this batch.

With **no added latency** (local DB) every endpoint's P50 is 4–100 ms (`after-rtt0.json`).

**Frontend bundle (production build):** entry JavaScript **2,229 KB raw / 597 KB gzip → 560 KB raw / 171 KB gzip (−71 % gzip)**; each page now loads as its own chunk (146 chunks).

## 6. Targets not met or not verified

- **Jobs page still loads up to 500 jobs** and filters in the browser (536 ms, 686 KB). Converting the Job Tickets and Customers pages to true server-side pagination/filtering is the remaining list work.
- **Customers page** is ~1.9 s at 80 ms RTT but will be slower on a longer link (it still downloads every customer). Needs server-side pagination + a summary endpoint for the header metrics.
- **Initial usable page < 2 s / cached navigation < 300 ms**: not measured in a browser.
- **Production confirmation**: deploy, then compare `Server-Timing` and the `slow_request` log lines against the browser's timings. If server time is small but browser time is large, the remaining cost is network/hosting (region mismatch, instance size, cold starts), which code cannot fix. Recommended next measurement: Atlas and EC2 regions, and Atlas "Real Time Performance Panel" during a slow page.
- Redis was **not** introduced; no evidence required it.
