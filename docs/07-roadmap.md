# 07 · Implementation Roadmap

Estimates are **working days for one senior backend developer**, including tests and docs for the phase, excluding waiting on third parties (SMS DLT approval, cloud accounts) and excluding mobile-app integration work. Each phase ends green: `tsc`, lint, unit + e2e tests, build, migration drift check. No phase starts before the previous one's acceptance criteria are met. **Nothing below starts until you approve.**

| Phase | Goal | Priority | Effort |
|---|---|---|---|
| 0 | Decisions, repo and tooling | P0 | 2–3 d |
| 1 | Schema, reference data, catalog API | P1 | 3 d |
| 2 | Auth & account | P1 | 4–5 d |
| 3 | Profiles, media, verification | P1 | 5–6 d |
| 4 | Jobs, leads, offers, direct booking, real-time gateway | P1 | 8–11 d |
| 5 | Fulfilment: tracking → bill → payment | P1 | 7–8 d |
| 6 | Reviews, activity, earnings, savings, receipt | P2 | 3–4 d |
| 7 | Hardening & release | P1 | 4–5 d |
| 8 | Optional: MSG91 + WhatsApp OTP, Redis (cache + Socket.IO adapter), push, PDF, admin UI | P3 | scoped separately |
| **Total (0–7)** | | | **≈ 36–45 d (8–10 weeks)** |

Realistic range assumes answers to the open questions arrive in week 1. Add ~20 % contingency for third-party onboarding (SMS provider DLT, bucket/KMS setup).

---

## Phase 0 — Decisions, repo, tooling (2–3 d)
**Files:** `package.json`, `tsconfig*.json`, `nest-cli.json`, `oxlint` + `prettier`, `.env.example`, `.gitignore`, `prisma.config.ts`, `src/main.ts`, `app.module.ts`, `config/*`, `prisma/prisma.service.ts`, `health/*`, `.github/workflows/ci.yml`, README.
**Work:** git repo already initialised (D-7); scaffold Nest 12; pin Prisma 7.10 (Q-14) and confirm it works against local PostgreSQL 18 (D-1); connect to the existing `KaamConnect` / `KaamConnect_test` databases (ask before creating anything); env validation incl. production guards for dev-only switches; global pipes/filters/guards skeleton; health endpoints; CI.
**Acceptance:** `npm run start:dev` boots, `/health/ready` is green with DB up and red with DB down; CI passes on an empty test; boot fails with a clear message for missing/invalid env.
**Risks:** Nest 12 / Prisma 7 adapter ESM-vs-CJS friction → mitigate by doing a throwaway spike first hour.

## Phase 1 — Schema, reference data, catalog (3 d)
**Files:** `prisma/schema.prisma` (from `prisma/schema.prisma`), baseline migration + hand-written SQL constraints, `prisma/seed.ts`, `prisma/data/*`, `modules/catalog/*`.
**Endpoints:** `GET /locations`, `GET /service-categories`.
**Acceptance:** fresh DB → migrate → seed produces 8 categories, 3 cities, 13 areas; seed re-run is a no-op; drift check empty; constraint tests (radius 5 rejected, two primary addresses rejected) pass.
**Risks:** area centroid coordinates unavailable → temporarily null (distance falls back to "same area").

## Phase 2 — Auth & account (4–5 d)
**Files:** `modules/auth/*` (otp, token, sender interface + console sender + provider impl), `modules/users/*`, `common/guards|decorators`, throttler config.
**Endpoints:** `/auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout`, `GET/PATCH /me`.
**Acceptance:** golden path in e2e; lockout after 5 wrong codes; cooldown enforced; refresh rotation + reuse revocation; no OTP/tokens in logs; dev bypass impossible in production config.
**Work note (D-2):** `OtpSender` interface with the console sender only; `channel=WHATSAPP` returns `501`. **Delivered:** see `03-api-spec.md §7` and `05-security-testing.md §5`. `GET /me/savings` stays in Phase 6 as planned. **Risks:** MSG91 integration waits on DLT registration (days–weeks) — start it in parallel; nothing in Phases 0–7 is blocked by it.

