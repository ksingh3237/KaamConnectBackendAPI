# 04 · NestJS Architecture

A **modular monolith**: one deployable, one PostgreSQL database, feature modules with explicit boundaries. No microservices, queues or caches in v1 (nothing in the app needs them at launch scale). Versions are to be confirmed at scaffold time: NestJS **12.x** (current on npm), Node **24** (installed locally; Nest requires ≥ 20), TypeScript, Prisma **7.10.x**.

## 1. Folder structure

```
KaamConnectBackendAPI/
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/                 # generated + hand-edited SQL, committed
│  ├─ seed.ts                     # reference data only, idempotent (prod-safe)
│  ├─ seed-demo.ts                # dev/staging sample users+jobs (refuses NODE_ENV=production)
│  └─ data/                       # categories.ts, locations.ts (seed inputs)
├─ prisma.config.ts               # datasource url, migrations.seed
├─ src/
│  ├─ main.ts                     # bootstrap: helmet, ValidationPipe, versioning, swagger (non-prod), shutdown hooks
│  ├─ app.module.ts
│  ├─ generated/prisma/           # prisma client output (gitignored)
│  ├─ config/
│  │  ├─ env.validation.ts        # schema-validate process.env at boot; fail fast
│  │  └─ configuration.ts         # typed config (jwt, otp, storage, jobs, geo)
│  ├─ prisma/
│  │  ├─ prisma.module.ts         # @Global
│  │  └─ prisma.service.ts        # PrismaClient + pg adapter, onModuleInit/Destroy
│  ├─ common/
│  │  ├─ decorators/              # @Public, @CurrentUser, @RequireProfile('customer'|'worker'), @Roles('admin')
│  │  ├─ guards/                  # JwtAuthGuard (global), ProfileGuard, AdminGuard
│  │  ├─ filters/                 # AllExceptionsFilter (+ Prisma error mapper P2002→409, P2025→404)
│  │  ├─ interceptors/            # LoggingInterceptor (redacts phone), (optional) ClassSerializer
│  │  ├─ dto/                     # PaginationDto, IdParamDto
│  │  └─ utils/                   # phone.ts (E.164), geo.ts (haversine, eta), money.ts, time-ist.ts, cursor.ts
│  └─ modules/
│     ├─ auth/                    # otp.service, token.service, sms/ (OtpSender interface + provider + console dev impl)
│     ├─ users/                   # /me, language, savings
│     ├─ catalog/                 # locations, service-categories (read-only, cacheable)
│     ├─ customers/               # profile, addresses
│     ├─ workers/                 # profile, documents, location, discovery, earnings
│     ├─ media/                   # presign, StorageService interface (S3-compatible impl)
│     ├─ jobs/                    # create/cancel, state machine, tracking, bill, payment, receipt, expiry sweeper
│     ├─ offers/                  # leads feed, send/revise/withdraw quote, accept
│     ├─ reviews/                 # review + aggregate update
│     ├─ realtime/                # Socket.IO gateway, RealtimePublisher, room/auth logic (D-6)
│     ├─ safety/                  # SOS alerts
│     ├─ admin/                   # worker verification, SOS triage
│     └─ health/
├─ test/                          # e2e (supertest) + helpers/factories
├─ .env.example                   # keys only, no secrets
├─ .github/workflows/ci.yml
└─ docs/
```

Each module follows: `*.module.ts`, `*.controller.ts` (HTTP only: parse, authorize, delegate), `*.service.ts` (business rules + Prisma), `dto/` (request/response classes with validation), `*.spec.ts` beside the unit.

## 2. Module responsibilities & dependencies

```
auth ─▶ users                       jobs ─▶ catalog, offers*, media, workers(read), reviews(read)
customers ─▶ catalog, media         offers ─▶ jobs(read/state), workers(read)
workers ─▶ catalog, media           reviews ─▶ jobs(read), workers(aggregate)
admin ─▶ workers, safety, media     safety ─▶ jobs(read)
(*) job↔offer circularity avoided: accepting an offer is a single method in OffersService that
    calls JobStateMachine (pure, in jobs/state) — jobs does not import OffersService.
```

Rules: controllers never touch Prisma; services of one module don't reach into another module's tables except through the other module's exported service (read helpers) — except the two documented transactions (accept offer; submit review), which live in one service and use a shared `Prisma.TransactionClient`.

## 3. Cross-cutting design

