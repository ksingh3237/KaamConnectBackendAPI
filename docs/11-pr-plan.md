# 11 · Milestone B pull request plan and checklist

Status: **a plan. No pull request has been opened by me and none will be merged by me.** Every hash below was read from the
repository on 2026-10-11. GitHub CI has not run on any Milestone B branch, because a plain push does not start the
workflow; the results quoted here are local.

## 1. Proposed order

| # | Pull request | Head branch -> base | Contains | Needs from you before it is opened |
|---|---|---|---|---|
| **PR-1** | Performance work and Milestone B documents | `feature/phase-7-milestone-b` -> `main` | 6 commits: `531a3e6` heavy-user benchmark; `f45e03f` and `8980e6b` quote-count optimisation (customer list, lead feed, lead catch-up); `767588d`, `19a0180`, `d83db84` documents. 17 files, +1,387 / -37. **No migration, no new setting, no response change** | Nothing: it is ready. Optionally decide whether the follow-up documents (PR-4) join it first |
| **PR-2** | Per-user rate limit | `feature/phase-7-per-user-throttling` -> `main` (open it **after** PR-1 merges, so it shows only its own commit; before that it would also show PR-1's six) | 1 commit `9567f78`: guard, one optional setting `USER_RATE_LIMIT_PER_MIN` (default 240), SOS exemption, tests, documents (§1.4) | Approve the 240 default and the guard order (`09` §1.5). Already pushed for CI review |
| **PR-3** | D-9 decision audit migration | `feature/phase-7-d9-reviewed-at` -> `main` | 1 commit `ed7ccf8`: migration `20261011200000_worker_review_audit`, schema, 9 tests, document §2. **Adds a migration** | Your approval to push it, after reviewing the migration (`08` §2, review in §2.10). **Separately:** approval to apply it to dev (with a backup) before or after merging |
| **PR-4** | Follow-up documents | `feature/phase-7-milestone-b-followups` -> `main` | Documents only: `DELETE /me` design v3, the D-9 review, shared-address findings, the verified Swagger report, blockers B-14 to B-16, this plan | Not pushed. Either push it as PR-4 after PR-1, or I add it to `feature/phase-7-milestone-b` as one more commit before PR-1 (your choice) |
| later | OpenAPI export; `DELETE /me` with its migration; the D-9 sweep; shared-address Stage 1 and 2 | not started | | Each needs its own approval (`09` §3.6, `08` §1.9, `09` §1.6) |

Why this order: PR-1 changes behaviour least and unblocks everything else; PR-2 is stacked on it; PR-3 is the only one
that touches the database, so it goes last and alone.

## 2. Checks every pull request must pass

**CI (the workflow's 18 steps; I read the run through the public API and report each step):** checkout, setup-node,
`npm ci`, create the test database, the `btree_gist` check, lint, typecheck, unit tests with coverage, e2e tests against
PostgreSQL 18 with coverage, **coverage thresholds** (lines: 85 % for auth, jobs, offers and reviews and 70 % overall; branches: 70 % overall), build, production
dependency audit, migrations on a fresh database, **migration drift check**, seed, smoke test of the built app.

**Local results already obtained (not CI results):**

| Branch | Unit | e2e | Other |
|---|---|---|---|
| `feature/phase-7-milestone-b` (code at `8980e6b`) | 309 | 733 | typecheck, lint (`--deny-warnings`), prettier, build, `npm audit --omit=dev` all clean; perf suite 13/13 |
| `feature/phase-7-per-user-throttling` | 317 | 741 | same gates; 8 + 8 new tests; 5 mutation checks |
| `feature/phase-7-d9-reviewed-at` | 309 | 742 | same gates; 9 new tests; 3 mutation checks; fresh-schema run and timing (`08` §2.10) |

**Before you merge any of them:** the CI run is green on the exact head commit; the file list is what this plan says;
no unrelated file or secret is in the diff; the PR base is `main`; and for PR-3 the migration section below has been
read.

## 3. PR-1 checklist (the branch you asked me to keep as it is)

- [ ] **Behaviour preserved.** The quote counts are the same numbers by the same visibility rule (K-36) in the customer
      list, the lead feed, a single lead and the catch-up push. Evidence: `offer-counts.e2e-spec.ts` (6),
      `lead-catch-up-counts.e2e-spec.ts` (3), `visible-offers.spec.ts` (4), the existing K-36 and lead specs; six
      mutation checks, each of which made a test fail.
- [ ] **Single-job reads untouched** (`jobInclude` keeps the count; measured at 0.1 ms).
- [ ] **No change to authorization, pagination or response fields.** `leadPayloadOf` gained one argument, passed from the
      same value as before at the two single-job call sites.
- [ ] **The benchmark only touches test databases** (its harness refuses any other).
- [ ] **No migration, no setting, no dependency change** (`git diff --stat` shows none of `prisma/`, `package.json`,
      `package-lock.json`, `.env.example`).
- [ ] **Two text fixes to know about** (found while preparing this plan, left as they are because you asked me to keep the
      branch as-is):
      1. `docs/09` rows T-1 and T-4 and blocker B-13 point to a section 1.4 that exists **only on the throttling branch**; the
         pointer resolves when PR-2 merges.
      2. `docs/08`, `docs/progress.md` and `docs/09` say the D-9 and throttling changes are on local branches that are "not
         pushed". True when written; the throttling branch has since been pushed.
- [ ] Performance numbers in the commit messages come from a busy laptop with old and new code alternated; they show a
      ratio, not capacity (blocker B-7).

## 4. PR-2 checklist (per-user limit)

- [ ] Default 240 a minute per account across all routes is acceptable (`09` §1.5 gives the derivation: 4 a second, more than
      ten times a busy screen, 1.3 to 2.8 % of an instance on ordinary routes).
- [ ] Guard order is per-IP, login, per-user, profile. A test fails if it changes.
- [ ] Existing protections are untouched: no edit to the per-IP module settings, any route-level `@Throttle`, or the OTP
      rules; a test shows the 60-a-minute per-route per-IP limit still triggers.
- [ ] SOS is exempt; unauthenticated requests and health are not counted.
- [ ] It does not help users who share an address (stated, with the proposal in `09` §1.6).
- [ ] The CI smoke job needs 37 requests in total, far under the limit.
- [ ] Rollout: merge with the default and watch `429`s on authenticated routes.

## 5. PR-3 checklist and migration risks

Migration `20261011200000_worker_review_audit`: two nullable columns, one foreign key (`ON DELETE SET NULL`) and a backfill
that copies only recorded approval times.

| Risk | Assessment (measured where marked) |
|---|---|
| Table locks | The three statements share one transaction, so `ACCESS EXCLUSIVE` on `worker_profiles` and `SHARE ROW EXCLUSIVE` on `users` last until commit. **Measured about 0.23 s at 50,000 workers** (215 ms of it the backfill); tens of milliseconds at a few thousand. Apply in a quiet moment |
| Rewriting data | None: `ADD COLUMN` without a default rewrites nothing. The backfill updates only approved rows (16,666 of 50,000 in the test) |
| Compatibility during release | Additive; old code ignores the columns, so apply the migration **before** deploying code that uses them |
| Fresh-database path (what CI does) | **Verified**: the whole 5-migration chain applied to an empty schema in 2.8 s with no drift |
| Data invented by the backfill | None: **0 reviewers**; rejected and pending rows keep a NULL time. A NULL time must mean "unknown, never delete automatically" when the sweep is written |
| Rollback | Reverse SQL validated in a rolled-back transaction; then delete the migration's row from `_prisma_migrations` by hand (no down migration). Take a backup first |
| The irreversible part | Not this migration: the later sweep deletes Aadhaar images for good. It will ship with an off switch and its own review |
| Test database state | **Already applied** to `KaamConnect_test` (the harness applies pending migrations on every run). Other branches still run against it (verified) |
| Dev and production | **Not applied.** Needs your separate approval, a verified `pg_dump` backup first, `migrate status`, a drift check and row counts after (`08` §2.6) |

- [ ] Reviewed: the file, the generated SQL (identical to Prisma's output), the backfill, the rollback.
- [ ] Approve pushing the branch; approve merging; approve (separately) applying to dev, in that order.

## 6. After you open a pull request

I read the GitHub Actions run for its exact head commit through the public API and report every step, with the log of any
failure. Until a run on that commit says `success`, nothing is called passed. I do not merge, and I do not push to
`main`.
