# KaamConnect Backend: Progress Report

**Status as of 2026-10-11 (updated after Phase 5).** Every statement below was checked against the repository on that date (commands are listed in §9). Where something is written but not proven, it says so. Nothing incomplete is marked done.

**One-line summary:** Phases 0–5 are built and green: foundation, database, login, profiles/uploads/verification, the marketplace core, scheduling and availability, and now **fulfilment** (arrival with the customer's code, itemised bill with customer approval, work photos, completion, payment and receipt, live tracking, SOS, the worker's job list, and a worker backing out with a safe re-open). **Not yet verified:** the GitHub CI workflow (never run; one step was added and only its script was tested locally) and the idle-machine performance comparison (still pending by your instruction). Phase 6 (reviews, earnings, savings) has not started. Everything is still **uncommitted** in git.

---

## 0. State at a glance (re-verified 2026-10-11, end of session)

**How this section was checked, today, not copied from earlier notes:** `git status`, `git log`, `git ls-remote` and the public GitHub Actions API; `prisma migrate status` and `prisma migrate diff` on both databases; read-only queries on both databases; a grep of the controllers (60 route handlers); a search of the tests for `todo`/`skip` (none); and fresh runs of type-check, lint, format check, unit tests, the full end-to-end suite, build and `npm audit`. The built-app smoke test and the benchmark were **not** re-run today; their last results are dated below.

### 0.1 Phase 5: complete and incomplete

| Feature | Status | Evidence |
|---|---|---|
| Arrival with the customer's 4-digit code (5-try lock, constant-time compare, one job on site) | **Complete, tested** | `phase5-requirements` e2e (5 tests incl. 10 parallel guesses and two simultaneous arrivals) |
| Itemised bill: worker edits, customer approves the total shown (`expectedTotal`), frozen after approval | **Complete, tested** | e2e incl. the edit-vs-approve race |
| Before/after work photos | **Complete, tested** | `fulfilment` e2e |
| Complete-work (frees the worker) | **Complete, tested** | e2e |
| Payment (server-computed amount, idempotent) and JSON receipt | **Complete, tested** | e2e incl. 10 simultaneous taps; built-app smoke test |
| Tracking (`GET …/tracking`, `job.location`, socket `location:update`, stale flag; distance only from real coordinates) | **Complete, tested.** Distances stay `null` until coordinates exist (§0.7) | e2e; unit tests of `trip.ts` |
| SOS (stored first; pluggable channel; double-tap guard) | **Built and tested against a recording channel and a mocked HTTP client.** Never sent to a real receiver; no webhook is configured (§0.4) | e2e; unit tests |
| `GET /workers/me/jobs` (tabs, counts, unanswered quotes) | **Complete, tested** | e2e |
| Ownership-based access (D-8 rule for job-acting routes) | **Complete, tested** (PENDING and REJECTED workers, strangers, person with both profiles, access matrix over 11 routes) | e2e |
| `workerFreed` / `location.refresh` at completion, back-out, customer cancel | **Complete, tested.** Only helps if the phone answers with a fix (§0.7) | e2e |
| Worker back-out: booking cleared, lead guard reset and `lead.new` re-sent once per re-open, `BACKED_OUT` rule, direct booking cancelled | **Complete, tested** (regression test confirmed to fail when the reset is removed) | e2e; mutation check |
| Admin setting for a service's default duration | **Complete, tested** | e2e |
| **Not built:** worker payment confirmation (`/payment/confirm`), admin SOS acknowledge and the `sos.acknowledged` event, PDF receipts, SOS retry/queue, any way to unlock a locked arrival code, rescheduling a booking, showing the service default duration to the app | **Incomplete / not built** (each confirmed absent in the code today) | §3.2, K-27 to K-29 |
| **Approved earlier but still not built (outside Phase 5):** **D-8** a name or photo change on a VERIFIED worker re-opens review; **D-9** Aadhaar images deleted `AADHAAR_RETENTION_DAYS` after the decision | **Not built.** Checked in the code today: `resubmission()` handles only REJECTED profiles and there is no retention job | §4.3 |

### 0.2 Database migrations

