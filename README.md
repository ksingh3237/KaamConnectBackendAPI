# KaamConnect Backend API

REST API for the KaamConnect mobile app (hyperlocal home-services marketplace for Chandigarh · Mohali · Panchkula).

> **Status: Phase 1 (analysis & design) complete; awaiting explicit approval to start the build. No code exists yet.** Requirements, assumptions, recorded decisions and open questions are in [01-requirements.md](./01-requirements.md). Sections below describe the **planned** setup and become real after Phase 0.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 (≥ 20.19 required by Prisma 7) |
| Framework | NestJS 12, TypeScript |
| Database | PostgreSQL 16+ |
| ORM / migrations | Prisma ORM **7.10.0** (pinned — do not run a bare `npm i prisma`, it installs the Prisma 8 RC) |
| Auth | Phone OTP (console sender in dev, MSG91 later) → JWT access token + rotating refresh token; OTPs/sessions stored in PostgreSQL |
| Real-time | Socket.IO (`@nestjs/websockets`) for bids, lead broadcast, job tracking |
| Cache / scaling | Redis **optional** — not required in v1; plug-in seams ready (Socket.IO adapter, cache, throttler) |
| Storage | S3-compatible object storage (presigned uploads) |
| Tests | Jest, supertest, real PostgreSQL test database |

## Prerequisites

- Node.js 24 and npm
- Native PostgreSQL running locally (this machine: v18, service `postgresql-x64-18`, pgAdmin 4) — no Docker needed
- Two existing databases: `KaamConnect` (dev) and `KaamConnect_test` (tests). Use the exact case in the URL

## Planned project layout

```
KaamConnectBackendAPI/
├─ prisma/            schema.prisma, migrations/, seed.ts, seed-demo.ts
├─ prisma.config.ts   datasource URL + seed command
├─ src/
│  ├─ main.ts, app.module.ts
│  ├─ config/  prisma/  common/
│  └─ modules/  auth · users · catalog · customers · workers · media · jobs · offers · realtime · reviews · safety · admin · health
├─ test/              e2e tests
├─ docs/              this documentation
└─ .env.example
```

## Setup (after Phase 0)

```bash
# 1. install dependencies
npm install

# 2. configure environment
cp .env.example .env          # then fill DATABASE_URL and the JWT/OTP secrets

# 3. create the database schema (local only)
npm run db:migrate:dev

# 4. load reference data (categories, cities, areas)
npm run db:seed
npm run db:seed:demo          # optional sample users/jobs, dev only

# 5. run
npm run start:dev             # REST http://localhost:3000/api/v1 · Socket.IO ws://localhost:3000/realtime
                              # Swagger: http://localhost:3000/api/docs (non-production)
```

## Environment variables

Defined and validated at boot (the app refuses to start if invalid). Full list in [04-architecture.md §5](./04-architecture.md).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | ≥ 32 random bytes |
| `OTP_PEPPER` | key for hashing OTP codes |
| `OTP_DEV_BYPASS` | dev-only fixed OTP; boot fails if `true` in production |
| `WORKER_VERIFICATION_MODE` | `auto` (dev: simulated approval) or `manual` (production admin review); boot fails on `auto` in production |
| `COMMISSION_BENCHMARK_RATE` | competitor commission for the "Total saved" figure, default `0.20` |
| `REDIS_URL` | optional; empty = in-memory |
| `SMS_PROVIDER` / `SMS_API_KEY` | OTP delivery (`console` in dev) |
| `STORAGE_*` | object storage endpoint, buckets, keys |

Never commit `.env`; `.env.example` holds keys only.

## Scripts (planned)

| Script | Does |
|---|---|
| `start:dev` / `build` / `start:prod` | run / compile / run compiled |
| `db:migrate:dev` | `prisma migrate dev` (local only) |
| `db:migrate` | `prisma migrate deploy` (CI/staging/production) |
| `db:generate` | `prisma generate` |
| `db:seed` / `db:seed:demo` | reference data / sample data |
| `test` / `test:e2e` | unit / integration tests |
| `lint` | ESLint + `tsc --noEmit` |

## Database workflow in one paragraph

Edit `schema.prisma` → `npm run db:migrate:dev -- --name <change>` → review the generated SQL → commit it. Production applies only `prisma migrate deploy`. Never run `migrate reset` or `db push` outside a local database. Details: [06-migrations-seeds.md](./06-migrations-seeds.md).

## Documentation index

| Doc | Contents |
|---|---|
| [01-requirements.md](./01-requirements.md) | Roles, screen→backend map, business rules, state machine, UI gaps, **assumptions, open questions** |
| [02-database.md](./02-database.md) | ER diagram, entities, indexes, constraints, Prisma version pinning |
| [proposed-schema.prisma](./proposed-schema.prisma) | Proposed Prisma schema (not yet applied) |
| [03-api-spec.md](./03-api-spec.md) | Endpoints per screen, DTOs, validation, privacy matrix |
| [04-architecture.md](./04-architecture.md) | NestJS modules, cross-cutting design, environment variables |
| [05-security-testing.md](./05-security-testing.md) | Security controls, authorization matrix, test strategy |
| [06-migrations-seeds.md](./06-migrations-seeds.md) | Migration workflow, seeds, environments |
| [07-roadmap.md](./07-roadmap.md) | Phases, acceptance criteria, risks, estimates |
