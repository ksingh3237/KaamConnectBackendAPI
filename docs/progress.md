# KaamConnect Backend: Progress Report

**Status as of 2026-10-11 (updated after Phase 6 and arrival-code recovery).** Every statement below was checked against the repository on that date (commands are listed in §9). Where something is written but not proven, it says so. Nothing incomplete is marked done.

**One-line summary:** Phases 0–6 are built and green locally: foundation, database, login, profiles/uploads/verification, the marketplace core, scheduling and availability, fulfilment (arrival, bill, completion, payment, tracking, SOS, worker back-out), and now **arrival-code recovery** (a customer can issue a new code, 3 per assignment, 60 s apart, fully audited) and **Phase 6** (reviews and tips, activity extras, worker earnings, "commission saved"). **CI is verified for Phases 0–5:** the GitHub Actions run on PR #1 succeeded (17 steps), and the run after PR #1 was merged into `main` also succeeded (21 steps) (§0.5); **CI also passed for the arrival-recovery and Phase 6 work**: run 38118304386 on PR #2's final commit `2552314` (all 17 steps) and run 38120336005 on `main` after the merge. **Not verified:** the idle-machine performance comparison (pending), real delivery of an SOS alert (no receiver exists), real S3. **Dev database:** the `arrival_code_reset` migration was applied to `KaamConnect` on 2026-10-11 after a verified backup, and the extended built-app smoke test (including the arrival-code reset, a review, earnings and savings) passed against it. PR #1 **was merged into `main` on 2026-10-11 at 03:18:55 UTC, not by me** (I was told not to merge it and did not). The arrival-recovery work, Phase 6 and the smoke-test extension are on the branch `feature/phase-6-and-arrival-recovery` as five commits (you approved the plan) plus a sixth follow-up commit made after the code review (documentation corrections, a schema comment, 11 more tests), and were merged into `main` by you on 2026-10-11 at 07:07:51 UTC (merge commit `7e94da2`; I did not merge it) through **pull request #2**.

**Phase 7, Milestone A (2026-10-11): MERGED into `main` by you as pull request #3 (merge commit `b33f5ec`, 10:14:55 UTC; I did not merge it).** GitHub Actions run 38127145264 passed on the seventh commit `89a3964`, run 38129422267 on the eighth commit `755b97a` (K-37, all 18 steps), and run 38131265301 on `main` after the merge (all read through the public API). It contains: measured and CI-enforced coverage (merged 97.5 % of lines, 89.2 % of branches); D-8 worker re-verification; masked request logging; an IDOR matrix over all 34 routes with an id; a `ProfileGuard` rewrite; and the fixes for **K-5**, **K-36** and **K-37**. **Phase 7, Milestone B is in progress (§0.10)** on `feature/phase-7-milestone-b` (pushed, **no pull request, so GitHub CI has not run on it**) plus two local-only branches that hold changes waiting for your approval. Standing limits until you say otherwise: do not merge any pull request, do not modify `main`, do not start Phase 8, do not apply an unapproved migration, no deploy.

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
| **Arrival-code recovery** (`POST /jobs/:id/arrival-code/reset`): customer-only, job ASSIGNED, new random code, tries back to 0, **max 3 per assignment, 60 s cooldown**, audit table `job_security_events`, `job.arrival_code_reset` push (no code), `arrivalLocked` / `arrivalResetsLeft` in the job views | **Complete, tested locally.** Dev migration applied and smoke-tested in the built app (§0.2, §0.3) | `arrival-code-reset.e2e-spec` (16 tests), unit tests (8), plus 6 database-integrity tests in `db-constraints`; mutation checks (cap, cooldown, ownership; then lock audit, throttle, push recipients, the redraw loop, the new CHECK and both foreign keys) each caught |
| **Phase 6: reviews and tips** (`POST /jobs/:id/review`; 1-5 stars, 5 tags, tip 0-5000 recorded only; once, owner only, after payment; totals never lose a count) | **Complete, tested locally** | `phase6.e2e-spec` |
| **Phase 6: activity extras** (`rating` / `reviewed` on completed rows for both sides, `review` / `canReview` on the job, review summary with star split and latest ten on `GET /workers/:id`) | **Complete, tested locally** | `phase6.e2e-spec` |
| **Phase 6: worker earnings** (`GET /workers/me/earnings?period=today\|week\|month`, Asia/Kolkata days) and **savings** (`GET /me/savings`, rate `COMMISSION_BENCHMARK_RATE`, default 0.20) | **Complete, tested locally.** Day boundaries unit-tested at 23:59:59.999 / 00:00 IST | `phase6.e2e-spec` (23 tests in total), `ist-time.spec`, `earnings.service.spec`; five mutation checks caught |
| **Not built:** worker payment confirmation (`/payment/confirm`), admin SOS acknowledge and the `sos.acknowledged` event, PDF receipts, SOS retry/queue, rescheduling a booking, showing the service default duration to the app | **Incomplete / not built** (each confirmed absent in the code today) | §3.2, K-27 to K-29 |
| **Approved earlier but still not built (outside Phase 5):** **D-9** Aadhaar images deleted `AADHAAR_RETENTION_DAYS` after the decision | **Not built.** Checked in the code today: there is no Aadhaar retention job (D-9). D-8 was built in Phase 7, Milestone A | §4.3 |

### 0.2 Database migrations