## Phase 3 — Profiles, media, verification (5–6 d)
**Files:** `modules/customers`, `modules/workers` (profile, documents, location), `modules/media` (+ S3 impl), `modules/admin` (verify/reject), seed-demo (partial).
**Endpoints:** `PUT/GET/PATCH /customers/me`, addresses CRUD, `PUT/GET/PATCH /workers/me`, `PUT /workers/me/documents/:type`, `PUT /workers/me/location`, `POST /media/presign`, `GET /admin/workers`, `POST /admin/workers/:id/(verify|reject)`.
**Acceptance:** onboarding payloads from both screens round-trip; 3 trades / radius 5 / 0 languages rejected; key-prefix forgery rejected; Aadhaar keys never appear in non-admin responses; unverified workers excluded from later discovery.
**Delivered:** see `03-api-spec.md §8` and `05-security-testing.md §6`. Not in this phase by design: discovery (`GET /workers`, Phase 4) and the Socket.IO `location:update` event (Phase 5); the REST location endpoint is built. **Work note (D-4):** `WORKER_VERIFICATION_MODE=auto` (dev: approve on save when both Aadhaar images exist) vs `manual` (production: admin endpoints). Tests cover both modes and the production boot guard. **Risks:** Aadhaar compliance/legal review could change the document flow; object-storage account setup.

## Phase 4 — Jobs, leads, offers, direct booking, real-time (8–11 d)
**Files:** `modules/jobs` (create/list/get/cancel, state machine, expiry sweeper), `modules/offers` (leads feed, send/revise/withdraw, accept), `workers` discovery (`GET /workers`), `common/utils/geo.ts`, cursor util.
**Also:** `modules/realtime` (Socket.IO gateway, handshake JWT auth, rooms, `RealtimePublisher`), events `lead.new/lead.closed/direct.request/direct.declined/direct.expired/offer.*/job.status`; direct-booking flow (D-3) with `DIRECT_ACCEPT_TTL_MIN` expiry.
**Endpoints:** `POST /jobs`, `POST /jobs/direct-booking`, `POST /jobs/:id/direct/(accept|decline)`, `GET /customers/me/jobs`, `GET /jobs/:id`, `GET /jobs/:id/offers`, `POST /jobs/:id/offers/:offerId/accept`, `POST /jobs/:id/cancel`, `GET /leads`, `GET /leads/:id`, `POST /leads/:id/offers`, `GET /workers`, `GET /workers/:id`.
**Acceptance:** (realtime) socket with forged/expired JWT refused; `lead.new` reaches only matching verified workers and never a direct job; `offer.new` reaches only the job's customer; direct request: target accepts → ASSIGNED, decline/expiry → CANCELLED and customer notified, other workers never see it; worker sees only matching-trade, in-radius, OPEN leads; address never in lead payload; duplicate quote → 409; concurrent accepts → exactly one winner; expired jobs become CANCELLED; all state-machine rows covered by tests; discovery p95 < 300 ms on seeded 5k workers.
**Delivered:** see `03-api-spec.md §9`, `04-architecture.md §8` and `05-security-testing.md §7` (includes the benchmark: discovery p95 94 ms, lead feed p95 22 ms, lead query uses an index). Deliberately not in this phase: `Idempotency-Key`, free-text search `q`, `GET /workers/me/jobs` (Phase 5). **Risks:** distance/radius semantics without GPS (area-centroid fallback); lead-feed query cost → verified by `EXPLAIN` against the proposed index.

