# KaamConnect Backend: Documentation Index

Project setup and commands are in the [root README](../README.md). This folder holds the design.

| Doc | Contents |
|---|---|
| [01-requirements.md](./01-requirements.md) | Roles, screen→backend map, business rules, state machine, UI gaps, **assumptions, decisions, open questions** |
| [02-database.md](./02-database.md) | ER diagram, entities, indexes, constraints, Prisma version pinning |
| [prisma/schema.prisma](../prisma/schema.prisma) | Prisma schema (applied in Phase 1) |
| [03-api-spec.md](./03-api-spec.md) | Endpoints per screen, DTOs, validation, privacy matrix, Socket.IO events |
| [04-architecture.md](./04-architecture.md) | NestJS modules, cross-cutting design, environment variables, real-time and Redis seams |
| [05-security-testing.md](./05-security-testing.md) | Security controls, authorization matrix, test strategy |
| [06-migrations-seeds.md](./06-migrations-seeds.md) | Migration workflow, seeds, environments |
| [07-roadmap.md](./07-roadmap.md) | Phases, acceptance criteria, risks, estimates |
| [progress.md](./progress.md) | **Current status**: what is built and verified, known issues, open questions, dependencies, exact next task |

## Build status

| Phase | State |
|---|---|
| 0 Scaffold, config, health, CI | **Done** (see below) |
| 1 Schema, reference data, catalog API | **Done**: 19 tables migrated and seeded on `KaamConnect` and `KaamConnect_test` |
| 2 Auth & account | **Done**: phone OTP, JWT + rotating refresh tokens, `/me`, global login guard |
| 3 Profiles, media, verification | **Done**: customer/worker profiles, address book, signed uploads, admin review, worker GPS ping |
| 4 Jobs, leads, quotes, direct booking, discovery, Socket.IO | **Done**: 16 new routes, live push, benchmark at 5,000 workers / 50,000 jobs |
| 5 Tracking, arrival, bill, payment, SOS | **Done** (SOS delivery to a real receiver is not built or verified) |
| 5b Arrival-code recovery | **Done**: a customer can issue a new code (3 per assignment, 60 s apart, audited); migration applied to the development database |
| 6 Reviews, activity extras, earnings, savings | **Done**: reviews and tips, activity ratings, review summary, worker earnings, commission saved. No migration |
| 7–8 | Not started |

### Phase 0 deviations from the plan
- Nest 12's template is **ESM + Vitest + oxlint**; the plan said Jest/ESLint. Docs updated; no functional impact.
- npm 11.3 cannot resolve Vitest 4's peers; `.npmrc` sets `legacy-peer-deps=true`.
- `JWT_*`, `OTP_*`, `STORAGE_*` variables are added in the phase that first uses them, not in Phase 0.
- Prisma 7 generates a client from a schema with no models, so health can run before Phase 1.

### Phase 1 notes
- Baseline migration `20261010150000_baseline` was generated offline with `prisma migrate diff --from-empty`, then the hand-written CHECKs/partial indexes were appended (see `02-database.md §5`). It was applied with `migrate deploy`; `migrate reset` / `db push` were never used.
- `GET /locations` and `GET /service-categories` are **public until Phase 2** adds the global JWT guard; they return reference data only.
- Area centroids (`lat`/`lng`) are empty on purpose, see Q-18 in `01-requirements.md`.

### Phase 2 notes
- Auth contract, error codes and what the app must do: `03-api-spec.md §7`. Controls and tests: `05-security-testing.md §5`.
- `.env` needs `JWT_ACCESS_SECRET` and `OTP_PEPPER` (generated and appended to the local `.env`; never committed).
- The catalog endpoints now require login.

### Phase 3 notes
- Contract: `03-api-spec.md §8`. Controls and tests: `05-security-testing.md §6`.
- Found and fixed a PostgreSQL time-zone bug in how timestamps were stored (see `02-database.md §8`); the dev database had no data affected.
- Open questions Q-19 to Q-21 added in `01-requirements.md`; answered 2026-10-10 as decisions D-8 to D-10 (not built yet). Q-22 (photo change also triggers review) was answered yes and is part of D-8.

### Phase 4 notes
- Contract: `03-api-spec.md §9`. Architecture: `04-architecture.md §8`. Controls, findings and benchmark: `05-security-testing.md §7`.
- Area coordinates (Q-18) are still empty, so matching uses the same-city fallback; the radius rule is built, tested and switches on as soon as coordinates are in the seed data.
- Current status, known issues and the next task: `progress.md`.

### Scheduling and availability notes (added after Phase 4, before Phase 5)
- Requirements and rules: `01-requirements.md` (FR-SCHEDULING, BR-13 to BR-22, A-13 to A-18, Q-23 to Q-26). Contract: `03-api-spec.md §10`. Design: `04-architecture.md §9`. Database: `02-database.md §5`. Controls and tests: `05-security-testing.md §8`.
- New migrations `20261010180000_scheduling_and_availability` (needs the `btree_gist` extension) and `20261011090000_category_default_duration`. Both are applied to the test database (automatically by the e2e harness) and to the dev database `KaamConnect` (2026-10-11, after a backup; details in `progress.md` K-21). Any new environment, including CI and production, needs `btree_gist` to be creatable by the migrating role.
- New optional settings in `.env.example`: `BOOKING_*`, `SCHEDULE_*`, `SCHEDULED_JOB_OPEN_TTL_HOURS`.

### Phase 5 notes
- Contract: `03-api-spec.md §11`. Architecture: `04-architecture.md §10`. Controls, mutation check and findings: `05-security-testing.md §9`. Roadmap status: `07-roadmap.md`. Current status, known issues (K-26 to K-31) and the next steps: `progress.md`.
- New optional setting `SOS_WEBHOOK_URL` (required and https in production). No migration.
- GitHub CI has since passed for Phases 0–5 (see `progress.md` §0.5). **Still not verified:** the idle-machine benchmark and real SOS delivery.

### Phase 6 and arrival-recovery notes
- Contracts: `03-api-spec.md §11.9` (arrival-code recovery) and `§12` (reviews, earnings, savings). Controls and tests: `05-security-testing.md §10`; the agreed SOS requirements (nothing built) are in `§11`.
- New migration `20261011150000_arrival_code_reset` (additive: two columns on `jobs`, one enum, the audit table `job_security_events`, one CHECK). Applied to the test database and, after a verified backup, to the development database. Phase 6 needed no migration.
- No new settings. `COMMISSION_BENCHMARK_RATE` (default 0.20) now feeds `GET /me/savings`.
- GitHub CI passed on pull request #2 (run 38118304386, final commit `2552314`) and on `main` after it was merged (run 38120336005). **Not verified yet:** the idle-machine benchmark, real SOS delivery, real S3.

### Phase 7, Milestone A notes
- Coverage gates, D-8, masked logging, the IDOR matrix and the `ProfileGuard` review: `05-security-testing.md §12`. Status: `progress.md §0.9`. K-5 (disabled accounts) and K-36 (quotes of a worker under review) are fixed locally; contract changes in `03-api-spec.md §13`.
- No migration and no new setting. Two new error codes: `403 ACCOUNT_DISABLED` (every protected route) and `409 OFFER_UNAVAILABLE`. `npm run test:cov` is new; CI now runs both suites with coverage and checks the thresholds.
- **Not verified yet:** CI on this work, and the idle-machine benchmark.