| | Dev `KaamConnect` | Test `KaamConnect_test` |
|---|---|---|
| Migrations applied | **3 of 3**: `baseline`, `scheduling_and_availability`, `category_default_duration` | **3 of 3** |
| Pending / unfinished | none | none |
| `prisma migrate diff` vs `schema.prisma` | **no difference** | **no difference** |
| `btree_gist` | installed (1.8) | installed (1.8) |
| Data | 0 users, 0 jobs, 0 payments, 0 SOS alerts; reference data 8 / 3 / 13 | emptied and refilled on every e2e run (it held rows during today's check only because the test run was still going) |

Phase 5 added **no** migration. The pre-migration backup of the dev database is `KaamConnect-before-scheduling-2026-10-11.dump`, kept in a `KaamConnect-db-backups` folder next to the repositories on the dev machine (outside both repositories; verified readable when taken). There is no production database yet, so nothing has been migrated anywhere else.

### 0.3 Tests (fresh runs today)

| Check | Result |
|---|---|
| Unit (`npm test`) | **221 passed, 0 failed**, 25 files |
| End-to-end (`npm run test:e2e`, real PostgreSQL and WebSockets) | **534 passed, 0 failed, 0 skipped, 0 todo**, 19 files, 331 s |
| Pending or failing tests | **None.** A search finds no `it.todo`, `it.skip` or `describe.skip` in `src/` or `test/`. The 22 Phase 5 `todo` entries became 27 real tests |
| Type-check, lint (oxlint), Prettier check, `npm run build`, `npm audit --omit=dev` | all clean; 0 vulnerabilities |
| Built-app smoke test (`scripts/smoke.sh`, through COMPLETED) | passed **earlier today** on the dev database; **not re-run** at the end (no source changed after it, only documentation) |
| Performance suite (`npm run test:perf`) | 7 / 7 pass functionally, last run earlier today; the comparison is pending (§0.6) |
| Mutation check | six deliberate breakages, all caught (run earlier today) |

### 0.4 Decisions still open: arrival-code recovery and the SOS webhook

**Neither has been decided.** You have not answered either question, so nothing was changed.
- **Arrival-code recovery (K-27).** Behaviour today: five wrong codes lock the job for that assignment, and the only ways out are the worker backing out or the customer cancelling. Options: (a) keep it; (b) a customer-side "reset the code" action that issues a new code and clears the tries; (c) let the lock expire after a set time. I have recommended nothing as final; (b) is the smallest change that fixes both a mistyping worker and a customer who misread the code.
- **SOS webhook (K-28, Q-10).** `SOS_WEBHOOK_URL` is **not set** in the local `.env`. In development alerts only go to the log. **Production refuses to start without an https URL.** To decide: which private channel receives it (a Slack/Teams/PagerDuty bridge or your own endpoint), who watches it around the clock, and whether alerts need an acknowledge/retry flow (not built).
- **Q-5 (worker backs out → re-open) and Q-10 (SOS recipient)** were built on their documented defaults because you asked for the documented requirements; they were not separately confirmed.

### 0.5 Git and GitHub CI

| | Fact (checked today) |
|---|---|
| Branch / HEAD | `main` at `8d808e5` ("first commit"); two commits in total, both **docs only** (10 files) |
| Remote | `origin = https://github.com/ksingh3237/KaamConnectBackendAPI.git`; remote `main` is also `8d808e5`, so **nothing of Phases 0–5 has been pushed** |
| Uncommitted work | 9 modified tracked files (README + 8 docs), 1 staged deletion (`docs/proposed-schema.prisma`), and 20 untracked top-level entries including `src/`, `test/`, `prisma/`, `scripts/`, `package.json` and **`.github/`**. **I have not committed or pushed anything** |
| GitHub Actions | The workflow file has never been pushed. The public GitHub API for this repository reports **0 workflow runs**. **No CI run has ever happened, so there is no CI result. CI is NOT verified.** |
| What was verified locally about the CI file | the YAML parses (15 steps); the new `btree_gist` check step's shell logic exits 0 against local PostgreSQL 18 and exits 1 with its message when the extension is missing. Docker is not installed here, so the container itself was never run |

### 0.6 Pending verification: the idle-machine benchmark

Not done. Every run so far had Android Studio, an emulator, VS Code and Chrome open. **Original baseline** (single run after Phase 4, p95 in ms): `GET /workers` **94**, `GET /workers?categoryId=plumber&sort=rating` **24**, `GET /leads` **22**, `GET /customers/me/jobs` **7**, `POST /jobs` (fan-out to 244 workers) **52**, 20 simultaneous `GET /workers` about **1.0 s** wall, lead-feed SQL an index scan at 0.4 ms; budget 300 ms. Later runs (not idle): 90–104, 24–32, 26–34, 8–12 and 64–87 ms (§3.4). To close this: stop other applications, run `npm run test:perf` three times, compare with the baseline above, and investigate a reproducible difference. Measured costs of the new work in isolation: `GET /leads` about +2 ms, `POST /jobs` about +9 ms at p50.

### 0.7 Open requirements

| Item | State |
|---|---|
| **Service durations (D-14)** | Support is built and tested. **0 of 8 services have a value**, so every job is 90 minutes. Needs minutes per service from you; set with `PATCH /admin/service-categories/:id/duration` or `defaultDurationMin` in `prisma/data/service-categories.ts` plus a seed run |
| **Verified area coordinates (Q-18)** | **0 of 13 areas have coordinates.** Until they do (or the customer's address carries GPS) matching falls back to "same city", travel gaps assume 30 minutes, and tracking shows no distance or ETA (K-4, K-26) |
| D-8 name/photo change re-opens review | approved, **not built** |
| D-9 Aadhaar deletion (7 days, configurable) | approved, **not built**; counsel has not confirmed the rule or whether Aadhaar images may be collected at all |
| Arrival-code recovery; SOS webhook | open, §0.4 |
| Real S3 bucket test (K-3), hosting (Q-15), MSG91/DLT (production cannot boot without an SMS sender) | open, Phase 7 |
| Frontend work (G-14 to G-20) | outside this repository |
| Reviews, tips, earnings, savings (Q-8) | Phase 6, not started |

### 0.8 Exact next steps and blockers before Phase 6

See §8 for the ordered list. In one line: **there is no technical blocker; Phase 6 needs your explicit "go ahead with phase 6"**, and before that I recommend committing and pushing so CI can run, because six phases of work currently exist only on this laptop.

---

## 1. Phase status

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Scaffold, config validation, health, CI file | **Done** (CI never run on GitHub, see §4) | `src/main.ts`, `src/config/`, `src/health/`, `.github/workflows/ci.yml` |
| 1 | Schema (19 tables), baseline migration, reference seed, catalog API | **Done** | `prisma/`, `src/modules/catalog/` |
| 2 | Phone-OTP login, JWT + rotating refresh tokens, `/me`, global login guard | **Done** (MSG91/WhatsApp deliberately not built) | `src/modules/auth/`, `users/` |
| 3 | Customer + worker profiles, address book, signed uploads, admin verification, worker GPS ping | **Done** (S3 not exercised on real AWS, see §4) | `src/modules/{customers,workers,media,admin}/` |
| 4 | Jobs, worker discovery, leads, quotes, direct booking, Socket.IO push | **Done** (see §3 for exactly what; Idempotency-Key and search `q` deferred) | `src/modules/{jobs,offers,matching,realtime}/`, `workers/discovery/` |
| 4b | **Scheduling and availability** (requested 2026-10-10, decisions D-11 to D-14 approved 2026-10-11): `scheduledFor`, booking windows, overlap + travel-gap checks, one in progress + many future bookings, lead accept/decline, `worker_leads` duplicate guard, future-work radius (opt-in), location catch-up, worker calendar, per-service default job length | **Done and applied** to the test and the dev database. **Not covered:** the Phase 5 endpoints that start and finish work, and a worker backing out (K-22) | `src/modules/scheduling/`, `offers/lead-catch-up.service.ts`, migrations `20261010180000_scheduling_and_availability` and `20261011090000_category_default_duration`, `test/scheduling.e2e-spec.ts`; contract in `03-api-spec.md §10` |
| 5 | **Fulfilment** (go-ahead 2026-10-11): arrival (5-try lock, one job on site at a time), itemised bill with customer approval of the total shown, before/after photos, completion, payment (idempotent) and receipt, live tracking (`job.location`, socket `location:update`), SOS with a pluggable safety channel, `GET /workers/me/jobs`, ownership-based access (D-8), `workerFreed`, worker back-out with booking clean-up and a re-open that re-notifies workers, per-service duration setting (admin) | **Done and verified by tests** (534 e2e, 221 unit, built-app smoke test through COMPLETED). **Not verified:** CI on GitHub, idle-machine benchmark. **Not built:** see §3.2 | `src/modules/{fulfilment,safety}/`, `jobs/worker-backout.service.ts`, `test/{phase5-requirements,fulfilment}.e2e-spec.ts`; contract `03-api-spec.md §11` |
| 6 | Reviews, activity extras, earnings, savings | Not started | |
| 7 | Hardening and release | Not started | see §7 |
| 8 | Optional (MSG91, Redis, push, PDF, admin UI) | Not started | |

Roadmap estimate for the remaining work (`docs/07-roadmap.md`): Phase 5 7–8 d, Phase 6 3–4 d, Phase 7 4–5 d.

---

## 2. What is built (verified)

### Phases 0–3 (unchanged, see the previous version of this report in git history if needed)
- NestJS 12 (ESM), TypeScript 6, Vitest 4, oxlint. Environment validated at startup; production refuses the dev-only switches (`OTP_DEV_BYPASS`, `SMS_PROVIDER=console`, `WORKER_VERIFICATION_MODE=auto`, `STORAGE_PROVIDER=local`).
- 19 tables / 14 enums / 19 CHECKs / 2 partial indexes in one baseline migration; reference seed (8 categories, 3 cities, 13 areas).
- Phone-OTP login, rotating refresh tokens, global login guard, `/me`.
- Customer and worker profiles, address book, signed uploads (S3 provider + signed local stand-in), worker verification (manual in production, auto in dev), admin review queue, worker GPS ping.
- All DB connections pinned to UTC (`src/prisma/pg-adapter.ts`).

### Phase 4: the marketplace core
- **Matching** (`modules/matching/`): one rule for "does this worker serve this place": radius check when both sides have coordinates, otherwise same city. Used by the lead feed, notifications, lead/quote visibility and discovery, so they cannot disagree.
- **Jobs** (`modules/jobs/`): `POST /jobs` (broadcast; returns `notifiedWorkers`), `GET /customers/me/jobs` (Ongoing / Completed / Cancelled + counts, keyset paging), `GET /jobs/:id` (shape depends on who asks), `POST /jobs/:id/cancel`. Address is copied onto the job. Photos and voice note validated as the customer's own uploads. Limits: 10 open requests per customer.
- **Job state machine** (`jobs/state/job-state-machine.ts`): all 10 actions and 7 statuses defined once and unit-tested exhaustively. Phase 4 uses the transitions out of `OPEN` and customer cancel; the Phase 5 transitions (arrival, bill approval, completion, payment, worker back-out) are in the table but not yet wired to endpoints.
- **Expiry sweeper**: every minute; 24 h for broadcast, 10 min for direct requests; race-safe across instances.
- **Discovery** (`GET /workers`, `GET /workers/:id`): verified workers only, trade filter, other-area lookup, sort by distance or rating, stable paging, full worker card including phone (decision Q-16).
- **Leads and quotes** (`modules/offers/`): `GET /leads` (+ `/:id`), `POST /leads/:id/offers`, `PATCH`/`DELETE /offers/:id`, `GET /jobs/:id/offers` (Compare Offers, `isFastest`, `sort=fee|eta`), `POST /jobs/:id/offers/:offerId/accept` (one winner, arrival code generated, visit-fee bill line created, other quotes rejected).
- **Direct booking** (decision D-3): `POST /jobs/direct-booking`, `/jobs/:id/direct/accept`, `/direct/decline`; hidden from everyone but the requested worker; accepting records a system quote at the worker's own fee.
- **Real-time** (`modules/realtime/`): Socket.IO namespace `/realtime`, JWT handshake, server-assigned rooms, `job:watch` with ownership check, per-socket rate limit, 16 KB frame cap, sockets close when their token expires. `RealtimePublisher` is the abstraction business code uses (the Redis seam). Events: `lead.new`, `lead.closed`, `direct.request`, `direct.declined`, `direct.expired`, `offer.new/updated/accepted/rejected`, `job.status`.
- **No database migration was needed** (verified: still the single baseline, no drift).

### Scheduling and availability (between Phase 4 and 5)
See `docs/01-requirements.md` FR-SCHEDULING and `03-api-spec.md §10`: booking windows, overlap and travel-gap checks under a per-worker lock plus database constraints, the five separate pipeline states, lead accept/decline, the once-only lead guard (`worker_leads`), the opt-in wider future-work radius, location catch-up, and the worker calendar. Two migrations, applied to the test and the dev database.

### Phase 5: fulfilment (no migration needed)
- **Arrival** (`fulfilment/arrival.service.ts`): the assigned worker enters the customer's 4-digit code; attempts are counted in one atomic statement, five wrong tries lock the job (`429 CODE_LOCKED`), comparison is constant-time, the code is never shown to the worker, and arrival is refused while the worker is already on site at another job (`409 WORKER_BUSY`, also enforced by the database).
- **Bill** (`bill.service.ts`): visit fee added at acceptance; the worker replaces parts/labour/other items only while ARRIVED; the customer approves a total they were shown (`expectedTotal`), so a late edit cannot slip through; the edit and the approval are serialised by the job row.
- **Photos**, **completion** (`complete-work` -> WORK_COMPLETED, frees the worker), **payment** (customer records UPI/cash; amount is always the bill total; idempotent, also under 10 simultaneous taps) and **receipt**.
- **Tracking** (`tracking.service.ts`, `trip.ts`): position, `stale` flag after 2 minutes, and a distance/ETA **only** when the worker has a recent real fix and the job's place has real coordinates, with `distanceBasis` saying how exact; otherwise `null`. Live: `job.location` to `job:watch` subscribers from the REST update and from the socket event `location:update`.
- **SOS** (`modules/safety/`): stored first, then sent to a pluggable `SafetyNotifier` (webhook when `SOS_WEBHOOK_URL` is set, log otherwise); a failing channel never fails the request; a double tap within a minute returns the first alert.
- **Worker's job list** with tabs, counts and unanswered quotes. **Admin** `PATCH /admin/service-categories/:id/duration`.
- **Ownership, not verification** (D-8): worker routes require a worker profile, not `verified`, and every query states `workerId = caller`.
- **Back-out** (`jobs/worker-backout.service.ts`, one route `POST /jobs/:id/cancel` shared with the customer's cancel, decided by who owns the job): a broadcast job returns to OPEN with the assignment, window, code and bill line cleared, the once-only lead guard reset (except for workers who declined, and the one who backed out) so covering workers hear about it again; a direct booking is cancelled. The backing-out worker cannot quote that job again (`BACKED_OUT`).

---

## 3. Current implementation status

### 3.1 Routes that exist (60 handlers counted from the controllers; all under `/api/v1` except health)
| Area | Routes |
|---|---|
| Health (public) | `GET /health`, `GET /health/ready` |
| Auth | `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout` |
| Account | `GET/PATCH /me` |
| Catalog | `GET /locations`, `GET /service-categories` |
| Media | `POST /media/presign` |
| Customer | `GET/PUT/PATCH /customers/me`; addresses (`GET/POST`, `PATCH/DELETE /:id`, `POST /:id/primary`); `GET /customers/me/jobs` |
| Worker | `GET/PUT/PATCH /workers/me`; `PUT /workers/me/documents/:type`; `PUT /workers/me/location` |
| Discovery | `GET /workers`, `GET /workers/:id` |
| Jobs | `POST /jobs`, `POST /jobs/direct-booking`, `GET /jobs/:id`, `POST /jobs/:id/cancel` (customer cancels, or the assigned worker backs out), `POST /jobs/:id/direct/accept`, `POST /jobs/:id/direct/decline` |
| Leads and quotes | `GET /leads`, `GET /leads/:id`, `POST /leads/:id/accept`, `POST /leads/:id/decline`, `POST /leads/:id/offers`, `PATCH/DELETE /offers/:id`, `GET /jobs/:id/offers`, `POST /jobs/:id/offers/:offerId/accept` |
| Schedule | `GET /workers/me/schedule` |
| Fulfilment | `POST /jobs/:id/arrival`, `PUT /jobs/:id/bill-items`, `GET /jobs/:id/bill`, `POST /jobs/:id/bill/approve`, `POST /jobs/:id/work-photos`, `POST /jobs/:id/complete-work`, `POST /jobs/:id/payment`, `GET /jobs/:id/receipt`, `GET /jobs/:id/tracking`, `GET /workers/me/jobs` |
| Safety | `POST /jobs/:id/sos` |
| Admin | `GET /admin/workers`, `POST /admin/workers/:id/verify`, `POST /admin/workers/:id/reject`, `PATCH /admin/service-categories/:id/duration` |
| Dev only | `PUT/GET /dev-storage/:bucket/*key` (signed; 404 when S3 is configured; refused in production) |
| Socket.IO | namespace `/realtime`: `job:watch`, `job:unwatch`, `location:update` in (the last only for your own job on the way); events out are listed in `03-api-spec.md §9.6, §10.7, §11.5` |

### 3.2 Specified in `docs/03-api-spec.md` but **not built**
- `POST /jobs/:id/payment/confirm` (the worker confirms receipt; P3, no UI), `PATCH /admin/sos/:id` and the `sos.acknowledged` event (nobody can acknowledge an alert in the system yet; the desk acts outside it), PDF receipts (JSON only).
- Reviews and tips (`POST /jobs/:id/review`), `GET /workers/me/earnings`, `GET /me/savings` (Phase 6); `GET /config`; push notifications for offline users; `DELETE /me`; `Idempotency-Key`; free-text search `q`.
- Rescheduling an existing booking; routing-based travel times; showing the per-service default duration to the app.

### 3.3 Quality gates (run 2026-10-11)
| Check | Result |
|---|---|
| `npm run lint` (oxlint) | 0 warnings, 0 errors |
| `npm run typecheck` | clean |
| `npm test` (unit) | **221 / 221** pass, 25 files (was 198) |
| `npm run test:e2e` (real PostgreSQL `KaamConnect_test`, real WebSockets) | **534 / 534** pass, 19 files (was 473; +27 in `phase5-requirements.e2e-spec.ts`, which began as 22 `todo` and has none left, +34 in `fulfilment.e2e-spec.ts`) |
| `npm run test:perf` (5,000 workers, 50,000 jobs) | 7 / 7 pass **functionally**. The idle-machine comparison is still **pending** (§3.4) |
| `npm run build` | clean |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (incl. dev) | 4 high, all dev-only (`deepmerge-ts`, `mysql2` pulled in by the Prisma CLI) |
| Drift check, migrated **test** database vs `schema.prisma` (`prisma migrate diff`) | **no difference** (the new exclusion constraint, partial indexes and CHECKs are invisible to Prisma, as before) |
| Mutation check of the new tests | I broke the code on purpose in six ways and ran the matching tests: back-out not resetting the lead guard, back-out leaving the booking window, completion not freeing the worker, completion ignoring job ownership, worker routes demanding verification again, a backed-out worker able to quote again | **all six were caught** (each by the intended test); the code was restored and re-checked |
| `prisma migrate status` and drift check on **dev** `KaamConnect` | **up to date (3 migrations), no drift** (verified 2026-10-11 after applying; also confirmed `btree_gist` 1.8 installed, all new constraints, indexes and enum values present, reference data unchanged at 8/3/13, 0 users, 0 jobs) |
| `bash scripts/smoke.sh` on the built app against the dev DB | **passed 2026-10-11** with the script extended through Phase 5: login -> live lead -> quote -> accept -> wrong code refused -> arrive -> bill -> stale approval refused -> approve -> finish -> pay -> receipt -> COMPLETED. Its users, job and payment were removed afterwards; dev is back to 0 users / 0 jobs |

E2E tests by file: scheduling 64, workers 61, leads-offers 47, customers 44, jobs 41, auth 38, **fulfilment 34**, media 32, **phase5-requirements 27**, direct-booking 27, realtime 24, discovery 23, admin 21, db-constraints 16, marketplace-realtime 13, app 8, catalog 6, seed 5, timestamps 3.
Code coverage has **not** been measured and no coverage gate exists.

### 3.4 Benchmark at launch scale (test DB, 5,000 workers, 50,000 jobs, sequential, 40 samples)
All figures are p95 in ms. "Original" is the single run recorded after Phase 4. "Noisy" is the first run after the scheduling work (the laptop was busy). "Quieter" is three consecutive runs on 2026-10-11 with CPU around 10% (Android Studio, the Android emulator, VS Code and Chrome were still open; "idle" would be too strong).

| Endpoint | Original | Noisy | Quieter (3 runs) | Budget |
|---|---|---|---|---|
| `GET /workers` | 94 | 148–162 | 104, 90, 94 | 300 |
| `GET /workers?categoryId=plumber&sort=rating` | 24 | 41–70 | 32, 24, 26 | 300 |
| `GET /leads` | 22 | 34–54 | 34, 29, 33 | 300 |
| `GET /customers/me/jobs` | 7 | 16–17 | 9, 9, 12 | 300 |
| `POST /jobs` (fan-out to 244 workers) | 52 | 123–124 | 64, 67, 87 | – |
| 20 simultaneous `GET /workers`, wall time | ~1.0 s | 1.4–2.0 s | 1.2, 1.3, 1.9 s | – |
| Lead-feed SQL | index scan, 0.4 ms | index scan | index scan, 0.3–0.8 ms | no seq scan |

**Findings.** The large slowdown in the noisy run was the machine: with it quieter, discovery and the customer job list returned to (or within a few ms of) their original numbers, and `GET /customers/me/jobs` is unchanged in logic and in query count (its 7 → 9–12 ms p95 is inside the run-to-run spread of 9, 9, 12). Two real, small additions remain, both measured in isolation on the loaded data rather than inferred:
- `GET /leads`: about **+2 ms**: one availability query (1.6 ms) plus 0.2 ms of CPU for 20 cards. The extra "declined" filter and the new relation in the query cost nothing measurable (feed query p50 10.3 ms before, 10.0 ms after).
- `POST /jobs`: about **+9 ms** at p50 (+17 ms at p95): recording the 244 once-only delivery rows (8.4 ms p50) plus a 0.7 ms category lookup. This is the price of the duplicate guard. The secondary index on `worker_leads` costs only 0.7 ms of it, so I kept it.

No endpoint is anywhere near its budget. The original baseline was a single run, so differences of a few ms are not conclusive; nothing here justified a code change.

**Pending verification (your instruction, 2026-10-11): the idle-machine benchmark.** It has not been done: no run so far was on a truly idle machine (Android Studio, an emulator, VS Code and Chrome were open each time). Re-run `npm run test:perf` three times when nothing else is running and compare with the "Original" column above. One informal run after Phase 5 (not idle, so **not** the comparison) gave p95 of 104 ms (`GET /workers`), 26 ms (`GET /leads`), 8 ms (`GET /customers/me/jobs`) and 69 ms (`POST /jobs`). Phase 5 did not change those paths except `POST /jobs/:id/cancel`, which now looks up who owns the job first (one extra indexed query).

### 3.5 Databases
| | `KaamConnect` (dev) | `KaamConnect_test` |
|---|---|---|
| Schema | **3 migrations applied** (baseline, `scheduling_and_availability`, `category_default_duration`), 20 tables + `_prisma_migrations`; applied 2026-10-11 with `npm run db:migrate` after a verified backup (see below) | same (applied automatically by the e2e global setup) |
| Data | (no Phase 5 migration; the schema is unchanged) 8 categories, 3 cities, 13 areas, **0 users, 0 jobs**; **0 areas have coordinates** | emptied and re-seeded on every e2e run; the perf test leaves 5,000 workers + 50,000 jobs until the next e2e run |

### 3.6 Repository and CI
- Branch `main`; two commits (**docs and README only**). Remote `origin` = `github.com/ksingh3237/KaamConnectBackendAPI` configured.
- **Everything from Phases 0–5 is uncommitted** (`src/`, `test/`, `prisma/`, `scripts/`, `package.json`, `.github/`, doc updates). `docs/proposed-schema.prisma` is staged for deletion (duplicate of `prisma/schema.prisma`).
- **CI (`.github/workflows/ci.yml`) has never run on GitHub, so it is not verified.** Changes made: a step that checks PostgreSQL can provide `btree_gist` (the official `postgres:18` image ships it and `POSTGRES_USER` is a superuser, which is my understanding, not something I could run: there is no Docker here); the smoke test now reaches COMPLETED. What I did verify: the YAML parses (15 steps), and the shell of the new step behaves correctly against local PostgreSQL 18, both when the extension exists (exit 0) and when it does not (exit 1 with the error message).
- `.env` and `.local-storage/` are git-ignored. Your `.env` has `WORKER_VERIFICATION_MODE=auto` (so the smoke script works locally); it lacks the newer optional keys (defaults apply).

---

## 4. Pending tasks and known issues

### 4.1 Known errors
**None failing.** All checks above are green.

### 4.2 Known limitations and risks (verified)
| # | Item | Impact | Action |
|---|---|---|---|
| K-1 | Phases 0–4 are uncommitted and unpushed | A disk problem loses all the work | Your call when to commit/push; I do not commit unless asked |
| K-2 | CI workflow has never run on GitHub. It changed again in Phase 4 (adds `WORKER_VERIFICATION_MODE=auto`, a heavier smoke script that needs the `socket.io-client` dev dependency) | May fail for environment reasons | Push to a branch and read the first run |
| K-3 | `S3StorageService` has never talked to a real bucket | Production uploads unproven (unit tests prove the signature covers type and size) | Needs an AWS bucket (Q-15, Q-21) |
| K-4 | Area centroids are null | Matching uses the same-city fallback: a worker with a 3 km radius still gets every job in their city, and `distanceKm` is `null` everywhere. The radius rule is built and tested but dormant | Q-18 |
| K-5 | Access tokens cannot be revoked for 15 min; the JWT guard does not hit the DB | A disabled user keeps access until next refresh | Accepted for v1 |
| K-6 | Two parallel `/auth/refresh` calls with the same token end the login | A naive mobile client logs users out | Frontend must single-flight refresh |
| K-7 | `ProfileGuard` queries the DB on every guarded call | Small latency cost | Revisit in Phase 7 |
| ~~K-8~~ | `PUT /workers/me/location` is still accepted from any verified worker (they send it for lead matching) and now also from a worker in review **only while a job is assigned to them**; the job's live position is rebroadcast as `job.location`. **Resolved in the sense that matters:** pings are tied to a job for tracking | – | – |
| K-9 | Dev OTP is printed to the log (console sender); `OTP_DEV_BYPASS=true` makes it `123456` | Dev only; both refused in production | None |
| K-10 | No request/PII-masking logging interceptor | Minimal request logs | Phase 7 |
| K-11 | e2e suite empties `KaamConnect_test` on every run and needs a local PostgreSQL | CI needs a DB service | By design; the harness refuses any non-`*_test` DB |
| K-12 | Cosmetic: `customers.service.ts:191` has a stray `export type { UpdateAddressDto }` and a matching unused import | None | Left untouched |
| K-13 | PgBouncer in transaction mode would drop the UTC session pin unless `options` startup parameters are allowed | Wrong stored timestamps | Documented in `02-database.md §8` |
| **K-14** | **`pg` prints "Calling client.query() when the client is already executing a query is deprecated" during some transactions.** The stack is inside Prisma's runtime and `@prisma/adapter-pg` (not our code) | Becomes an error in `pg@9` | Keep `pg` on 8.x; re-check on each Prisma update |
| **K-15** | Discovery and notification filtering run in application code: about 40–60 ms CPU per request at 5,000 workers; 20 simultaneous calls take about 1 s | One server handles roughly 20 such requests/s (extrapolated) | Fine for launch; first thing to move into SQL / cache (the Redis seam) if traffic grows |
| **K-16** | Safety caps: 20,000 workers per discovery/notification request (logs a warning if reached); the lead feed looks at the newest 500 open jobs of a worker's trades | Incomplete results beyond those sizes (not realistic for one metro) | Documented; revisit with PostGIS/SQL filtering |
| ~~K-21~~ | **Resolved 2026-10-11.** The scheduling migrations were applied to the dev database after a backup. **Backup:** `KaamConnect-before-scheduling-2026-10-11.dump` in a `KaamConnect-db-backups` folder next to the repositories on the dev machine (pg_dump custom format, 20 tables, verified readable with `pg_restore --list`; stored outside both repositories). **Restore if ever needed:** drop and recreate `KaamConnect`, then `pg_restore -d KaamConnect <file>`. **Irreversible parts, for the record:** adding the `SCHEDULED` value to the `JobTiming` enum cannot be undone in PostgreSQL without rebuilding the type, and the `btree_gist` extension stays installed. Nothing was dropped or deleted; the only data statement is a back-fill that touched 0 rows (no jobs existed) | – | – |
| ~~K-22~~ | **Resolved in Phase 5** for everything the scheduling work depended on: arrival, completion, payment, tracking and SOS now exist; `workerFreed` is called at completion, back-out and customer cancel; back-out clears the booking and re-notifies workers; routes are gated by ownership. Each is covered by a test in `phase5-requirements.e2e-spec.ts`. **Still app-dependent:** the refresh only helps if the phone answers `location.refresh` with a fix and the person allowed location | – | – |
| **K-26** | Distances and ETAs in tracking are `null` until real coordinates exist: the 13 areas have none (Q-18) and the customer app does not yet send GPS with the address. Tracking says so (`distanceBasis: null`) instead of guessing | The map screen shows the worker's dot but no "1.1 km away" until Q-18 is done | Q-18 |
| **K-27** | Five wrong arrival codes lock the job for that assignment, with no unlock path other than the worker backing out or the customer cancelling | A worker who mistypes can be stuck; a customer who misreads the code too | Product decision: add a customer-side "resend/reset code" if wanted |
| **K-28** | SOS: the alert is stored and sent to one webhook (5 s timeout, no retry). No acknowledge/resolve endpoint and no `sos.acknowledged` event. **Production now refuses to boot without `SOS_WEBHOOK_URL`** (https), like the other safety guards | An unreachable desk is only visible in the logs; alerts stay `OPEN` forever | Phase 7: retry/queue + admin acknowledge; set `SOS_WEBHOOK_URL` before launch |
| **K-29** | Payment is the customer's own statement; the platform neither moves nor verifies money (BR-2). The worker-confirm path (`POST /jobs/:id/payment/confirm`) is not built | A dishonest "Paid" is possible | R-7; add the confirm path if disputes appear |
| **K-30** | `GET /workers/me/jobs` lists unanswered quotes (`pendingQuotes`) outside the paging, capped at 50 | A worker with more than 50 waiting quotes sees the 50 newest | Fine for launch |
| **K-31** | The CI workflow is unverified (see §3.6) and the `btree_gist` assumption is untested on GitHub | The first run could fail for an environment reason | Push to a branch and read the first run; do not treat CI as passing until then |
| **K-23** | Straight-line travel times; and no service has its own job length yet (D-14 support is built but the numbers are empty) | A long job (AC installation) can be booked over by a short one; short jobs block more than needed | Supply minutes per service (`defaultDurationMin` in `prisma/data/service-categories.ts`, then re-run the seed), A-18 |
| **K-24** | Location catch-up remembers where it last matched each worker in memory, per instance; at most one look per worker per minute | After a job ends, new nearby leads can take up to a minute to arrive; with several instances a worker may be looked at more often (harmless: the delivery guard prevents duplicates) | Fine for launch; move the mark into the Redis seam (D-6) if needed |
| ~~K-25~~ | Quote-time availability is a hard check. **Approved as D-12 (2026-10-11).** | – | – |
| **K-17** | No `Idempotency-Key`: a double tap on "Broadcast" creates two requests | Two identical open jobs (cap of 10 limits harm) | Add if the app cannot prevent double taps |
| **K-18** | Push is best effort and only reaches connected apps; offline workers hear nothing until they open the app | A worker who is not running the app misses a lead | Phase 8 push notifications; REST remains the source of truth |
| **K-19** | Socket.IO has only run on a single instance; the Redis adapter, sticky sessions / websocket-only transport for AWS are not built or tested | Breaks events when scaled to 2+ instances | Phase 7/8 (D-6) |
| **K-20** | The `test:perf` benchmark runs locally on demand only (not in CI) | Regressions not caught automatically | Optional nightly job in Phase 7 |

### 4.3 Documented but not built
| Item | Documented in | Planned phase |
|---|---|---|
| `prisma/seed-demo.ts` / `npm run db:seed:demo` | `06-migrations-seeds.md`, roadmap Phase 3 | Not delivered; schedule with Phase 5 or 7 |
| OpenAPI export and contract check in CI (`@nestjs/swagger` not installed) | `04`, `05`, roadmap Phase 7 | 7 |
| Coverage gates | `05-security-testing.md` | 7 |
| k6 / autocannon load test beyond the in-repo benchmark | roadmap Phase 7 | 7 |
| Dockerfile / Procfile, staging deployment | roadmap Phase 7 | 7 (needs hosting decision) |
| `LoggingInterceptor` with phone masking | `04-architecture.md` | 7 |
| `Idempotency-Key` | `03-api-spec.md §1` | See K-17 |
| `CacheService` and Redis seams | `04-architecture.md §7` | 8 |
| MSG91 sender, WhatsApp OTP | D-2 | 8 (blocked on DLT) |
| `DELETE /me` | Q-17 | 7 |
| Aadhaar image retention job (`AADHAAR_RETENTION_DAYS`, default 7; S3 lifecycle cap; probable `reviewed_at` migration, ask first) | D-9 (was Q-20) | 7 |
| Name or photo change on a VERIFIED worker re-opens review (normalised name compare, different `photoKey`, both modes) | D-8 (was Q-19) | small change; do before or with Phase 5 |

### 4.4 Documentation corrections made while writing this report
- `docs/01-requirements.md` D-7 now states the real git state. `docs/07-roadmap.md` Phase 4 heading now says 8–11 d.

---

## 5. Important architecture and database decisions

### 5.1 Decided by you (full text in `docs/01-requirements.md §11.1`)
| ID | Decision |
|---|---|
| D-1 | Native local PostgreSQL 18; databases `KaamConnect` and `KaamConnect_test`; no Docker |
| D-2 | `OtpSender` interface; console sender in dev; MSG91 later; WhatsApp later |
| D-3 | "Book Pro" direct booking requires the worker to accept; hidden from other workers; lapses after 10 min |
| D-4 | Worker verification: manual admin review in production, simulated auto-approve in dev |
| D-5 | "Total saved" benchmarked against a competitor commission, default 20 %, configurable |
| D-6 | Socket.IO real-time in v1, Redis optional; OTP/sessions stay in PostgreSQL |
| D-7 | Backend is its own git repository |

### 5.2 Design decisions taken in implementation
| Decision | Why | Where |
|---|---|---|
| Modular monolith, one PostgreSQL, no Redis/queues in v1 | Launch scale | `04-architecture.md` |
| One `jobs` table carries the whole lifecycle; address is **snapshotted** on the job | Request and booking are one thing in the UI; address edits must not rewrite history | schema |
| **The job state machine is a table** (`job-state-machine.ts`); every status change goes through it | Illegal transitions can only come from editing one file; tests walk every combination | `modules/jobs/state/` |
| **Concurrency by conditional update, not by read-then-write**: each decision is `UPDATE … WHERE status='OPEN' …` and the row count says who won; quoting share-locks the job row | Several customers, workers and sweepers act at once; safe on several instances | `offers.service.ts`, `direct-booking.service.ts`, `job-expiry.service.ts` |
| **One matching rule** for feed, notifications, visibility and discovery | They must never disagree about who can see what | `matching/coverage.ts` |
| Direct bookings are ordinary jobs with `targetWorkerId`; accepting creates a system quote at the worker's own fee | Everything after assignment treats both kinds the same | `direct-booking.service.ts` |
| Pushes go through `RealtimePublisher` after commit; the gateway is replaceable | Redis/multi-instance later without touching business code | `modules/realtime/` |
| Privacy by construction: address and phone are only added to a view for the owner or the assigned worker; pushes carry a deliberately small summary | Decision from the app's own "Privacy Shield" text | `job-view.service.ts` |
| Money is whole INR integers; UUIDv7 keys; money/range rules also enforced by CHECK constraints | Data integrity | schema, baseline migration |
| Roles are profiles, not token claims; each route declares the profile it acts as, checked against the DB | Mode switching is client-side | `profile.guard.ts` |
| Admin is `users.is_admin` set by hand; admin routes answer 404 to everyone else | No admin API to attack | `profile.guard.ts` |
| Prisma pinned to **7.10.0**; all DB connections pinned to the **UTC** session | Stability; Prisma's pg adapter otherwise stores timestamps shifted by the server's zone | `package.json`, `pg-adapter.ts` |
| `socket.io` pinned to **4.8.3**, exactly the Nest adapter's version | A second copy breaks the TypeScript types | `package.json` |
| Aadhaar number never stored; images in a separate private bucket, never returned to customers/workers | Legal sensitivity | `media-rules.ts` |
| Tests run against real PostgreSQL and real WebSockets; harness refuses any DB not named `*_test` | Constraints and races are DB behaviours | `test/` |
| Distance = haversine on coordinates, same-city fallback; ETA = distance ÷ 20 km/h; no PostGIS | Tricity scale | A-5, A-11 |

---

## 6. Open questions (`docs/01-requirements.md §11.2`)

Answered by you: Q-1, 2, 3, 7, 9, 13 and the real-time/Redis question (D-1…D-7); Q-19, 20, 21 on 2026-10-10 (D-8…D-10, recorded in `01-requirements.md §11.1`; no code changed). **Everything below runs on the stated default until you decide.**

| ID | Question | Default in use | Blocks |
|---|---|---|---|
| **Q-18** | Verified `lat/lng` for the 13 areas | none: same-city matching | Distance and radius actually applying (K-4); also makes the travel gap use real distances instead of 30 minutes; not a blocker for Phase 5 |
| ~~Q-23~~ | **Answered 2026-10-11 → D-11:** accepting a quote books immediately | n/a | – |
| ~~Q-24~~ | **Answered 2026-10-11 → D-12:** conflicting quotes and bookings are rejected | n/a | – |
| ~~Q-25~~ | **Answered 2026-10-11 → D-13:** the wider radius is opt-in | n/a | – |
| ~~Q-26~~ | **Answered 2026-10-11 → D-14:** 90 minutes default, configurable per service. **Follow-up for you:** the actual minutes per service (all 8 are empty, so everything is 90) | 90 for every service | nothing |
| Q-4 | Lead `budget` / "Within 1 Hour" | lead cards show the category `baseVisitFee`; "Within 1 Hour" dropped (**now implemented**) | nothing |
| Q-5 | Worker backs out after assignment: re-open the job? | yes, re-open and notify. **Built on this default** (you asked for the documented requirements; it was not separately confirmed) | nothing now |
| Q-6 | Worker visiting-fee field | optional field (built; used by direct booking and cards) | nothing |
| Q-8 | Tips | record-only | Phase 6 |
| Q-10 | SOS recipient / emergency contact | a webhook you configure (`SOS_WEBHOOK_URL`). **Built on this default**, not separately confirmed. No emergency-contact field exists | You must set the webhook before production |
| Q-11 | 13 vs 19 areas | 13 built, 6 behind a flag | nothing |
| Q-12 | `[6-9]` mobile prefix | yes (built) | nothing |
| Q-14 | Prisma 7.10 rather than 8 RC | yes (pinned) | nothing |
| Q-15 | Hosting / storage provider | AWS S3 + RDS | **Phase 7** and the first real S3 test |
| Q-16 | Show worker phone to logged-in customers | yes (**implemented** on cards, offers, assigned view) | nothing |
| Q-17 | Account deletion | yes, Phase 7 | Phase 7 |
| ~~Q-19~~ | **Answered 2026-10-10 → D-8:** a normalised name change on a VERIFIED worker returns the profile to PENDING (both modes). **Not built yet** | n/a | Shapes Phase 5: job-acting routes must gate on job ownership, not VERIFIED |
| ~~Q-20~~ | **Answered 2026-10-10 → D-9:** delete Aadhaar images 7 days after the decision (configurable). **Not built yet**, so images are still kept indefinitely | n/a | Phase 7; legal sign-off on collecting Aadhaar images still open |
| ~~Q-21~~ | **Answered 2026-10-10 → D-10:** `ap-south-1` (Mumbai) | n/a | First real S3 test (K-3) / Phase 7 |
| ~~Q-22~~ | **Answered 2026-10-10 → yes**, folded into D-8: a different `photoKey` on a VERIFIED worker also returns the profile to PENDING (removing the photo does not). **Not built yet** | n/a | Same small change as D-8 |

Frontend gaps recorded (G-14…G-19): "Book Pro" waiting state, worker "under review" copy, socket client and token refresh, non-empty address line, real upload flow, and (new) the exact values/screens the app must send and listen to for jobs, quotes and live updates.

---

## 7. Dependencies

### Phase 5: tracking, arrival, bill, payment, SOS (built)
| Item | State |
|---|---|
| Schema changes | **None were needed** |
| Worker UPI id for the pay QR (G-3) and vehicle (G-4) | Fields exist and are returned (`payTo.upiId`, tracking `vehicle`); the app does not collect them yet |
| Frontend: map SDK, `expo-location` for worker pings, socket client (`location:update`, `job.location`, `bill.updated`, `job.reopened`, `location.refresh`) | Outside this repo; contract in `03-api-spec.md §11` |
| `SOS_WEBHOOK_URL` | Needed in production (boot refuses without it) |
| Real coordinates for areas (Q-18) and customer GPS | Needed for distances to appear (K-26) |

### Phase 7: hardening and release
| Dependency | State |
|---|---|
| Hosting target and deployment method (Dockerfile/Procfile, staging) | **Open** (Q-15) |
| Real S3 buckets (media + private), IAM role | **Open** (Q-15); region decided: `ap-south-1` (D-10); first real upload test not yet done |
| **MSG91 + DLT registration for production login.** Production boot currently refuses the console sender and no other sender exists, so **the API cannot start in production until MSG91 is built** | **Open, external lead time** |
| Multi-instance real-time (Redis adapter, sticky sessions or websocket-only transport) | Not built (K-19) |
| Legal sign-off on Aadhaar handling; retention rule decided (D-9: 7 days, configurable) but counsel has not confirmed it | **Open** |
| `DELETE /me` (Q-17), coverage gates, OpenAPI export, request logging, first GitHub CI run, backup/restore drill, runbook | Not done |
| Phases 5–6 feature-complete (golden-path e2e needs them) | Pending |

---

## 8. Exact next task and recommended next steps

**Phase 6 (reviews, activity extras, earnings, savings; tips are record-only per the default for Q-8) has NOT started.** It needs your explicit "go ahead with phase 6".

**Hard blockers for starting Phase 6:** none technical. Phase 6 builds on completed jobs, which exist and are tested.

**Strongly recommended first, in this order:**
1. **Commit and push.** Everything since the first commit exists only locally (§0.5). Say the word and I will commit in sensible pieces and push; I have not, because nothing here may be committed without you asking. The workflow file travels with it.
2. **Read the first GitHub Actions run.** Until it runs and passes, CI is unverified (K-31). If the `btree_gist` check step fails, its message says what to change. Do not treat CI as passing before then.
3. **Re-run the benchmark on an idle machine** three times and compare with the baseline in §0.6.
4. **Decide the two open questions** in §0.4 (arrival-code recovery; SOS webhook and who watches it).
5. **Supply per-service minutes** and **verified area coordinates** (§0.7).

**Approved work still to do, which I can schedule with or before Phase 6 if you wish:** D-8 (name/photo change re-opens review: a small change in `workers.service.ts` plus tests) and D-9 (Aadhaar deletion job, Phase 7, probably one small migration, which I would ask about first).

**Phase 7 carry-overs:** SOS retry/acknowledge, worker payment confirmation if disputes appear, IDOR matrix extension (an access matrix for the 11 new routes already exists in `fulfilment.e2e-spec.ts`), a nightly run of the contention tests, the first real S3 test, MSG91, the legal items.

**Not part of the next step:** MSG91, Redis, and any change to the mobile app.

---

## 9. How this report was verified (2026-10-11 for the scheduling work; the rest 2026-10-10)

| What | Command / source | Result |
|---|---|---|
| Source layout and routes | `find src`, grep of route decorators in `*.controller.ts` | 60 handlers (was 45 after Phase 4; the count in this row is from 2026-10-11); `jobs`, `offers`, `matching`, `realtime` modules exist; no bill / payment / tracking code |
| Quality gates | `npm run lint`, `typecheck`, `test`, `test:e2e`, `test:perf`, `build`, `npm audit` | see §3.3 |
| Test counts | `npm test`, `npm run test:e2e` | unit 221 (25 files), e2e 534 (19 files); a baseline before Phase 5 was 198 + 473 |
| Migration and drift | `prisma migrate status`, `prisma migrate diff --exit-code` | up to date, no drift, no new migration |
| Dev data | row counts | 0 users, 0 jobs, 0 offers; 8/3/13 reference rows; 0 areas with coordinates |
| End-to-end on the built app | `bash scripts/smoke.sh` against the dev DB, then cleanup | passed; DB back to 0 users / 0 jobs |
| Git | `git log`, `git status`, `git remote -v` | 2 docs-only commits; all code untracked or modified; `origin` configured |
| Docs vs code | grep of 12 promised items | the gaps in §4.3 |
| Open questions | read from `docs/01-requirements.md` §10 and §11 | §6 |
| Benchmark | `npm run test:perf` | §3.4 |
| Scheduling: unit + e2e | `npm test` → 198 pass; `npm run test:e2e` → 473 pass + 22 todo (a baseline run before the work: 151 + 409 pass) | the 64 new e2e tests cover busy workers, scheduling, the five states, per-service duration, overlap, travel gap, races, DB backstop, radius, catch-up, duplicates, access |
| The lock matters | removed `pg_advisory_xact_lock` temporarily, ran the travel-gap race test | failed with `[200, 200]`; restored and green |
| Migration vs schema | `prisma migrate diff --from-config-datasource --to-schema` on the migrated test DB | no difference |
| Build, lint, types, audit | `npm run build`, `lint`, `typecheck`, `npm audit --omit=dev` | clean; 0 vulnerabilities |
| Dev database migration (2026-10-11) | read-only check of the connection (host localhost, database `KaamConnect`, `NODE_ENV=development`, 0 users / 0 jobs), `pg_dump` + `pg_restore --list`, scan of the SQL for DROP/DELETE/TRUNCATE (only `ON DELETE CASCADE` on the new table), `npm run db:migrate`, then `migrate status`, `migrate diff` and catalog queries | applied cleanly; up to date, no drift, extension and constraints present |
| Smoke test on the migrated dev DB | `npm run build`, `bash scripts/smoke.sh`, then removal of its users and job | passed; dev back to 0 users / 0 jobs |
| Performance | `npm run test:perf` ×3 on the quieter machine, plus temporary profiling tests (removed) | §3.4 |
| Not verified | CI on GitHub (never run), performance on a truly idle machine, `btree_gist` creation by a non-superuser role on RDS | see K-2, §3.4, `02-database.md §5` |
| Phase 5 first run | wrote the real suite, ran it | 25 of 27 passed; the 2 failures were mistakes in my test set-up (a worker cannot take two overlapping immediate jobs, which is the scheduling rule working), fixed; then 27 + 34 pass |
| Phase 5 CI step | parsed the workflow with js-yaml; ran the step's shell against local PostgreSQL 18 with the extension present and with it renamed to a missing one | exit 0 and exit 1 with the intended message. **GitHub itself has not run it** |
| Not verified | CI on GitHub, performance on an idle machine, `btree_gist` creation by a non-superuser role on RDS, `SOS_WEBHOOK_URL` against a real receiver (the webhook client is unit-tested against a mocked `fetch`) | §3.4, §3.6, K-28, K-31 |
| Final re-verification (2026-10-11, end of session) | `git status/log/ls-remote`; public GitHub Actions API; `prisma migrate status` + `migrate diff` on dev and test; read-only SQL on both databases; grep of controllers and tests; `tsc`, `oxlint`, Prettier, `npm test`, `npm run test:e2e`, `npm run build`, `npm audit --omit=dev` | §0: 221 unit and 534 e2e pass with none skipped; no drift; 0 workflow runs; remote = docs-only commit |
| Corrected | I had written "2026-10-12" for the Phase 5 work; the system date is 2026-10-11, so every such date in the docs was corrected | – |