## Scheduling and availability (inserted between Phase 4 and Phase 5; requested 2026-10-10)
**Why here:** Phase 5 starts and finishes work; a worker must be able to hold a job in progress and future bookings without double-booking before those endpoints exist.
**Delivered:** see `01-requirements.md` (FR-SCHEDULING, BR-13 to BR-22), `03-api-spec.md §10`, `04-architecture.md §9`, `05-security-testing.md §8`. Migration `20261010180000_scheduling_and_availability` (new `worker_leads` table, booking columns, exclusion constraint, one-in-progress index).
**Carried into Phase 5 and now built** (each item is a real test in `test/phase5-requirements.e2e-spec.ts`, which began as 22 pending `todo` entries and has none left):
1. **Endpoints:** `POST /jobs/:id/arrival`, `PUT /jobs/:id/bill-items`, `GET /jobs/:id/bill`, `POST /jobs/:id/bill/approve`, `POST /jobs/:id/complete-work`, `POST /jobs/:id/payment`, `GET /jobs/:id/receipt`, `GET /jobs/:id/tracking`, `POST /jobs/:id/sos`, `GET /workers/me/jobs`, and the worker's back-out through `POST /jobs/:id/cancel`. **Built.**
2. **Ownership, not verification** (decision D-8): worker routes use `@RequireProfile('worker')` without `verified` and every query states `workerId = caller`. **Built**, tested for PENDING and REJECTED workers, strangers and a person holding both profiles.
3. **`workerFreed`** (`location.refresh`) at `WORK_COMPLETED`, on back-out and on a customer cancelling an assigned job; not again at payment. **Built.**
4. **Back-out clears the booking**: status OPEN, worker, accepted quote, assignment time, arrival code and attempts, booking window and confirmation cleared, visit-fee line removed, quote WITHDRAWN (with `accepted_at` kept so a second quote is refused as `BACKED_OUT`), fresh deadline; a direct booking becomes CANCELLED. **Built.**
5. **Re-opened leads are re-sent**: the once-only guard is reset for everyone except workers who declined and the one who backed out, so `lead.new` goes out again exactly once per re-open; the customer gets `job.reopened`. **Built**, with a regression test that fails if the reset is removed (checked by deliberately removing it).
6. **One job on site at a time**: friendly `409 WORKER_BUSY` plus the database index, both tested, including two simultaneous arrivals. **Built.**