| | Dev `KaamConnect` | Test `KaamConnect_test` |
|---|---|---|
| Migrations applied | **4 of 4**, including `20261011150000_arrival_code_reset`, applied 2026-10-11 with `npm run db:migrate` (`prisma migrate deploy`) after a verified backup (§0.2 below) | **4 of 4** (applied by the e2e global setup) |
| Pending / unfinished | none | none |
| `prisma migrate diff` vs `schema.prisma` | **no difference** (checked after applying, and again after the smoke test) | **no difference** |
| `btree_gist` | installed (1.8) | installed (1.8) |
| Data | 0 users, 0 jobs, 0 payments, 0 SOS alerts; reference data 8 / 3 / 13 | emptied and refilled on every e2e run (it held rows during today's check only because the test run was still going) |

Phase 5 and Phase 6 added **no** migration; arrival-code recovery added one, applied to dev on 2026-10-11 after a verified backup: `KaamConnect-before-arrival-code-reset-2026-10-11.dump` (63,124 bytes, readable by `pg_restore --list`, kept in the `KaamConnect-db-backups` folder next to the repositories). Before applying I confirmed the target (`localhost`, database `KaamConnect`, `NODE_ENV=development`, 3 migrations, 0 users, 0 jobs); afterwards `migrate status` says up to date, the enum, both columns, the table, its two foreign keys, its index and the CHECK exist as written, and reference data is unchanged (8 / 3 / 13). The smoke test later advanced the `jobs.job_number` sequence to 10003 (it is not reset). The pre-migration backup of the dev database is `KaamConnect-before-scheduling-2026-10-11.dump`, kept in a `KaamConnect-db-backups` folder next to the repositories on the dev machine (outside both repositories; verified readable when taken). There is no production database yet, so nothing has been migrated anywhere else.

### 0.3 Tests (fresh runs today)

| Check | Result |
|---|---|
| Unit (`npm test`) | **299 passed, 0 failed**, 33 files (after Phase 7 Milestone A; 236 / 28 before) |
| End-to-end (`npm run test:e2e`, real PostgreSQL and WebSockets) | **718 passed, 0 failed, 0 skipped, 0 todo**, 26 files (after Milestone A; 579 / 21 before), run with coverage |
| Pending or failing tests | **None.** A search finds no `it.todo`, `it.skip` or `describe.skip` in `src/` or `test/`. The 22 Phase 5 `todo` entries became 27 real tests. Re-checked after Phase 6 with escaped patterns: 0 matches |
| Type-check, lint (oxlint), Prettier check, `npm run build`, `npm audit --omit=dev` | all clean; 0 vulnerabilities |
| Built-app smoke test (`scripts/smoke.sh`, through COMPLETED) | **Passed 2026-10-11 against the migrated dev database**, after I extended it with an arrival-code reset (new code issued, a second reset throttled with 429, the old code refused, arrival with the new code), a review (a second one refused with 409), the worker profile showing it, worker earnings and commission saved. Its data was then removed in one transaction that committed only because the table counts matched the snapshot taken before (reference data only), so dev is back to 0 users and 0 jobs. Three uploaded image files remain in the git-ignored `.local-storage/` folder. **Not yet run in CI** (it will run there on a fresh database once pushed) |
| Performance suite (`npm run test:perf`) | 7 / 7 pass functionally, last run earlier today; the comparison is pending (§0.6) |
| Mutation check | six breakages after Phase 5, all caught; **then** arrival reset: cap, cooldown and ownership removed one at a time, each caught (1, 3 and 2 failing tests); **then** Phase 6: review ownership, rating totals, IST offset, and the COMPLETED filter in earnings and in savings. Two of those (the COMPLETED filters) first **survived** because my fixtures never exercised them; I strengthened the fixtures and they are now caught. Every file was restored afterwards **Review follow-up (2026-10-11):** the new tests were mutation-checked too: earnings upper bound (`lt` to `lte`), auditing the lock on every refusal, removing the per-address throttle, also pushing the reset to the customer (each caught), the redraw loop count and the missing refusal explanation (unit tests), and, on the **test database only**, dropping the CHECK and turning each new foreign key into `ON DELETE CASCADE` (each caught; the constraints were then restored and their definitions compared with the originals: identical). Production code was not changed by the follow-up. |

### 0.4 Arrival-code recovery (built, migrated on dev, smoke-tested) and the SOS webhook (design proposed, undecided)

**Neither has been decided.** You have not answered either question, so nothing was changed.
- **Arrival-code recovery (K-27): approved by you on 2026-10-11 and built.** Limits 3 resets per assignment, 60 s apart. Behaviour and lockout consequences are in `03-api-spec.md §11.9` and `05-security-testing.md §10.1`: after the third reset only the customer cancelling or the worker backing out can free a locked job; a new assignment starts clean. You reviewed the migration and approved applying it to development only; it was applied and verified (§0.2). It has **not** been applied anywhere else, and there is no production database yet.
- **SOS webhook (K-28, Q-10): still undecided, and nothing was built. The agreed requirements are recorded in `05-security-testing.md §11`.** You have not chosen a receiver or named a 24/7 monitoring person, so none was invented and production SOS stays disabled (boot refuses without an https `SOS_WEBHOOK_URL`). A secure design was proposed in chat (signed requests, delivery table with retry and backoff, admin acknowledge, failure handling) for your review; it needs a migration and will be built only after you approve it and name the receiver.
- **Q-5 (worker backs out → re-open) and Q-10 (SOS recipient)** were built on their documented defaults because you asked for the documented requirements; they were not separately confirmed.

### 0.5 Git and GitHub CI

| | Fact (checked today) |
|---|---|
| Branch / HEAD | `main` at `d19c4fb`, the merge of PR #1 (2026-10-11 03:18:55 UTC). Before that merge it was `8d808e5` ("first commit"; two docs-only commits, 10 files) |
| Remote | `origin = https://github.com/ksingh3237/KaamConnectBackendAPI.git`. **`main` is `b33f5ec`** (merge of PR #3, 2026-10-11 10:14:55 UTC; before it `7e94da2`, the merge of PR #2): you merged PR #1 (`d19c4fb`), PR #2 and PR #3 yourself; I did not merge any. `main`'s content equals PR #2's final commit `2552314`. Branches on the remote: `main`, `feature/backend-phases-0-5` (`6665ea0`, merged), `feature/phase-6-and-arrival-recovery` (`2552314`, merged) and `feature/phase-7-milestone-a` (eight commits; **not merged; PR #3 is open**) |
| Commits on the branch | `7c4b8c4` scaffold, tooling and CI workflow; `ce817a7` schema, 3 migrations and seed; `84dc86f` backend phases 0–5 with tests; `fd3f6ce` docs. Working tree clean after the push. The reviewed file set contained no secrets (every value in the git-ignored `.env` was searched for in the committed files: 0 matches); a local path in this report was replaced with a generic description before the commit. Edits made after `fd3f6ce` (this report and the roadmap) are uncommitted until you ask |
| GitHub Actions | **Verified.** Run [38086756115](https://github.com/ksingh3237/KaamConnectBackendAPI/actions/runs/38086756115), event `pull_request`, head commit `fd3f6ce` (the last commit pushed), status completed, **conclusion success**, about 2 min 37 s. Read from the GitHub API, step by step: checkout, setup-node, `npm ci`, create test database, **btree_gist check**, lint, typecheck, unit tests, **e2e tests against the PostgreSQL 18 service container**, build, production audit, migrations on a fresh database, **drift check**, seed, **smoke test of the built app** — all succeeded. It is the only run so far (total_count 1) |
| Push-to-`main` run | **Verified.** Run [38107978974](https://github.com/ksingh3237/KaamConnectBackendAPI/actions/runs/38107978974), event `push`, branch `main`, head `d19c4fb`, status completed, **conclusion success**, 21 steps, none unsuccessful, about 2 min 52 s (read from the GitHub API). This closes the gap "the workflow has not run on a push to `main`" |
| What the runs settled | The `btree_gist` assumption (official `postgres:18` image, `POSTGRES_USER` superuser) is confirmed on GitHub twice. **Still not verified:** `btree_gist` creation by a non-superuser role on RDS |
| New work (branch `feature/phase-6-and-arrival-recovery`) | Created from `6665ea0`, five commits approved by you plus a sixth follow-up commit (`2552314`) after the code review. **Pull request #2 was merged into `main` by you on 2026-10-11 at 07:07:51 UTC (merge commit `7e94da2`; I did not merge it).** CI passed on the PR (run 38118304386, 17 steps) and on `main` (run 38120336005). `main`'s content equals the PR's final commit: it only added the two merge commits |
| Milestone A branch (`feature/phase-7-milestone-a`) | **Pushed 2026-10-11, no force push, a brand-new remote branch.** The first seven commits, oldest first: `9a32012` test: measure coverage and enforce the documented thresholds in CI; `d9cf7f8` feat: D-8 re-verification when a verified worker changes name or photo; `cab5e60` feat: masked logging and one log line per request; `c4ba0fb` fix: K-5 refuse disabled accounts on every protected route (403 ACCOUNT_DISABLED); `ac7c22a` fix: K-36 hide and refuse quotes of workers who are under review; `614d603` test: IDOR matrix over every route that takes an id in its path; `89a3964` docs: Phase 7 Milestone A. GitHub's own comparison with `main` at that point: 7 commits ahead, 2 behind (the two merge commits, which carry the same tree), 39 files. **You opened pull request [#3](https://github.com/ksingh3237/KaamConnectBackendAPI/pull/3) (base `main`, head `feature/phase-7-milestone-a`) at 09:05:39 UTC on 2026-10-11, 5 seconds before the CI run started.** Run [38127145264](https://github.com/ksingh3237/KaamConnectBackendAPI/actions/runs/38127145264): event `pull_request`, head `89a3964`, status completed, **conclusion success**, one job `verify`; steps 1–18 all `success`: set up job, initialise containers, checkout, setup-node, `npm ci`, create the test database, btree_gist check, lint, typecheck, unit tests, e2e tests (real PostgreSQL), **coverage thresholds**, build, production dependency audit, migrations on a fresh database, drift check, seed, smoke test of the built app (read through the GitHub API). PR #3 was open and not merged (`mergeable_state: clean`) when last read. The eighth commit, K-37, was pushed afterwards on your authorisation (PR #3, no new PR); do not merge until its run succeeds |

### 0.6 Pending verification: the idle-machine benchmark

Not done. Every run so far had Android Studio, an emulator, VS Code and Chrome open. **Original baseline** (single run after Phase 4, p95 in ms): `GET /workers` **94**, `GET /workers?categoryId=plumber&sort=rating` **24**, `GET /leads` **22**, `GET /customers/me/jobs` **7**, `POST /jobs` (fan-out to 244 workers) **52**, 20 simultaneous `GET /workers` about **1.0 s** wall, lead-feed SQL an index scan at 0.4 ms; budget 300 ms. Later runs (not idle): 90–104, 24–32, 26–34, 8–12 and 64–87 ms (§3.4). To close this: stop other applications, run `npm run test:perf` three times, compare with the baseline above, and investigate a reproducible difference. Measured costs of the new work in isolation: `GET /leads` about +2 ms, `POST /jobs` about +9 ms at p50.

### 0.7 Open requirements

| Item | State |
|---|---|
| **Service durations (D-14)** | Support is built and tested. **0 of 8 services have a value**, so every job is 90 minutes. Needs minutes per service from you; set with `PATCH /admin/service-categories/:id/duration` or `defaultDurationMin` in `prisma/data/service-categories.ts` plus a seed run |
| **Verified area coordinates (Q-18)** | **0 of 13 areas have coordinates.** Until they do (or the customer's address carries GPS) matching falls back to "same city", travel gaps assume 30 minutes, and tracking shows no distance or ETA (K-4, K-26) |
| D-8 name/photo change re-opens review | **built and pushed** (Milestone A, commit `d9cf7f8`); CI run 38127145264 on PR #3 passed on a later commit that contains it |
| D-9 Aadhaar deletion (7 days, configurable) | approved, **not built**; counsel has not confirmed the rule or whether Aadhaar images may be collected at all |
| Arrival-code recovery | **built, applied to dev and smoke-tested** (§0.4) |
| SOS receiver and monitoring process | **open**: no receiver selected, nobody named; production SOS not enabled |
| Real S3 bucket test (K-3), hosting (Q-15), MSG91/DLT (production cannot boot without an SMS sender) | open, Phase 7 |
| Frontend work (G-14 to G-20) | outside this repository |
| Reviews, tips, earnings, savings (Q-8) | **Phase 6 built and tested locally** (tips are record-only); merged in PR #2, CI passed (§0.5) |

### 0.8 Exact next steps

See §8 for the ordered list. In one line: **no technical blocker; the open items are the Milestone B approvals (§0.10) and the launch blockers B-1 to B-13 in `docs/09-production-readiness.md` §2.4**, which only you can supply or decide: hosting, the SMS provider and DLT, an SOS receiver and on-call person, S3, area coordinates, per-service minutes, an idle machine for the benchmark, and legal sign-off.

### 0.9 Phase 7, Milestone A (merged into `main` as PR #3; CI passed on the PR commits and on `main`)

| Item | Status | Evidence |
|---|---|---|
| Coverage measured and enforced (`9a32012`) | **Complete; pushed.** Merged lines: overall 97.5 % (2258/2315), auth 94.2 % (163/173), jobs 98.9 % (356/360), offers 98.0 % (249/254), reviews 97.3 % (36/37); branches overall 89.2 % (1378/1544); gates 70 / 85 on lines and 70 on branches enforced by `scripts/coverage-check.mjs` and a new CI step. The workflow YAML was parsed with a real parser (0 errors, 16 steps, every script it calls exists) but **has never run on GitHub** | `npm run test:cov`, `05-security-testing.md §12.1` |
| D-8 re-verification (`d9cf7f8`) | **Complete; pushed** | `verification-rules.ts`; 13 unit + 16 e2e tests; §12.2 |
| Masked request logging, K-10 (`cab5e60`) | **Complete; pushed** | `common/logging/*`; 28 unit tests (+2 in the exception-filter spec) and 6 e2e tests; §12.3 |
| IDOR matrix (`614d603`) | **Complete; pushed.** 100 tests, 34 routes classified, no ownership defect found | `test/idor-matrix.e2e-spec.ts`; §12.4 |
| `ProfileGuard` review | **Reviewed and rewritten; 20 unit tests.** Its two findings are fixed and pushed: K-5 (a disabled user kept working with a valid token) and K-36 (quotes of a worker under review stayed acceptable). A third finding, K-37, is fixed in the eighth commit (below); the guard now has 26 unit tests | §12.5, §12.7, §12.8 |
| K-5 fix: `403 ACCOUNT_DISABLED` (`c4ba0fb`) | **Complete; pushed.** One lookup per protected request; every route the router registers is probed with a disabled user's still-valid token (8 e2e tests); admin routes keep 404; `GET /me` now answers 403 instead of 401 (consistent, no change needed) | `profile.guard.ts`; §12.7 |
| K-36 fix: hidden and unacceptable quotes (`ac7c22a`) | **Complete; pushed.** One shared visibility rule in the list, three counts and the accept check; `409 OFFER_UNAVAILABLE` (9 e2e tests) | `offers/visible-offers.ts`; §12.7 |
| K-37 fix: a disabled account can log out (eighth commit) | **Complete; pushed to PR #3.** `@AllowDisabledAccount()` on `POST /auth/logout`; `ProfileGuard` skips only the `ACCOUNT_DISABLED` refusal for a marked route and ignores the marker when a profile or admin is required (fails closed). 6 guard unit tests, 6 e2e tests (5 logout scenarios and the exact exception list) | `allow-disabled-account.decorator.ts`, `profile.guard.ts`, `auth.controller.ts`; §12.8 |
| Totals of the eighth commit (working tree equal to the commit, not an isolated worktree) | **305 unit (33 files) and 724 e2e (26 files) passed in one `npm run test:cov` run, exit 0** (299 and 718 plus the 6 and 6 new tests); coverage gate passed: lines overall 97.5 % (2262/2319), auth 94.2 %, jobs 98.9 %, offers 98.0 %, reviews 97.3 %; branches overall 89.2 % (1382/1549); typecheck, build exit 0; lint exit 0 with `--deny-warnings`; prettier `--check` clean; `npm audit --omit=dev` 0 vulnerabilities | this session |
| Totals (seventh commit `89a3964`, in an isolated worktree) | **299 unit (33 files) and 718 e2e (26 files) passed in one `npm run test:cov` run, exit 0**; lines overall 97.5 % (2258/2315), branches 89.2 % (1378/1544); typecheck, prettier and build exit 0; lint 0 warnings; `npm audit --omit=dev` 0 vulnerabilities. The same figures were measured earlier on the working tree | this session |
| Not done | The idle-machine benchmark (the extra `ProfileGuard` lookup and the request logger are unmeasured); D-9, account deletion and everything in Milestones B onward | – |

**The first seven commits** (oldest first, on top of `2552314`): 1. `9a32012` test: measure coverage and enforce the documented thresholds in CI; 2. `d9cf7f8` feat: D-8 re-verification when a verified worker changes name or photo; 3. `cab5e60` feat: masked logging and one log line per request; 4. `c4ba0fb` fix: K-5 refuse disabled accounts on every protected route (403 ACCOUNT_DISABLED); 5. `ac7c22a` fix: K-36 hide and refuse quotes of workers who are under review; 6. `614d603` test: IDOR matrix over every route that takes an id in its path; 7. `89a3964` docs: Phase 7 Milestone A. Every commit has the co-author trailer; no commit touches a migration or `prisma/`.

**Verification before the push** (each commit checked on its own in a throwaway git worktree that shared `node_modules` through a junction; the worktree, its copied `.env` and the junction were removed afterwards and the real `node_modules` is intact). Each commit: typecheck, prettier, build exit 0 and lint 0 warnings.

| # | Commit | Unit tests | e2e tests run on that commit |
|---|---|---|---|
| 1 | `9a32012` coverage gates | 236 (28 files) | 27 (db-constraints, seed); `test:cov:unit` wrote its report; `coverage:check` without an e2e report exits 2 as designed |
| 2 | `d9cf7f8` D-8 | 249 (29) | 121 (D-8, workers, admin, discovery) |
| 3 | `cab5e60` masked logging | 279 (32) | 52 (request-logging, app, auth) |
| 4 | `c4ba0fb` K-5 | 299 (33) | 141 (account-disabled, auth, admin, realtime, catalog, customers) |
| 5 | `ac7c22a` K-36 | 299 (33) | 188 (quotes-under-review, leads-offers, jobs, direct-booking, scheduling) |
| 6 | `614d603` IDOR matrix | 299 (33) | 100 (idor-matrix) |
| 7 | `89a3964` docs, **full suite** | **299 (33)** | **718 (26 files), `npm run test:cov` exit 0, coverage gate passed** |

**On GitHub (checked through the public API after the push, then again before the eighth commit):** branch `feature/phase-7-milestone-a` existed at `89a3964`; the comparison with `main` was 7 ahead / 2 behind (merge commits only, same tree) with 39 files. When I first checked it right after the push, it had 0 pull requests and 0 workflow runs; **you then opened PR #3 and run 38127145264 succeeded on `89a3964`** (§0.5). The documents had still said "no PR, CI not run" until this commit; that was stale and is corrected here.

**K-37, reproduction (confirmed by an experiment that was not committed; before the fix):**
1. Log in as an active user and keep the access token and the refresh token.
2. Set `users.is_active = false` for that user in the database.
3. `POST /api/v1/auth/logout` with `Authorization: Bearer <access token>` and body `{"refreshToken":"<refresh token>"}`. Observed: **`403 ACCOUNT_DISABLED`** (expected for a logout: 204).
4. Look at the user's `refresh_tokens` rows: `revoked_at` is still NULL.
5. Set `users.is_active = true` again.
6. `POST /api/v1/auth/refresh` with the same refresh token. Observed: **`200` with a new token pair**, so the session the user tried to end is alive.

Baselines from the same experiment: an **active** user logging out gets 204, the row is revoked and a later refresh answers 401 (unchanged, secure). A refresh attempted while the account is disabled answers 403, **revokes** the token family, and a later refresh after re-enabling answers 401. `GET /me` for a disabled account answers `403 ACCOUNT_DISABLED` (was 401); that is consistent and needs no change.

**K-37, the fix (eighth commit, `fix: K-37 let a disabled account log out (revoke its own refresh tokens)`):** a metadata decorator `@AllowDisabledAccount()` (`common/decorators/allow-disabled-account.decorator.ts`) is on the logout handler, and `ProfileGuard` skips only the `ACCOUNT_DISABLED` refusal for a marked route. **One deviation from the plan above, on purpose:** the guard keeps its single primary-key lookup instead of skipping it, so a valid token for a user that no longer exists is still `401` (nothing about that behaviour changes). The marker fails closed: it is ignored on a route that also asks for a profile or admin rights. A valid access token is still required, and logout still revokes only a refresh family that belongs to the caller (`row.userId === userId` in `token.service.ts`), so it cannot widen anyone's access. After re-enabling, the old refresh token answers `401 REFRESH_REUSED`, which is how a revoked token answers after an active user's logout too (my plan said `REFRESH_INVALID`; the test showed the real, consistent code). Tests: 6 guard unit tests; 6 e2e tests in `account-disabled.e2e-spec.ts` (exact exception list `POST /auth/logout`; disabled logout 204 and revoked; only the named login revoked; another user's token not revoked; no or forged token 401; still 403 elsewhere afterwards). Mutation checks (§12.8): all caught. Docs updated: `03-api-spec.md §13` and the logout row in `§7`, `05-security-testing.md §12.5` and new `§12.8`, the roadmap, the READMEs and this report.


### 0.10 Phase 7, Milestone B (in progress; nothing deployed, no migration applied outside the test database)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Heavy-user benchmark with `EXPLAIN` checks (activity, earnings, savings, schedule) | **Committed and pushed** `531a3e6` | `test/perf/marketplace.perf-spec.ts`; 13 perf tests pass |
| 2 | Quote-count optimisation: customer list and lead feed count visible quotes for the page's jobs only | **Committed and pushed** `f45e03f`. Customer completed list p50/p95 68/134 and 62/164 ms -> 21/24 and 10/14; lead feed 64/201 and 66/174 -> 21/92 and 16/29 (old and new code alternated, two runs each, on a busy laptop) | 6 e2e + 4 unit tests, 3 mutation checks |
| 3 | The same for lead catch-up (a batch of up to 300 pushed leads) | **Committed and pushed** `8980e6b`. 58 leads claimed and pushed: p50/p95 122/149 and 122/180 ms -> 16/21 and 30/38 | 3 e2e tests, 3 mutation checks. Full suite 309 unit + 733 e2e |
| 4 | `DELETE /me` by anonymisation | **Final design written, not implemented** (`docs/08` §1): awaiting your answers on Door B, the job title and the migration, and counsel on retention | design only |
| 5 | D-9 `reviewed_at` / `reviewed_by` migration | **Drafted and tested; applied to the TEST database only.** On the local branch `feature/phase-7-d9-reviewed-at` (`a995d2c`), **not pushed**. Dev and production untouched | 9 tests, 3 mutation checks, rollback SQL validated in a rolled-back transaction; 309 unit + 742 e2e |
| 6 | Per-user rate limit (additive) | **Built on the local branch `feature/phase-7-per-user-throttling` (`ff8c18d`), not pushed.** Not merged anywhere | 8 unit + 8 e2e, 5 mutation checks; 317 unit + 741 e2e |
| 7 | OpenAPI export (`@nestjs/swagger`) | **Compatibility report only** (`docs/09` §3); nothing installed | `npm install --dry-run` |
| 8 | Production checklist, runbook, launch blockers register B-1 to B-13 | **Written** (`docs/09`, `docs/10`) | documents |

CI: none of these branches has had a GitHub run (a push alone does not start the workflow, and no pull request was
opened). Local results above are not CI results.
---

## 1. Phase status

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Scaffold, config validation, health, CI file | **Done** (CI run succeeded 2026-10-11, §0.5) | `src/main.ts`, `src/config/`, `src/health/`, `.github/workflows/ci.yml` |
| 1 | Schema (19 tables), baseline migration, reference seed, catalog API | **Done** | `prisma/`, `src/modules/catalog/` |
| 2 | Phone-OTP login, JWT + rotating refresh tokens, `/me`, global login guard | **Done** (MSG91/WhatsApp deliberately not built) | `src/modules/auth/`, `users/` |
| 3 | Customer + worker profiles, address book, signed uploads, admin verification, worker GPS ping | **Done** (S3 not exercised on real AWS, see §4) | `src/modules/{customers,workers,media,admin}/` |
| 4 | Jobs, worker discovery, leads, quotes, direct booking, Socket.IO push | **Done** (see §3 for exactly what; Idempotency-Key and search `q` deferred) | `src/modules/{jobs,offers,matching,realtime}/`, `workers/discovery/` |
| 4b | **Scheduling and availability** (requested 2026-10-10, decisions D-11 to D-14 approved 2026-10-11): `scheduledFor`, booking windows, overlap + travel-gap checks, one in progress + many future bookings, lead accept/decline, `worker_leads` duplicate guard, future-work radius (opt-in), location catch-up, worker calendar, per-service default job length | **Done and applied** to the test and the dev database. **Not covered:** the Phase 5 endpoints that start and finish work, and a worker backing out (K-22) | `src/modules/scheduling/`, `offers/lead-catch-up.service.ts`, migrations `20261010180000_scheduling_and_availability` and `20261011090000_category_default_duration`, `test/scheduling.e2e-spec.ts`; contract in `03-api-spec.md §10` |
| 5 | **Fulfilment** (go-ahead 2026-10-11): arrival (5-try lock, one job on site at a time), itemised bill with customer approval of the total shown, before/after photos, completion, payment (idempotent) and receipt, live tracking (`job.location`, socket `location:update`), SOS with a pluggable safety channel, `GET /workers/me/jobs`, ownership-based access (D-8), `workerFreed`, worker back-out with booking clean-up and a re-open that re-notifies workers, per-service duration setting (admin) | **Done and verified by tests** (534 e2e, 221 unit, built-app smoke test through COMPLETED). **CI verified** (§0.5). **Not verified:** idle-machine benchmark. **Not built:** see §3.2 | `src/modules/{fulfilment,safety}/`, `jobs/worker-backout.service.ts`, `test/{phase5-requirements,fulfilment}.e2e-spec.ts`; contract `03-api-spec.md §11` |
| 5b | **Arrival-code recovery** (approved 2026-10-11): customer-issued new code, 3 per assignment, 60 s cooldown, audit trail, `job.arrival_code_reset` | **Built, tested locally; migration applied to dev; smoke-tested in the built app.** Merged in PR #2; CI passed (§0.5) | `modules/fulfilment/arrival-code-reset.service.ts`, migration `20261011150000_arrival_code_reset`, `test/arrival-code-reset.e2e-spec.ts`; contract `03-api-spec.md §11.9` |
| 6 | **Reviews, activity extras, earnings, savings** (go-ahead 2026-10-11) | **Done and verified by tests locally** (579 e2e, 236 unit, build, lint, types, audit, no schema drift). **Merged in PR #2; CI passed (§0.5).** No migration needed | `src/modules/{reviews,earnings}/`, `test/phase6.e2e-spec.ts`; contract `03-api-spec.md §12` |
| 7 | Hardening and release | **Milestone A merged into `main` (PR #3, `b33f5ec`); CI passed: run 38127145264 on the seventh commit, 38129422267 on the eighth (K-37), 38131265301 on `main`. Milestone B in progress (§0.10)** (coverage gates, D-8, masked logging, IDOR matrix, `ProfileGuard`, K-5, K-36, K-37): see §0.9. Milestones B onward not started | see §7 |
| 8 | Optional (MSG91, Redis, push, PDF, admin UI) | Not started | |

Roadmap estimate for the remaining work (`docs/07-roadmap.md`): Phase 5 7–8 d, Phase 6 3–4 d (done), Phase 7 4–5 d.

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

### 3.1 Routes that exist (64 handlers counted from the controllers; all under `/api/v1` except health)
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
| Fulfilment | `POST /jobs/:id/arrival`, `PUT /jobs/:id/bill-items`, `GET /jobs/:id/bill`, `POST /jobs/:id/bill/approve`, `POST /jobs/:id/work-photos`, `POST /jobs/:id/complete-work`, `POST /jobs/:id/payment`, `GET /jobs/:id/receipt`, `GET /jobs/:id/tracking`, `GET /workers/me/jobs`, **`POST /jobs/:id/arrival-code/reset`** |
| Safety | `POST /jobs/:id/sos` |
| Reviews and money views (Phase 6) | `POST /jobs/:id/review`, `GET /workers/me/earnings`, `GET /me/savings`; `GET /workers/:id` now also returns the review summary |
| Admin | `GET /admin/workers`, `POST /admin/workers/:id/verify`, `POST /admin/workers/:id/reject`, `PATCH /admin/service-categories/:id/duration` |
| Dev only | `PUT/GET /dev-storage/:bucket/*key` (signed; 404 when S3 is configured; refused in production) |
| Socket.IO | namespace `/realtime`: `job:watch`, `job:unwatch`, `location:update` in (the last only for your own job on the way); events out are listed in `03-api-spec.md §9.6, §10.7, §11.5` |

### 3.2 Specified in `docs/03-api-spec.md` but **not built**
- `POST /jobs/:id/payment/confirm` (the worker confirms receipt; P3, no UI), `PATCH /admin/sos/:id` and the `sos.acknowledged` event (nobody can acknowledge an alert in the system yet; the desk acts outside it), PDF receipts (JSON only).
- `GET /config`; push notifications for offline users; `DELETE /me`; `Idempotency-Key`; free-text search `q`. **Phase 6 routes are built** (reviews, earnings, savings). Not built within Phase 6: editing or deleting a review, admin moderation of reviews, a worker-side list of their own reviews, tips in earnings.
- Rescheduling an existing booking; routing-based travel times; showing the per-service default duration to the app.

### 3.3 Quality gates (run 2026-10-11)
| Check | Result |
|---|---|
| `npm run lint` (oxlint) | 0 warnings, 0 errors |
| `npm run typecheck` | clean |
| `npm test` (unit) | **299 / 299** pass, 33 files (Milestone A added 63) |
| `npm run test:e2e` (real PostgreSQL `KaamConnect_test`, real WebSockets) | **718 / 718** pass, 26 files (Milestone A added 139) |
| `npm run test:perf` (5,000 workers, 50,000 jobs) | 7 / 7 pass **functionally**. The idle-machine comparison is still **pending** (§3.4) |
| `npm run build` | clean |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (incl. dev) | 4 high, all dev-only (`deepmerge-ts`, `mysql2` pulled in by the Prisma CLI) |
| Drift check, migrated **test** database vs `schema.prisma` (`prisma migrate diff`) | **no difference** (the new exclusion constraint, partial indexes and CHECKs are invisible to Prisma, as before) |
| Mutation check of the new tests | I broke the code on purpose in six ways and ran the matching tests: back-out not resetting the lead guard, back-out leaving the booking window, completion not freeing the worker, completion ignoring job ownership, worker routes demanding verification again, a backed-out worker able to quote again | **all six were caught** (each by the intended test); the code was restored and re-checked |
| `prisma migrate status` and drift check on **dev** `KaamConnect` | **4 migrations applied, up to date, no drift** (2026-10-11, after applying `arrival_code_reset` and again after the smoke test); the new objects exist as written; reference data unchanged (8 / 3 / 13); 0 users, 0 jobs |
| `bash scripts/smoke.sh` on the built app against the dev DB | **passed 2026-10-11 on the migrated database** with the script extended through Phase 6: login -> live lead -> quote -> accept -> wrong code refused -> **customer issues a new code, second reset throttled, old code refused** -> arrive with the new code -> bill -> stale approval refused -> approve -> finish -> pay -> receipt -> COMPLETED -> **review (second refused), worker profile shows it, earnings, commission saved**. The database then showed the `ARRIVAL_CODE_RESET` and `ARRIVAL_RESET_REFUSED` audit rows with the customer as actor and the IP recorded. Its data was removed afterwards (§0.3) |

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
| Schema | **4 migrations applied** (baseline, `scheduling_and_availability`, `category_default_duration`, `arrival_code_reset`), 21 tables + `_prisma_migrations`; the fourth applied 2026-10-11 after a verified backup | **4 applied**, 21 tables; no drift against `schema.prisma` (checked 2026-10-11) |
| Data | (no Phase 5 migration; the schema is unchanged) 8 categories, 3 cities, 13 areas, **0 users, 0 jobs**; **0 areas have coordinates** | emptied and re-seeded on every e2e run; the perf test leaves 5,000 workers + 50,000 jobs until the next e2e run |

### 3.6 Repository and CI
- Branch `main`; two commits (**docs and README only**). Remote `origin` = `github.com/ksingh3237/KaamConnectBackendAPI` configured.
- **Everything from Phases 0–5 is committed, pushed and merged into `main`** (PR #1, merge commit `d19c4fb`, 2026-10-11 03:18:55 UTC). `docs/proposed-schema.prisma` was deleted in the docs commit (duplicate of `prisma/schema.prisma`).
- **CI (`.github/workflows/ci.yml`) ran on GitHub twice and passed both times:** run 38086756115 (pull request, commit `fd3f6ce`, 17 steps) and run 38107978974 (push to `main`, merge commit `d19c4fb`, 21 steps). It includes the `btree_gist` availability step, which passed. Neither run covered the arrival-recovery or Phase 6 work.
- `.env` and `.local-storage/` are git-ignored. Your `.env` has `WORKER_VERIFICATION_MODE=auto` (so the smoke script works locally); it lacks the newer optional keys (defaults apply).

---

## 4. Pending tasks and known issues

### 4.1 Known errors
**None failing.** All checks above are green.

### 4.2 Known limitations and risks (verified)
| # | Item | Impact | Action |
|---|---|---|---|
| ~~K-1~~ | **Resolved 2026-10-11:** Phases 0–5 are committed, pushed and merged into `main` (PR #1) | – | – |
| ~~K-2~~ | **Resolved 2026-10-11:** the CI workflow ran on GitHub and succeeded (run 38086756115) | – | – |
| K-3 | `S3StorageService` has never talked to a real bucket | Production uploads unproven (unit tests prove the signature covers type and size) | Needs an AWS bucket (Q-15, Q-21) |
| K-4 | Area centroids are null | Matching uses the same-city fallback: a worker with a 3 km radius still gets every job in their city, and `distanceKm` is `null` everywhere. The radius rule is built and tested but dormant | Q-18 |
| ~~K-5~~ | **Fixed (Phase 7, Milestone A, `c4ba0fb`, pushed; inside the code CI run 38127145264 passed):** `ProfileGuard` refuses a disabled account on every protected route with `403 ACCOUNT_DISABLED`, using one lookup per request (it was confirmed that a disabled user with an unexpired token could create jobs). `GET /me` now says 403 instead of 401. The one consequence, K-37, is fixed in the eighth commit | – | – |
| K-6 | Two parallel `/auth/refresh` calls with the same token end the login | A naive mobile client logs users out | Frontend must single-flight refresh |
| ~~K-7~~ | **Reviewed 2026-10-11:** `ProfileGuard` does one primary-key lookup per guarded request, reading only the key or the status; the freshness is deliberate (D-8 takes effect on the next call). 20 unit tests. No change | – | – |
| ~~K-8~~ | `PUT /workers/me/location` is still accepted from any verified worker (they send it for lead matching) and now also from a worker in review **only while a job is assigned to them**; the job's live position is rebroadcast as `job.location`. **Resolved in the sense that matters:** pings are tied to a job for tracking | – | – |
| K-9 | Dev OTP is printed to the log (console sender); `OTP_DEV_BYPASS=true` makes it `123456` | Dev only; both refused in production | None |
| ~~K-10~~ | **Resolved (Milestone A, `cab5e60`, pushed):** request logging with masking, and a masking logger for every log line | – | – |
| ~~K-36~~ | **Fixed (Phase 7, Milestone A, `ac7c22a`, pushed; inside the code CI run 38127145264 passed):** pending quotes of a worker who is not VERIFIED are hidden from the list and from every quote count and cannot be accepted (`409 OFFER_UNAVAILABLE`); an accepted quote is never affected | – | – |
| ~~K-37~~ | **Fixed (Phase 7, Milestone A, commit `755b97a`, merged in PR #3; CI run 38129422267 passed on it).** `POST /auth/logout` had been refused for a disabled account (a consequence of K-5), so the session's refresh tokens stayed unrevoked and still worked after re-enabling. Now `@AllowDisabledAccount()` lets that one route through: 204, the caller's refresh family is revoked, and the old token answers 401 after re-enabling. Reproduction before the fix, the design and the tests: §0.9, `05-security-testing.md §12.8` | – | – |
| K-11 | e2e suite empties `KaamConnect_test` on every run and needs a local PostgreSQL | CI needs a DB service | By design; the harness refuses any non-`*_test` DB |
| K-12 | Cosmetic: `customers.service.ts:191` has a stray `export type { UpdateAddressDto }` and a matching unused import | None | Left untouched |
| K-13 | PgBouncer in transaction mode would drop the UTC session pin unless `options` startup parameters are allowed | Wrong stored timestamps | Documented in `02-database.md §8` |
| **K-14** | **`pg` prints "Calling client.query() when the client is already executing a query is deprecated" during some transactions.** The stack is inside Prisma's runtime and `@prisma/adapter-pg` (not our code) | Becomes an error in `pg@9` | Keep `pg` on 8.x; re-check on each Prisma update |
| **K-15** | Discovery and notification filtering run in application code: about 40–60 ms CPU per request at 5,000 workers; 20 simultaneous calls take about 1 s | One server handles roughly 20 such requests/s (extrapolated) | Fine for launch; first thing to move into SQL / cache (the Redis seam) if traffic grows |
| **K-16** | Safety caps: 20,000 workers per discovery/notification request (logs a warning if reached); the lead feed looks at the newest 500 open jobs of a worker's trades | Incomplete results beyond those sizes (not realistic for one metro) | Documented; revisit with PostGIS/SQL filtering |
| ~~K-21~~ | **Resolved 2026-10-11.** The scheduling migrations were applied to the dev database after a backup. **Backup:** `KaamConnect-before-scheduling-2026-10-11.dump` in a `KaamConnect-db-backups` folder next to the repositories on the dev machine (pg_dump custom format, 20 tables, verified readable with `pg_restore --list`; stored outside both repositories). **Restore if ever needed:** drop and recreate `KaamConnect`, then `pg_restore -d KaamConnect <file>`. **Irreversible parts, for the record:** adding the `SCHEDULED` value to the `JobTiming` enum cannot be undone in PostgreSQL without rebuilding the type, and the `btree_gist` extension stays installed. Nothing was dropped or deleted; the only data statement is a back-fill that touched 0 rows (no jobs existed) | – | – |
| ~~K-22~~ | **Resolved in Phase 5** for everything the scheduling work depended on: arrival, completion, payment, tracking and SOS now exist; `workerFreed` is called at completion, back-out and customer cancel; back-out clears the booking and re-notifies workers; routes are gated by ownership. Each is covered by a test in `phase5-requirements.e2e-spec.ts`. **Still app-dependent:** the refresh only helps if the phone answers `location.refresh` with a fix and the person allowed location | – | – |
| **K-26** | Distances and ETAs in tracking are `null` until real coordinates exist: the 13 areas have none (Q-18) and the customer app does not yet send GPS with the address. Tracking says so (`distanceBasis: null`) instead of guessing | The map screen shows the worker's dot but no "1.1 km away" until Q-18 is done | Q-18 |
| ~~K-27~~ | **Resolved (built) 2026-10-11:** a customer can issue a new arrival code (3 per assignment, 60 s apart; audited). Remaining consequence: after the third reset only cancel / back-out free a locked job. The dev migration is applied and verified | – | – |
| **K-28** | SOS: the alert is stored and sent to one webhook (5 s timeout, no retry). No acknowledge/resolve endpoint and no `sos.acknowledged` event. **Production now refuses to boot without `SOS_WEBHOOK_URL`** (https), like the other safety guards | An unreachable desk is only visible in the logs; alerts stay `OPEN` forever | Phase 7: retry/queue + admin acknowledge; set `SOS_WEBHOOK_URL` before launch |
| **K-29** | Payment is the customer's own statement; the platform neither moves nor verifies money (BR-2). The worker-confirm path (`POST /jobs/:id/payment/confirm`) is not built | A dishonest "Paid" is possible | R-7; add the confirm path if disputes appear |
| **K-30** | `GET /workers/me/jobs` lists unanswered quotes (`pendingQuotes`) outside the paging, capped at 50 | A worker with more than 50 waiting quotes sees the 50 newest | Fine for launch |
| ~~K-31~~ | **Resolved 2026-10-11:** the CI run passed, including the `btree_gist` step | – | – |
| **K-32** | A review is final: no edit, delete or admin moderation; no free-text comment exists | A mistaken or abusive rating cannot be removed through the API | Add an admin removal route if it becomes a problem (it would also need to adjust the worker's totals) |
| **K-33** | Earnings are attributed to the time the payment was recorded (`completed_at`), and "paid" is the customer's own statement (K-29) | A dishonest "Paid" counts as earned | Same as K-29 |
| **K-34** | "Commission saved" is a comparison with a competitor rate (default 20 %), not money the platform holds | Misleading if shown without the rate | The API returns `benchmarkRate`; the app must disclose it (D-5) |
| **K-35** | The arrival-reset audit table has no read endpoint and the lock event is best-effort (a failed audit write is logged, not retried) | Support must query the database | Add an admin read route in Phase 7 |
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
| ~~Coverage gates~~ | `05-security-testing.md` | **built and pushed (Milestone A); CI run 38127145264 passed** |
| k6 / autocannon load test beyond the in-repo benchmark | roadmap Phase 7 | 7 |
| Dockerfile / Procfile, staging deployment | roadmap Phase 7 | 7 (needs hosting decision) |
| ~~`LoggingInterceptor` with phone masking~~ | `04-architecture.md` | **built and pushed (Milestone A); CI run 38127145264 passed** as middleware plus a masking logger, so that guard refusals are logged too |
| `Idempotency-Key` | `03-api-spec.md §1` | See K-17 |
| `CacheService` and Redis seams | `04-architecture.md §7` | 8 |
| MSG91 sender, WhatsApp OTP | D-2 | 8 (blocked on DLT) |
| `DELETE /me` | Q-17 | 7 |
| Aadhaar image retention job (`AADHAAR_RETENTION_DAYS`, default 7; S3 lifecycle cap; probable `reviewed_at` migration, ask first) | D-9 (was Q-20) | 7 |
| ~~Name or photo change on a VERIFIED worker re-opens review~~ (normalised name compare, different `photoKey`, both modes) | D-8 (was Q-19) | **built and pushed (Milestone A); CI run 38127145264 passed** |

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
| Q-8 | Tips | record-only (**built**: `tipAmount` is stored on the review, never added to a payment or to earnings) | nothing |
| Q-10 | SOS recipient / emergency contact | a webhook you configure (`SOS_WEBHOOK_URL`). **Built on this default**, not separately confirmed. No emergency-contact field exists | You must set the webhook before production |
| Q-11 | 13 vs 19 areas | 13 built, 6 behind a flag | nothing |
| Q-12 | `[6-9]` mobile prefix | yes (built) | nothing |
| Q-14 | Prisma 7.10 rather than 8 RC | yes (pinned) | nothing |
| Q-15 | Hosting / storage provider | AWS S3 + RDS | **Phase 7** and the first real S3 test |
| Q-16 | Show worker phone to logged-in customers | yes (**implemented** on cards, offers, assigned view) | nothing |
| Q-17 | Account deletion | yes, Phase 7 | Phase 7 |
| ~~Q-19~~ | **Answered 2026-10-10 → D-8:** a normalised name change on a VERIFIED worker returns the profile to PENDING (both modes). **Built and pushed (Phase 7, Milestone A); CI run 38127145264 passed** | n/a | Shapes Phase 5: job-acting routes must gate on job ownership, not VERIFIED |
| ~~Q-20~~ | **Answered 2026-10-10 → D-9:** delete Aadhaar images 7 days after the decision (configurable). **Not built yet**, so images are still kept indefinitely | n/a | Phase 7; legal sign-off on collecting Aadhaar images still open |
| ~~Q-21~~ | **Answered 2026-10-10 → D-10:** `ap-south-1` (Mumbai) | n/a | First real S3 test (K-3) / Phase 7 |
| ~~Q-22~~ | **Answered 2026-10-10 → yes**, folded into D-8: a different `photoKey` on a VERIFIED worker also returns the profile to PENDING (removing the photo does not). **Built and pushed (Phase 7, Milestone A); CI run 38127145264 passed** | n/a | Same small change as D-8 |

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

**Where things stand (2026-10-11).** Milestone A is merged into `main` (PR #3, `b33f5ec`; CI passed on `main`). Milestone B is in progress (§0.10): its pushed branch is `feature/phase-7-milestone-b`; two more changes sit on local-only branches until you approve them.

**Next, in this order:**
1. **You review** the Milestone B work and answer the pending decisions listed in the last report: the `DELETE /me` design (`docs/08` §1.9), applying the D-9 migration to the development database (`docs/08` §2.6, with a verified backup first), merging the per-user throttle (`docs/09` §1.4), and `@nestjs/swagger` (`docs/09` §3).
2. **You open a pull request** for the Milestone B branch when you want CI to run on it (I do not create or merge pull requests); I then read the run through the public API.
3. The launch blockers B-1 to B-13 (`docs/09` §2.4) are tracked there; most need you or a third party.

**Standing limits (until you lift them):** do not merge a PR; do not modify `main`; do not start Phase 8; do not apply a migration you have not approved (the only one applied outside the test database is none); no deploy; no force push; SOS delivery, real S3, MSG91, the 13 area coordinates, per-service durations and the idle-machine benchmark stay pending; the 90-minute default stays.

**Older items, still open:**

**Phase 6 is built and tested** (2026-10-11, after your explicit go-ahead). **CI passed on its pull request and on `main` after the merge** (§0.5).

**Open, in the order I suggest:**
1. ~~Docs commit (the CI-result edit only)~~ **Done:** commit `6665ea0` was pushed to `feature/backend-phases-0-5` after PR #1 had already been merged, and reached `main` through PR #2.
2. ~~Review and apply the migration to dev~~ **Done 2026-10-11** (backup, `migrate deploy`, status, drift, extended smoke test; §0.2, §0.3).
3. ~~Commit and push the new work~~ **Approved and done as five commits on `feature/phase-6-and-arrival-recovery`; PR #2 into `main` was merged by you (2026-10-11 07:07:51 UTC).** A sixth commit followed the code review (documentation corrections, a schema comment and 11 more tests). **CI was read from GitHub: passed (§0.5).**
4. **Benchmark on an idle machine** three times against the baseline in §0.6.
5. **SOS:** name a receiver and a 24/7 monitoring person, then approve the delivery design; nothing is enabled until then.
6. **Supply per-service minutes** (90 stays the default) and **verified area coordinates** (13 pending; none invented).

**Approved earlier but still not built:** D-9 (Aadhaar deletion, probably one small migration, which I would ask about first). D-8 was built in Milestone A.

**Phase 7 carry-overs:** SOS retry/acknowledge, worker payment confirmation if disputes appear, a nightly run of the contention tests, the first real S3 test, MSG91, the legal items. (The IDOR matrix extension was done in Milestone A.)

**Not part of the next step:** MSG91, Redis, and any change to the mobile app.

---

## 9. How this report was verified (2026-10-11 for the scheduling work; the rest 2026-10-10)

| What | Command / source | Result |
|---|---|---|
| Source layout and routes | `find src`, grep of route decorators in `*.controller.ts` | 64 handlers (was 60 after Phase 5, 45 after Phase 4); `jobs`, `offers`, `matching`, `realtime` modules exist; no bill / payment / tracking code |
| Quality gates | `npm run lint`, `typecheck`, `test`, `test:e2e`, `test:perf`, `build`, `npm audit` | see §3.3 |
| Test counts | `npm test`, `npm run test:e2e` | unit 299 (33 files), e2e 718 (26 files); before Phase 6: 221 + 534; before Phase 5: 198 + 473 |
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
| Not verified | Performance on a truly idle machine, `btree_gist` creation by a non-superuser role on RDS (CI is now verified, see the next row) | see §3.4, `02-database.md §5` |
| Phase 5 first run | wrote the real suite, ran it | 25 of 27 passed; the 2 failures were mistakes in my test set-up (a worker cannot take two overlapping immediate jobs, which is the scheduling rule working), fixed; then 27 + 34 pass |
| Phase 5 CI step | parsed the workflow with js-yaml; ran the step's shell against local PostgreSQL 18 with the extension present and with it renamed to a missing one | exit 0 and exit 1 with the intended message. **GitHub itself has not run it** |
| CI runs (2026-10-11) | GitHub API: `/actions/runs` and `/actions/runs/<id>/jobs` for both runs | run 38086756115 (PR #1, `fd3f6ce`, 17/17 steps) and run 38107978974 (push to `main`, `d19c4fb`, 21 steps, none unsuccessful): both conclusion success (§0.5) |
| Git state check (2026-10-11) | `git ls-remote`, `git fetch`, `git log origin/main`, the pulls API | PR #1 merged 03:18:55 UTC (merge commit `d19c4fb`); `origin/main` differs from `feature/backend-phases-0-5` only by docs commit `6665ea0` |
| Not verified | Performance on an idle machine, `btree_gist` creation by a non-superuser role on RDS, `SOS_WEBHOOK_URL` against a real receiver (the webhook client is unit-tested against a mocked `fetch`) | §3.4, K-28 |
| Re-verification at the end of Phase 5 (2026-10-11; superseded by the rows below) | `git status/log/ls-remote`; public GitHub Actions API; `prisma migrate status` + `migrate diff` on dev and test; read-only SQL on both databases; grep of controllers and tests; `tsc`, `oxlint`, Prettier, `npm test`, `npm run test:e2e`, `npm run build`, `npm audit --omit=dev` | §0: 221 unit and 534 e2e pass with none skipped; no drift; 0 workflow runs; remote = docs-only commit |
| Corrected | I had written "2026-10-12" for the Phase 5 work; the system date is 2026-10-11, so every such date in the docs was corrected | – |

| Arrival-code recovery and Phase 6 (2026-10-11) | `npm run typecheck`, `lint`, `prettier --check`, `npm test`, `npm run test:e2e` (full, re-run after the branch was created), `npm run build`, `npm audit --omit=dev`, `prisma migrate diff` against the migrated test database | all clean: 236 unit, 579 e2e (after the review follow-up), 0 vulnerabilities, no drift on test |
| Dev migration and smoke test (2026-10-11) | read-only check of the connection (host, database name, `NODE_ENV`, 3 migrations, 0 users and 0 jobs); `pg_dump` custom format, then `pg_restore --list`; `npm run db:migrate`; `migrate status`, `migrate diff`, catalog queries; `npm run build`; `bash scripts/smoke.sh`; row counts of every table before and after; one transaction removing only the smoke data, committed only if counts equalled the snapshot | backup 63,124 bytes and readable; migration applied cleanly; up to date, no drift; smoke test passed; cleanup matched the snapshot (reference data only) |
| Mutation checks (2026-10-11) | broke the code on purpose and ran the matching tests: reset cap, cooldown, ownership; review ownership, rating totals, IST offset, COMPLETED filters (earnings, savings) | all caught; two survived at first because the fixtures never exercised the filter, fixtures were strengthened, then caught; every file restored Follow-up: 4 e2e mutations, 2 unit mutations and 3 test-database constraint mutations, all caught and all restored. |
| Milestone A push (2026-10-11) | seven commits created with explicit file lists; each verified in an isolated worktree; full `npm run test:cov` on the final commit; `git push -u origin` of a brand-new branch (no force); then GitHub API calls for the branch, the comparison with `main`, pull requests and workflow runs | tip `89a3964` on the remote; 7 ahead / 2 behind (merge commits, same tree); **0 PRs, 0 workflow runs at that moment** (you opened PR #3 minutes later and run 38127145264 succeeded, as read through the API at the start of the K-37 session) |
| K-37 fix (2026-10-11, eighth commit) | the new guard and e2e tests first (one wrong expectation of mine corrected: `REFRESH_REUSED`, not `REFRESH_INVALID`); then 4 mutations, each made and restored (guard ignoring the marker; decorator removed from logout; marker honoured on every route; marker honoured even with a profile or admin requirement), restore checked byte for byte; then `npm run test:cov`, `typecheck`, `oxlint --deny-warnings`, `prettier --check`, `npm run build`, `npm audit --omit=dev` | all four mutations caught; all gates green: 305 unit, 724 e2e |
| K-37 experiment (2026-10-11, not committed) | a temporary e2e spec: logout for an active user and for a disabled user, re-enable, refresh; refresh while disabled; `GET /me` for a disabled user | results in §0.9; the temporary file was deleted |
| Not verified (2026-10-11) | **CI on the Milestone B branches (no pull request, so no run)**, the idle-machine benchmark, real SOS delivery, real S3, `btree_gist` as a non-superuser on RDS | pending, see §0 |