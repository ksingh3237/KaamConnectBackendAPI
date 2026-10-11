# 11 · Milestone B pull request plan and checklist

Status: **a plan. No pull request has been opened by me and none will be merged by me.** GitHub CI has not run on any
Milestone B branch, because a plain push does not start the workflow; the results quoted here are local. Decisions of
2026-10-11 are built in: the follow-up documents are **folded into PR-1** (there is no separate documents PR), the per-user
limit waits for PR-1, the D-9 migration waits for its own approvals, and OpenAPI export is deferred.

## 1. Order

| # | Pull request | Head branch -> base | Contains | Waits for |
|---|---|---|---|---|
| **PR-1** | Performance work and Milestone B documents | `feature/phase-7-milestone-b` -> `main` | The quote-count optimisation (customer list, lead feed, lead catch-up), the heavy-user benchmark, and the Milestone B documents (`08` to `11`, status, roadmap). **No migration, no new setting, no dependency, no response change.** Commits: `531a3e6`, `f45e03f`, `767588d`, `8980e6b`, `19a0180`, `d83db84` (pushed) plus the documentation fold-in commits listed in the report of 2026-10-11 | Your review of the folded-in diff, then you open it |
| **PR-2** | Per-user rate limit | `feature/phase-7-per-user-throttling` -> `main` | One commit `9567f78`: guard, optional setting `USER_RATE_LIMIT_PER_MIN` (default 240), SOS exemption, tests, section 1.4 of `09`. Already pushed | **PR-1 merging** (so it shows only its own commit); then we prepare and verify it together |
| **PR-3** | D-9 decision audit migration | `feature/phase-7-d9-reviewed-at` -> `main` | One commit `ed7ccf8`: migration `20261011200000_worker_review_audit`, schema, 9 tests. **Adds a migration** | Your separate approvals, in this order: push, merge, apply to dev (`08` §2.11) |
| later | `DELETE /me` with its migrations; the D-9 sweep; shared-address Stage 1 (configurable limits); OpenAPI export | not started | | Each needs its own approval; OpenAPI is parked (`09` §3.6) |

Why this order: PR-1 changes behaviour least and unblocks the rest; PR-2 is stacked on it; PR-3 is the only one that touches the
database, so it goes alone and last.

## 2. Checks every pull request must pass

**CI (the workflow's 18 steps; I read the run for the exact head commit through the public API and report each step):**
checkout, setup-node, `npm ci`, create the test database, the `btree_gist` check, lint, typecheck, unit tests with coverage,
e2e tests against PostgreSQL 18 with coverage, **coverage thresholds** (lines: 85 % for auth, jobs, offers and reviews and
70 % overall; branches: 70 % overall), build, production dependency audit, migrations on a fresh database, **migration drift
check**, seed, smoke test of the built app.

**Local results already obtained (not CI results):**

| Branch | Unit | e2e | Other |
|---|---|---|---|
| `feature/phase-7-milestone-b` (code at `8980e6b`; later commits are documents) | 309 | 733 | typecheck, lint (`--deny-warnings`), prettier, build, `npm audit --omit=dev` clean; perf suite 13/13 |
| `feature/phase-7-per-user-throttling` | 317 | 741 | same gates; 8 + 8 new tests; 5 mutation checks |
| `feature/phase-7-d9-reviewed-at` | 309 | 742 | same gates; 9 new tests; 3 mutation checks; fresh-schema run and timing (`08` §2.10) |

**Before you merge any of them:** the CI run is green on the exact head commit; the file list is what this plan says; no
unrelated file or secret is in the diff; the base is `main`.

## 3. PR-1 checklist

- [ ] **Behaviour preserved.** Quote counts are the same numbers by the same visibility rule (K-36) in the customer list, the
      lead feed, a single lead and the catch-up push. Evidence: `offer-counts.e2e-spec.ts` (6),
      `lead-catch-up-counts.e2e-spec.ts` (3), `visible-offers.spec.ts` (4), the existing K-36 and lead specs; six mutation
      checks, each of which made a test fail.
- [ ] **Single-job reads untouched** (`jobInclude` keeps the count; measured at 0.1 ms).
- [ ] **No change to authorization, pagination or response fields.** `leadPayloadOf` gained one argument, passed from the same
      value as before at the two single-job call sites.
- [ ] **The benchmark only touches test databases** (its harness refuses any other).
- [ ] **No migration, setting or dependency change** (`git diff --stat origin/main` shows none of `prisma/`, `package.json`,
      `package-lock.json`, `.env.example`, `src/config`).
- [x] **Cross-references fixed in the fold-in:** `09` no longer points at a section 1.4 that only exists on the throttling
      branch (it now points at the branch and at the review in 1.5); the status documents describe the throttling branch as
      pushed and the D-9 branch as local.
- [x] **Decisions recorded:** Door B outcome mechanism options with the SMS dependency stated, current throttling limits
      unchanged, OpenAPI deferred, blockers B-13 to B-16.
- [ ] Performance numbers in the commit messages come from a busy laptop with old and new code alternated; they show a ratio,
      not capacity (blocker B-7).

## 4. PR-2 checklist (per-user limit), for when PR-1 has merged

- [ ] Default 240 a minute per account across all routes is acceptable (`09` §1.5: 4 a second, more than ten times a busy
      screen, 1.3 to 2.8 % of an instance on ordinary routes).
- [ ] Guard order is per-IP, login, per-user, profile. A test fails if it changes.
- [ ] Existing protections untouched: no edit to the per-IP module settings, any route-level `@Throttle`, or the OTP rules; a
      test shows the 60-a-minute per-route per-IP limit still triggers.
- [ ] SOS is exempt; unauthenticated requests and health are not counted.
- [ ] It does not help users who share an address (stated; the shared-address question is parked, `09` §1.6).
- [ ] The CI smoke job needs 37 requests in total, far under the limit.
- [ ] Rebase or retarget onto the merged `main` first, and re-run the suite there.

## 5. PR-3 checklist and migration risks

The complete approval package (final diff, backup and restore commands, rollback, verification checklist) is `08` §2.11.

| Risk | Assessment (measured where marked) |
|---|---|
| Table locks | The three statements share one transaction, so `ACCESS EXCLUSIVE` on `worker_profiles` and `SHARE ROW EXCLUSIVE` on `users` last until commit. **Measured about 0.23 s at 50,000 workers** (215 ms of it the backfill); tens of milliseconds at a few thousand. Apply in a quiet moment |
| Rewriting data | None: `ADD COLUMN` without a default rewrites nothing. The backfill updates only approved rows |
| Compatibility during release | Additive; old code ignores the columns, so apply the migration **before** deploying code that uses them |
| Fresh-database path (what CI does) | **Verified**: the 5-migration chain applied to an empty schema in 2.8 s with no drift |
| Data invented by the backfill | None: **0 reviewers**; rejected and pending rows keep a NULL time. A NULL time must mean "unknown, never delete automatically" when the sweep is written |
| Rollback | Reverse SQL validated in a rolled-back transaction; then delete the migration's row from `_prisma_migrations` by hand (no down migration). Backup first |
| The irreversible part | Not this migration: the later sweep deletes Aadhaar images for good. It will ship with an off switch and its own review |
| Test database state | **Already applied** to `KaamConnect_test` (the harness applies pending migrations on every run); other branches still run against it (verified) |
| Dev and production | **Not applied.** Needs the three separate approvals above |

## 6. After you open a pull request

I read the GitHub Actions run for its exact head commit through the public API and report every step, with the log of any
failure. Until a run on that commit says `success`, nothing is called passed. I do not merge, and I do not push to `main`.
