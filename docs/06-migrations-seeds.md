# 06 · Database Lifecycle: Migrations, Seeds, Environments

## 1. Findings about the existing database setup
- `KaamConnectBackendAPI/` was **empty** when analysed: no `prisma/`, no `.env`, no migration history, no existing DB config. Nothing to preserve, so Phase 1 of the build starts with a clean **baseline migration**.
- The folder previously sat inside an unrelated git repository (`projects/`, history "LAB API", old Node files shown as deleted). Per D-7 it now has **its own repo** (`git init`, branch `main`); the parent repo is untouched.
- **Database (D-1):** the existing native PostgreSQL (service `postgresql-x64-18`, pgAdmin 4) is used; no Docker. Databases `KaamConnect` (dev) and `KaamConnect_test` (tests). Postgres folds unquoted identifiers to lower case, so the connection URL must match the exact case of the database as created in pgAdmin. `psql` is not on PATH; Prisma and the app connect through `DATABASE_URL`, so it is not needed. Nothing is created or migrated without your explicit go-ahead.
- `prisma migrate dev` needs a *shadow database*: the local role must have `CREATEDB` (Prisma creates/drops a temporary DB). If you prefer not to grant it, point `shadowDatabaseUrl` at a dedicated empty `KaamConnect_shadow` database.
- Safety: the test runner refuses to start unless `TEST_DATABASE_URL` points to a database whose name ends in `_test`, so tests can never truncate the dev DB.

## 2. Environments

| Env | DB | Who runs migrations | Seed |
|---|---|---|---|
| local | Native PostgreSQL 18 on this machine: `KaamConnect` (dev) + `KaamConnect_test` (e2e) | developer: `prisma migrate dev` | `npm run db:seed` (reference) and `npm run db:seed:demo` (sample data; sets workers to VERIFIED directly) |
| CI | Postgres service container (GitHub Actions), throwaway DB | pipeline: `prisma migrate deploy` | reference seed |
| staging | managed Postgres, copy of prod settings | pipeline on merge to `main`: `migrate deploy` | reference + demo |
| production | managed Postgres (AWS RDS planned, Q-15) with backups/PITR, TLS; `WORKER_VERIFICATION_MODE=manual` | release pipeline step **before** new app version starts: `prisma migrate deploy` with a DDL-capable role | reference seed only (idempotent) |

`DATABASE_URL` differs per env; app runtime uses a DML-only role (`kc_app`), migrations use `kc_migrator`.

## 3. Migration workflow

1. Edit `prisma/schema.prisma`.
2. `npx prisma migrate dev --name <verb_noun>` (dev only). For anything Prisma can't express (CHECK constraints, partial unique indexes, sequence start — see `02-database.md §5`) use `--create-only`, edit the SQL, then apply.
3. Review the generated SQL in the PR. Migrations are **append-only**; never edit one that has been merged/applied.
4. CI: apply all migrations to an empty DB, run `prisma migrate diff --from-migrations … --to-schema …` (must be empty), run tests.
5. Release: `prisma migrate deploy` (applies pending only; never prompts, never resets).

Safety rules
- **Never** `migrate reset`, `db push`, or `--accept-data-loss` against staging/production. `reset` is local-only (and requires your explicit go-ahead in this project even locally, as it drops data).
- Breaking changes use **expand → migrate → contract** across two releases (add nullable column → backfill → switch code → drop). Dropping/renaming columns is its own reviewed migration.
- Large backfills run as scripts, not inside the migration, in batches.
- Take a backup/snapshot immediately before a production deploy that contains a destructive migration; test restore periodically.
- Failed migration in prod: `prisma migrate resolve` only after inspecting the partial state manually; document in the runbook.
- Prisma 7 notes: config in `prisma.config.ts`; `migrate dev` no longer seeds automatically; set `migrations: { seed: 'tsx prisma/seed.ts' }` (command to be confirmed against 7.10 docs at scaffold time) and run `prisma db seed` explicitly.

## 4. Seed scripts

### `prisma/seed.ts` — reference data (safe in every environment, idempotent via `upsert` on natural keys)

| Data | Source | Count |
|---|---|---|
| `service_categories` | `constants/mockData.ts` `SERVICE_CATEGORIES` (ids, EN/HI/PA titles, icon, colours, `baseFee`→int, examples), `sortOrder` in listed order | 8 |
| `cities` | Chandigarh, Mohali (SAS Nagar), Panchkula | 3 |
| `areas` | Union of the two app lists: Chandigarh – Sector 15, 17, 22, 35, 43 · Mohali – Phase 3B2, 5, 7, Sector 70 · Panchkula – Sector 11, 20, MDC Sector 4. Legacy prototype extras (Sector 8, Manimajra, Sector 68, Kharar Road, Sector 5/12 …) are in the seed file behind a flag (Q-11) | 12 (+7) |
| Area centroids | `lat/lng` per area — **to be supplied/verified**; approximate values are sufficient for radius filtering but must not be treated as authoritative | – |
| Sequence | `jobs_job_number_seq` start (done in migration, not seed) | – |

Rules: re-running changes nothing; never deletes; logs created/updated counts; exits non-zero on error.

### `prisma/seed-demo.ts` — development/staging only (hard-fails if `NODE_ENV=production`)
Mirrors the mock data so the existing app screens look the same once wired up: 3 verified workers (Rajesh Kumar – electrician, Gurpreet Singh – plumber, Amit Sharma – AC) with the skills/fees/ratings from `VERIFIED_WORKERS` (rating via `ratingSum/reviewCount`), 2 customers (Sunita Sharma, Harpreet Dhillon) with addresses, 2 open jobs from `WORKER_ACTIVE_LEADS`, one offer from Rajesh on lead-101, one completed job with bill/payment/review (₹430 bill from job-progress), one admin user. Fixed demo phone numbers on the reserved `+91 99999 000xx` range and `OTP_DEV_BYPASS` code `123456` in dev only (OTPs otherwise print to the console, D-2). Remote avatar URLs from the mock are **not** imported.

## 5. Backup, retention, housekeeping
- Managed-DB daily backups + PITR (7–14 days); restore drill before launch.
- `otp_challenges` older than 24 h and revoked/expired `refresh_tokens` older than 30 days deleted hourly by the scheduler.
- Soft state, not deletion, for business rows (jobs are CANCELLED not deleted). Hard deletion only via the account-deletion flow (Q-17).

## 6. NPM scripts (to be created in Phase 2)
```
db:migrate:dev   prisma migrate dev
db:migrate       prisma migrate deploy
db:generate      prisma generate
db:seed          prisma db seed
db:seed:demo     tsx prisma/seed-demo.ts
db:studio        prisma studio              (local only)
test             jest · test:e2e  jest --config test/jest-e2e.json
```