## Phase 5 — Fulfilment (6–7 d) — **DONE 2026-10-11; CI verified, idle-machine benchmark still pending**
**Files:** `modules/fulfilment` (arrival, bill, completion, payment and receipt, tracking, worker's job list), `modules/safety` (SOS), `jobs/worker-backout.service.ts`, `jobs/open-until.ts`, the `location:update` handler in `realtime/realtime.gateway.ts`. No migration.
**Endpoints:** `GET /jobs/:id/tracking`, `POST /jobs/:id/arrival`, `PUT /jobs/:id/bill-items`, `POST /jobs/:id/work-photos`, `POST /jobs/:id/bill/approve`, `POST /jobs/:id/complete-work`, `GET /jobs/:id/bill`, `POST /jobs/:id/payment`, `GET /jobs/:id/receipt`, `POST /jobs/:id/sos`, `GET /workers/me/jobs`, `PATCH /admin/service-categories/:id/duration` (decision D-14). Contract: `03-api-spec.md §11`.
**Acceptance, and how each was checked:**
| Criterion | Status |
|---|---|
| Full lifecycle in e2e | **Met**: assigned -> arrived -> billed -> approved -> done -> paid -> receipt, in the e2e suite and in the built-app smoke test |
| Arrival lockout after 5 tries | **Met**, including 10 parallel guesses |
| Payment total equals the sum of items and `platformFee` is 0 | **Met** (amount is never accepted from the app) |
| Double-pay is idempotent | **Met**, including 10 simultaneous taps |
| Stale GPS (> 2 min) flagged in tracking | **Met**; a fix older than 30 min also loses its distance |
| SOS persists and notifies the configured channel | **Met against a recording notifier and a mocked webhook client**; **not** tried against a real receiver |
| Distances only from real coordinates | **Met**: `null` plus `distanceBasis` when the job or area has none (K-26) |
**Verified on GitHub (2026-10-11):** the CI workflow ran on PR #1 (branch `feature/backend-phases-0-5`) and succeeded, and again on the push to `main` after PR #1 was merged (2026-10-11), also succeeding, including the `btree_gist` step and the built-app smoke test. **Not verified:** the idle-machine benchmark (pending by instruction), real SOS delivery to a receiver, and real S3.
**Not built (documented):** worker payment confirmation, admin SOS acknowledge and `sos.acknowledged`, PDF receipts, retry for the SOS webhook. See `progress.md` §3.2 and K-27 to K-31.
**Also built:** `job.location`, `bill.updated`, `job.reopened` events and the `location:update` socket event (throttled to one stored fix per 3 s). **Risks that remain:** ETA quality without a routing provider (straight line x speed); payment honesty (customer self-reports).

## Phase 6 — Reviews, activity, earnings, savings (3–4 d) — **DONE 2026-10-11; merged into `main` (PR #2), CI passed on the PR and on `main`**
**Endpoints:** `POST /jobs/:id/review`, `GET /me/savings`, `GET /workers/me/earnings`, worker activity list, `GET /workers/:id` review summary.
**Acceptance:** review once per completed job by owner only; aggregates update atomically (concurrent reviews don't lose counts); activity tab counts match lists; IST day boundary tested around midnight.
**Note (D-5):** benchmark rate is config (default 20 %); `GET /me/savings` returns `benchmarkRate` so the app can disclose the basis.
**Delivered:** `POST /jobs/:id/review` (1-5 stars, five tags, tip 0-5000 recorded only; once, by the job's customer, after payment), `GET /workers/me/earnings?period=today|week|month` (Asia/Kolkata days), `GET /me/savings`, the review summary on `GET /workers/:id`, and `rating` / `reviewed` / `review` / `canReview` on the activity rows and the job. **No migration** (the table, counters and CHECKs existed). Contract: `03-api-spec.md §12`; controls and tests: `05-security-testing.md §10.2`.

| Acceptance | Status |
|---|---|
| Review once per completed job, by the owner only | **Met**: stranger, the job's own worker, unknown id 404; second review 409; ten simultaneous taps give one review |
| Aggregates update atomically (concurrent reviews do not lose counts) | **Met**: twelve customers rate one worker at once, all counted; totals equal the sum and count of the rows; mutation-checked |
| Activity tab counts match the lists | **Met** for the customer and the worker, across all three tabs |
| IST day boundary around midnight | **Met**: unit tests at 23:59:59.999 / 00:00 IST, Sunday night, month end and December; an e2e test puts payments 1 ms either side of midnight IST |

**CI:** the Phase 6 and arrival-recovery work passed on its pull request (run 38118304386, final commit `2552314`, including the extended smoke test) and on `main` after the merge (run 38120336005). **Not verified:** the idle-machine benchmark. **Verified:** the built-app smoke test, extended with the arrival-code reset, a review, earnings and savings, passed on 2026-10-11 against the dev database carrying the new migration. **Not built:** editing or removing a review, admin moderation, a worker-side list of their own reviews, tips in earnings.

### Arrival-code recovery (approved 2026-10-11; built in the same session as Phase 6)
`POST /jobs/:id/arrival-code/reset` (customer only, job ASSIGNED): a new random code, tries back to zero, **3 per assignment, 60 s apart**, enforced in one conditional `UPDATE`; append-only audit table `job_security_events` (lock, reset, refused reset; never a code); `job.arrival_code_reset` push without the code; `arrivalLocked` / `arrivalResetsLeft` in the job views. Guess budget stays at 20 of 10,000 per assignment. Migration `20261011150000_arrival_code_reset` was applied to the test database and, on 2026-10-11 after a verified backup and your review, to the **development** database (not elsewhere); the built-app smoke test passed against it. Tests: 16 e2e + 8 unit, and 6 database-integrity tests in `db-constraints`; the cap, cooldown and ownership were each removed to prove a test fails, and so were the later additions (lock audit, throttle, push recipients, the new CHECK and both foreign keys). Contract: `03-api-spec.md §11.9`.

## Phase 7 — Hardening & release (4–5 d)
**Work:** IDOR matrix tests, throttling tuning, load smoke, `EXPLAIN` review, OpenAPI export + contract check, Dockerfile/Procfile (per host decision), production env checklist, backup/restore drill, runbook, `DELETE /me` account deletion if approved (Q-17), dependency audit.
**Acceptance:** CI green incl. coverage gates; golden-path e2e passes against a staging deployment; migrations applied via the release step on staging from an empty and from a previous-version DB; `npm audit` clean for high/critical.

### Milestone A (built 2026-10-11 on `feature/phase-7-milestone-a`; pull request #3 open into `main`; CI run 38127145264 passed on `89a3964`, the seventh commit; the eighth commit, K-37, is pushed on top and its CI run is read separately)
Coverage measured and enforced (`npm run test:cov`, a CI step; merged lines 97.5 % overall, auth 94.2 %, jobs 98.9 %, offers 98.0 %, reviews 97.3 % against the 70 / 85 line thresholds, and 89.2 % of branches against a new 70 % branch gate); **D-8** worker re-verification; request logging with masking (a masking logger plus middleware); the **IDOR matrix** (34 routes with an id classified, 100 tests, no ownership defect); a **`ProfileGuard` review** with its two findings **fixed on your decision**: **K-5** (`403 ACCOUNT_DISABLED` on every protected route) and **K-36** (quotes of a worker under review hidden and not acceptable, `409 OFFER_UNAVAILABLE`). With the K-37 fix, 305 unit and 724 e2e tests pass (299 and 718 on the seventh commit, which CI run 38127145264 also passed). **Not started:** D-9, account deletion, load smoke and `EXPLAIN` review, OpenAPI export, release engineering and staging (Milestones B onward), and everything that waits on you (hosting, SMS sender, SOS receiver, S3, area coordinates, per-service durations, the idle-machine benchmark).

**Commits:** `9a32012` test: measure coverage and enforce the documented thresholds in CI; `d9cf7f8` feat: D-8 re-verification when a verified worker changes name or photo; `cab5e60` feat: masked logging and one log line per request; `c4ba0fb` fix: K-5 refuse disabled accounts on every protected route (403 ACCOUNT_DISABLED); `ac7c22a` fix: K-36 hide and refuse quotes of workers who are under review; `614d603` test: IDOR matrix over every route that takes an id in its path; `89a3964` docs: Phase 7 Milestone A; and an eighth, `fix: K-37 let a disabled account log out (revoke its own refresh tokens)`. **K-37 is fixed in the eighth commit** (logout was refused for a disabled account, so the session's refresh tokens stayed unrevoked): `POST /auth/logout` is the one protected route a disabled account may call. **Pull request #3** (base `main`) was opened by you and is open; I do not merge it. Details: `progress.md §0.9`, `05-security-testing.md §12.8`.

## Phase 8 — Optional (separate estimate after launch feedback)
MSG91 SMS provider (after DLT) and WhatsApp OTP · Redis: cache, Socket.IO adapter, throttler storage (when moving to AWS) · Push notifications for offline workers/customers (requires `DeviceToken` table + Expo/FCM; app has no push SDK today) · PDF receipts · real admin web UI · worker online/availability toggle · routing/ETA provider · PostGIS.

---

## Cross-phase risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Prisma CLI mismatch (`npm i prisma` gives v8 RC with no `generate`/`migrate dev`) | High if unpinned | Blocks work | Exact version pin + CI check |
| R-2 | SMS DLT / WhatsApp approval lead time | High | Blocks production launch (not development) | Start now; console sender for dev (D-2) |
| R-3 | Aadhaar legal exposure | Medium | High | No number stored; encrypted images; legal review before launch (Q-7) |
| R-4 | UI/back-end drift (fields UI never collects: UPI, vehicle, fee, cancel, emergency contact) | High | Medium | Gap list `01-requirements.md §8`; agree the frontend change list before Phase 3 |
| R-5 | Socket.IO behind a load balancer (AWS): sticky sessions / websocket-only transport, Redis adapter when >1 instance | Medium | Medium | Single instance at launch; Redis seam ready (D-6) |
| R-6 | Distance accuracy from area centroids | Medium | Medium | Prefer GPS when present; centroids verified by someone local |
| R-7 | Customer self-reported payment disputes | Medium | Medium | Optional worker confirmation, audit trail via timestamps |
| R-8 | Lost real-time events (best-effort delivery) | Medium | Low | REST refetch on reconnect/foreground; Postgres is source of truth |
| R-9 | Prisma 7.10 vs PostgreSQL 18 compatibility and shadow-DB permission on the local role | Low–Med | Blocks `migrate dev` | Verify first in Phase 0; use dedicated shadow DB if needed |