| Concern | Choice | Reason |
|---|---|---|
| Config | `@nestjs/config` + schema validation (`class-validator` on an `EnvVars` class, no extra lib); typed accessors | Fail at boot on missing/invalid env, esp. JWT secrets, `OTP_DEV_BYPASS` guard |
| Validation | Global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform, transformOptions.enableImplicitConversion:false })` | Rejects unknown fields (mass-assignment) |
| AuthN | `@nestjs/jwt`, global `JwtAuthGuard`, `@Public()` opt-out; access JWT 15 min HS256 with `sub`, `jti`; refresh = opaque random 256-bit, hashed, rotating | No Passport dependency needed for one strategy |
| AuthZ | `ProfileGuard` (customer/worker profile exists, worker `VERIFIED` where required) + **ownership check inside services** (`where: { id, customerId }`) | Guards alone don't stop IDOR |
| Errors | `AllExceptionsFilter` → `{statusCode, code, message, details}`; domain errors are `AppException(code, status)` subclasses | Stable contract for the app |
| Rate limiting | `@nestjs/throttler`, default 60/min/IP; stricter named throttlers on OTP routes (per phone and per IP) | |
| Time-based work | `@nestjs/schedule`: every minute expire OPEN jobs (broadcast: 24 h, direct: `DIRECT_ACCEPT_TTL_MIN`) past `expiresAt` and emit `lead.closed` / `direct.expired`; hourly purge old OTP rows and revoked refresh tokens. Idempotent; safe to run on 2 instances via `UPDATE … WHERE status='OPEN' AND expires_at < now()` | No queue yet |
| Third parties | Interfaces `OtpSender`, `StorageService`, (later) `PushSender`; DI token per interface; dev OTP sender logs to console (D-2); dev storage may use local MinIO or a dev bucket | Swap providers (MSG91 later, Q-15) without touching business code |
| Logging | Nest `Logger` JSON in prod; request id; mask phones (`+9198****3210`), never log tokens, OTPs, Aadhaar keys | |
| Docs | `@nestjs/swagger` generated from DTOs; exported `openapi.json` committed in CI for contract diffing | Gives frontend a typed contract |
| Pagination | Cursor on `(created_at, id)` | Stable under inserts |
| Transactions | `prisma.$transaction(async tx => …)` for accept-offer, payment, review, job create (+media) | |
| Graceful shutdown | `app.enableShutdownHooks()` | Clean DB disconnect on deploy |

### Job state machine (single source of truth)
`jobs/state/job-state-machine.ts` exports a table `{ from, action, actor, to, guard }` consumed by every mutating service method and by tests. Illegal transitions throw `409 INVALID_TRANSITION`. Example rows: `OPEN + acceptOffer(customer) → ASSIGNED`, `ASSIGNED + verifyArrival(worker) → ARRIVED`, `ARRIVED + approveBill(customer) → IN_PROGRESS`, `IN_PROGRESS + completeWork(worker) → WORK_COMPLETED`, `WORK_COMPLETED + markPaid(customer) → COMPLETED`, `OPEN|ASSIGNED + cancel(customer|worker|system) → CANCELLED|OPEN`. Direct-booking rows: `OPEN + acceptDirect(target worker) → ASSIGNED`, `OPEN + declineDirect(target worker) → CANCELLED`, `OPEN + expire(system) → CANCELLED`.

### Lead fan-out
No per-worker rows are stored. A lead is an OPEN job matched at **read time** (category ∈ worker trades, area/radius filter, verified worker, not a direct job). On job creation the same query is run once to compute the matching workers: its count is `notifiedWorkers`, and `lead.new` is emitted to each worker's `user:<id>` socket room after commit. `GET /leads` remains the initial-load / reconnect source of truth. Direct bookings emit `direct.request` to the one target worker only.

### Geo
`common/utils/geo.ts`: haversine (km), bounding-box prefilter on lat/lng (indexed columns can be added if needed), `etaMinutes = ceil(km / AVG_SPEED_KMH * 60)`. Everything falls back to `Area` centroid when no GPS fix exists.

## 4. Key dependencies (kept minimal)

Runtime: `@nestjs/common @nestjs/core @nestjs/platform-express @nestjs/config @nestjs/jwt @nestjs/throttler @nestjs/schedule @nestjs/swagger`, `class-validator class-transformer`, `@prisma/client@~7.10 @prisma/adapter-pg pg`, `helmet`, `@aws-sdk/client-s3 @aws-sdk/s3-request-presigner` (S3-compatible storage, A-3), SMS provider SDK/HTTP (Q-2), `dotenv`.
Dev: `prisma@7.10.0`, `typescript`, `@nestjs/cli @nestjs/testing`, `jest ts-jest supertest @types/*`, `eslint prettier`.
Real-time: `@nestjs/websockets @nestjs/platform-socket.io socket.io`. Added only when Redis is introduced (D-6): `ioredis`, `@socket.io/redis-adapter`, and a Redis-backed throttler storage.
Deliberately excluded: Passport, Bull, GraphQL, PostGIS, Docker/Testcontainers (tests use the local `KaamConnect_test` database, D-1). Redis is **not** a v1 dependency.

## 5. Environment variables (`.env.example`)

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/KaamConnect?schema=public
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/KaamConnect_test?schema=public
JWT_ACCESS_SECRET=            # ≥ 32 random bytes
JWT_ACCESS_TTL=15m
REFRESH_TTL_DAYS=30
OTP_PEPPER=                   # HMAC key for OTP hashes
OTP_TTL_SEC=300
OTP_RESEND_SEC=30
OTP_DEV_BYPASS=false          # boot refuses `true` when NODE_ENV=production
SMS_PROVIDER=console          # console (logs OTP, dev only) | msg91 (later)
SMS_API_KEY=
STORAGE_ENDPOINT=  STORAGE_REGION=  STORAGE_BUCKET_PUBLIC=  STORAGE_BUCKET_PRIVATE=
STORAGE_ACCESS_KEY=  STORAGE_SECRET_KEY=
JOB_OPEN_TTL_HOURS=24
AVG_SPEED_KMH=20
COMMISSION_BENCHMARK_RATE=0.20   # competitor commission used for "Total saved" (D-5); KaamConnect itself charges 0%
WORKER_VERIFICATION_MODE=manual   # manual | auto. `auto` = dev-only simulated approval; boot refuses it in production (D-4)
DIRECT_ACCEPT_TTL_MIN=10          # worker response window for direct bookings (D-3)
REALTIME_CORS_ORIGINS=            # allowed origins for the Socket.IO handshake (Expo web dev)
REDIS_URL=                        # OPTIONAL. Empty = in-memory; set to enable cache + Socket.IO Redis adapter (D-6)
SUPPORT_PHONE=
```

## 6. Request flow example (accept offer)

`POST /jobs/:id/offers/:offerId/accept` → `JwtAuthGuard` → `ProfileGuard('customer')` → `ParseUUIDPipe` → `OffersController.accept` → `OffersService.accept(userId, jobId, offerId)`:
1. `$transaction`: `job.updateMany({ where:{ id, customerId:userId, status:'OPEN' }, data:{ status:'ASSIGNED', workerId, acceptedOfferId, arrivalCode, assignedAt } })`; if `count≠1` → `409 JOB_NOT_OPEN`.
2. Mark chosen offer `ACCEPTED`, siblings `REJECTED`; insert `VISIT_FEE` bill item.
3. Return `{ status, arrivalCode }`.
Concurrency safe: the conditional update is the lock.

## 7. Real-time and Redis-readiness (D-6)

**Design:** a `RealtimeModule` exposes a Socket.IO gateway on namespace `/realtime` (event catalogue in `03-api-spec.md §6`). Business modules never import the gateway; they depend on an interface:

```ts
interface RealtimePublisher {
  toUser(userId: string, event: string, payload: unknown): void;
  toJob(jobId: string, event: string, payload: unknown): void;
}
```
`SocketIoRealtimePublisher` implements it; tests substitute a recording fake. Services call it **after** `$transaction` resolves.

- **Auth:** JWT verified in the handshake middleware (same secret/claims as REST); user joins `user:<id>`; `job:watch` checks ownership/assignment before joining `job:<id>`.
- **Authorization of payloads:** emitted payloads are built by the same role-shaped mappers as REST, so no private field (address, phone, arrival code) can leak through a room.
- **Failure model:** events are best-effort. Postgres is the source of truth; clients refetch on reconnect/foreground. No outbox table in v1 (revisit if event loss matters).
- **Backpressure:** per-socket event rate limit; GPS fixes throttled to 1 per 3 s per worker.

**Redis seams (not used in v1; each defaults to in-process):**

| Concern | v1 (no Redis) | With `REDIS_URL` |
|---|---|---|
| OTP challenges, refresh tokens | PostgreSQL tables (decided) | unchanged — optionally cache attempt counters |
| Socket.IO across instances | in-memory adapter (single instance) | `@socket.io/redis-adapter` |
| `CacheService` (catalog, locations) | in-memory TTL map | Redis implementation |
| Throttler storage | in-memory | Redis storage (needed once >1 instance) |
| Scheduled sweepers | DB-guarded `UPDATE … WHERE`, safe on N instances | unchanged |

Selection happens in one provider factory keyed on `REDIS_URL`; no business-code change is required to adopt Redis on AWS (ElastiCache). Deployment note for AWS: either enable sticky sessions on the ALB or restrict clients to the `websocket` transport.
