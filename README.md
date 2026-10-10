# KaamConnect Backend API

REST + Socket.IO API for the KaamConnect mobile app (hyperlocal home-services marketplace for Chandigarh · Mohali · Panchkula).

> **Status:** Phase 4 complete: jobs, worker discovery, leads, quotes, direct booking and live Socket.IO push, on top of login, profiles, uploads and verification. Phase 5 (tracking, arrival code, bill, payment, SOS) is next. Design, decisions and roadmap: [docs/](./docs/README.md).

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 (≥ 20.19), ESM |
| Framework | NestJS 12, TypeScript 6 |
| Database | PostgreSQL (local: v18) |
| ORM / migrations | Prisma ORM **7.10.0**, pinned. Never run a bare `npm i prisma`: it installs the Prisma 8 RC, which has no `generate` / `migrate dev` |
| Auth (Phase 2) | Phone OTP (console sender in dev, MSG91 later) → JWT + rotating refresh token, stored in PostgreSQL |
| Real-time (Phase 4) | Socket.IO for bids, lead broadcast, job tracking |
| Cache / scaling | Redis optional, not used in v1 |
| Tests | Vitest, supertest, real PostgreSQL test database |
| Lint / format | oxlint, prettier |

## Prerequisites

- Node.js 24 and npm 11
- Local PostgreSQL with two existing databases: `KaamConnect` (dev) and `KaamConnect_test` (tests). Use the **exact case** in the URL
- `npm` needs `legacy-peer-deps` (already set in `.npmrc`; npm 11.3 crashes resolving Vitest 4's optional peers without it)

## Setup

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # then edit .env: user/password in DATABASE_URL and TEST_DATABASE_URL
npm run db:migrate          # apply migrations to DATABASE_URL (apply-only, never resets)
npm run db:seed             # reference data: 8 categories, 3 cities, 13 areas (idempotent)
npm run start:dev           # http://localhost:3000
```

Check it works:

```bash
curl http://localhost:3000/health          # {"status":"ok"}                      (process is up)
curl http://localhost:3000/health/ready    # {"status":"ok","db":"up"}            (database answers)
                                           # 503 DB_UNAVAILABLE if PostgreSQL is unreachable
```

Business routes live under `/api/v1` and need a login. Quick local login (the code is printed in the server log):

```bash
curl -X POST localhost:3000/api/v1/auth/otp/request -H 'Content-Type: application/json' -d '{"phone":"98765 43210"}'
curl -X POST localhost:3000/api/v1/auth/otp/verify  -H 'Content-Type: application/json' -d '{"phone":"98765 43210","code":"<code from the log>"}'
curl localhost:3000/api/v1/service-categories -H 'Authorization: Bearer <accessToken>'
```

`bash scripts/smoke.sh` runs the whole marketplace journey against the built app (`npm run build` first; it needs `WORKER_VERIFICATION_MODE=auto`): login, uploads, customer and worker onboarding, a job, the live WebSocket lead, a quote and the accept. It creates users `9000000001` and `9000000002`; delete them afterwards if you run it on your dev database.

Live updates: connect Socket.IO to `http://localhost:3000/realtime` with `auth: { token: <accessToken> }` (events in `docs/03-api-spec.md §9.6`).

## Environment variables

Validated at boot; the app refuses to start on any problem and lists all of them. Reference: [`.env.example`](./.env.example), rules in `src/config/env.validation.ts`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `TEST_DATABASE_URL` | test database; its name **must end in `_test`** |
| `JWT_ACCESS_SECRET`, `OTP_PEPPER` | required secrets, at least 32 chars each and different from each other. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `OTP_DEV_BYPASS`, `SMS_PROVIDER=console`, `WORKER_VERIFICATION_MODE=auto` | dev-only switches. **Boot fails if any is set in production**. With the console sender the OTP is printed in the server log; `OTP_DEV_BYPASS=true` makes every code `123456` |
| `TRUST_PROXY` | reverse proxies in front of the app (AWS ALB = 1) so rate limits use the real client IP |
| `STORAGE_PROVIDER` | `local` (default; files in `.local-storage/`, development only, **refused in production**) or `s3` |
| `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_BUCKET_PRIVATE`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` | S3 settings. Aadhaar images need their own private bucket. Leave the keys empty on AWS to use the IAM role |
| `REALTIME_CORS_ORIGINS` | browser origins allowed to open a WebSocket (comma separated, e.g. the Expo web dev server). Native apps need nothing |
| `PUBLIC_BASE_URL` | origin clients use to reach the API (used in local upload links); default `http://localhost:PORT` |
| `COMMISSION_BENCHMARK_RATE` | competitor commission for the "Total saved" figure, default `0.20` |
| `JOB_OPEN_TTL_HOURS`, `DIRECT_ACCEPT_TTL_MIN`, `AVG_SPEED_KMH` | business configuration |
| `REDIS_URL` | optional; empty = in-memory |

## Scripts

| Script | Does |
|---|---|
| `start:dev` / `build` / `start:prod` | run with reload / compile to `dist/` / run compiled |
| `lint` / `typecheck` / `format` | oxlint / `tsc --noEmit` / prettier |
| `test` / `test:e2e` / `test:cov` | unit / HTTP + WebSocket end-to-end (real PostgreSQL) / coverage |
| `test:perf` | on-demand benchmark: loads 5,000 workers and 50,000 jobs into `KaamConnect_test` and prints endpoint timings |
| `db:generate` | `prisma generate` |
| `db:migrate:dev` | `prisma migrate dev` (**local only**; needs permission to create a shadow database) |
| `db:migrate` | `prisma migrate deploy` (CI, staging, production; apply-only) |
| `db:seed` | idempotent reference data into `DATABASE_URL`; `SEED_LEGACY_AREAS=true` adds 6 extra areas |

`test:e2e` needs `TEST_DATABASE_URL` (a database named `*_test`); it applies pending migrations to it automatically and **empties it** on every run. The harness refuses any database whose name does not end in `_test`.

## Uploads and admin access in development

- **Uploads:** `POST /api/v1/media/presign`, then `PUT` the file to the returned URL with the returned headers, then send the returned `key` to the profile call. With the default `STORAGE_PROVIDER=local` this works without any AWS account.
- **Worker verification:** with `WORKER_VERIFICATION_MODE=auto` a worker is verified as soon as both Aadhaar images are uploaded. In production (`manual`) an admin does it via `/api/v1/admin/workers`.
- **Making yourself an admin** (no API for this on purpose): sign in once, then in pgAdmin run `UPDATE users SET is_admin = true WHERE phone = '+91XXXXXXXXXX';`

## Project layout

```
prisma/             schema.prisma, migrations/, seed.ts, seed/ (reference-data seeding), data/ (seed inputs)
prisma.config.ts    datasource URL (Prisma 7)
src/
  main.ts           bootstrap
  app.setup.ts      shared HTTP setup: helmet, /api/v1 prefix, validation, error filter
  app.module.ts
  config/           validated environment
  prisma/           PrismaService (pg driver adapter, lazy connection)
  common/           exceptions, filters, pipes, utils
  health/           GET /health, GET /health/ready
  modules/auth/     OTP login, tokens, JWT guard, OTP sender interface (console in dev)
  modules/users/    GET/PATCH /me
  modules/catalog/  GET /locations, GET /service-categories
  modules/media/    signed uploads (S3, or a signed local-disk stand-in for development)
  modules/customers/ customer profile and address book
  modules/workers/  worker profile, Aadhaar documents, live location, verification rules
  modules/admin/    worker review queue, verify / reject
  modules/matching/ the one rule for "does this worker serve this place"
  modules/jobs/     post, view, list, cancel, direct booking, expiry, state machine
  modules/offers/   leads radar, quotes, compare, accept
  modules/realtime/ Socket.IO gateway and the publisher business code uses
  generated/        Prisma client (git-ignored)
test/               end-to-end tests (real PostgreSQL), helpers/, global-setup.ts
docs/               requirements, database, API spec, architecture, security, roadmap
```

## Database workflow

Edit `schema.prisma` → `npm run db:migrate:dev -- --name <change>` → review the generated SQL → commit it. Production applies only `prisma migrate deploy`. Never run `migrate reset` or `db push` against anything but a throwaway local database. Details: [docs/06-migrations-seeds.md](./docs/06-migrations-seeds.md).

## CI

`.github/workflows/ci.yml` runs lint, typecheck, unit and e2e tests, build, a production-dependency audit, and a smoke test of `/health/ready` against a throwaway PostgreSQL 18 container.
