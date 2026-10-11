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
│  │  └─ app-config.module.ts     # global ConfigModule wired to validateEnv
│  ├─ prisma/
│  │  ├─ prisma.module.ts         # @Global
│  │  └─ prisma.service.ts        # PrismaClient + pg adapter, onModuleInit/Destroy
│  ├─ common/
│  │  ├─ decorators/              # @Public, @CurrentUser, @RequireProfile('customer'|'worker'), @Roles('admin')
│  │  ├─ guards/                  # JwtAuthGuard (global), ProfileGuard, AdminGuard
│  │  ├─ filters/                 # AllExceptionsFilter (+ Prisma error mapper P2002→409, P2025→404)
│  │  ├─ logging/                 # MaskingLogger (masks every log line), request-logger middleware, masking helpers
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

> **Built so far:** `auth`, `users`, `catalog`, `media`, `customers`, `workers` (+ discovery), `admin`, `matching`, `jobs`, `offers`, `realtime`. Also built since: `scheduling`, `fulfilment` and `safety` (§9, §10). Not yet built: `reviews` (Phase 6). The tree above is the original plan; `§8`–`§10` describe the modules as built.

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
| Rate limiting | `@nestjs/throttler`, default 60/min/IP; stricter per-route limits on the OTP/refresh routes (per IP); per-phone limits live in `OtpService` (DB-backed). `TRUST_PROXY` makes the IP the real client IP behind a load balancer. Guard order: Throttler, then JWT | |
| Time-based work | `@nestjs/schedule`: every minute expire OPEN jobs (broadcast: 24 h, direct: `DIRECT_ACCEPT_TTL_MIN`) past `expiresAt` and emit `lead.closed` / `direct.expired`; hourly purge old OTP rows and revoked refresh tokens. Idempotent; safe to run on 2 instances via `UPDATE … WHERE status='OPEN' AND expires_at < now()` | No queue yet |
| Third parties | Interfaces `OtpSender`, `StorageService`, (later) `PushSender`; DI token per interface; dev OTP sender logs to console (D-2); dev storage may use local MinIO or a dev bucket | Swap providers (MSG91 later, Q-15) without touching business code |
| Logging | **Built (Phase 7, Milestone A).** `MaskingLogger` is the application logger: every string and error stack has credentials removed and phone numbers masked (`+9198****3210`), and sensitive object properties are replaced. One masked line per finished request from middleware (not an interceptor, because guards run first and an interceptor would never see the 401, 403, 429 and 404 responses): route template, status, time, `X-Request-Id`, user id, client address with its last part blanked. Never the body, headers, query values or real path ids. JSON output in production is not enabled yet | |
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
Dev: `prisma@7.10.0`, `typescript`, `@nestjs/cli @nestjs/testing`, `vitest @vitest/coverage-v8 supertest @types/*`, `oxlint prettier` (the Nest 12 default toolchain; ESM project, `"type": "module"`, relative imports end in `.js`). `.npmrc` sets `legacy-peer-deps=true` because npm 11.3 crashes resolving vitest 4's optional peers.
Real-time: `@nestjs/websockets @nestjs/platform-socket.io socket.io`. Added only when Redis is introduced (D-6): `ioredis`, `@socket.io/redis-adapter`, and a Redis-backed throttler storage.
Deliberately excluded: Passport, Bull, GraphQL, PostGIS, Docker/Testcontainers (tests use the local `KaamConnect_test` database, D-1). Redis is **not** a v1 dependency.

## 5. Environment variables (`.env.example`)

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/KaamConnect?schema=public
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/KaamConnect_test?schema=public
JWT_ACCESS_SECRET=            # >= 32 chars; must differ from OTP_PEPPER
JWT_ACCESS_TTL_SEC=900
REFRESH_TTL_DAYS=30
OTP_PEPPER=                   # >= 32 chars; HMAC key for OTP hashes
OTP_TTL_SEC=300
OTP_RESEND_SEC=30
OTP_MAX_ATTEMPTS=5
OTP_MAX_REQUESTS_PER_HOUR=5
TRUST_PROXY=0                 # reverse proxies in front (AWS ALB = 1)
OTP_DEV_BYPASS=false          # boot refuses `true` when NODE_ENV=production
SMS_PROVIDER=console          # console (logs OTP, dev only) | msg91 (later)
SMS_API_KEY=
STORAGE_PROVIDER=local          # local (dev only, refused in production) | s3
STORAGE_LOCAL_DIR=              # default .local-storage
PUBLIC_BASE_URL=                # https://api.example.com (origin clients use; default http://localhost:PORT)
STORAGE_REGION=                 # s3: e.g. ap-south-1
STORAGE_BUCKET=                 # s3: media bucket
STORAGE_BUCKET_PRIVATE=         # s3: Aadhaar bucket (must differ from STORAGE_BUCKET)
STORAGE_ENDPOINT=               # only for MinIO / LocalStack
STORAGE_ACCESS_KEY=             # empty on AWS: use the IAM role
STORAGE_SECRET_KEY=

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

## 8. Marketplace architecture as built (Phase 4)

```
jobs/        JobsService (post, list, view, cancel)  DirectBookingService  JobExpiryService (cron)
             JobViewService (role-shaped views)  JobEventsService (every push, in one place)
             state/job-state-machine.ts (the only place that defines allowed transitions)
offers/      LeadsService (radar + detail)  OffersService (send, revise, withdraw, compare, accept)
matching/    coverage.ts (pure rule)  MatchingService (who serves a place)
workers/     DiscoveryService (GET /workers)  WorkerCardService (the card shown on customer screens)
realtime/    RealtimeGateway (Socket.IO /realtime)  RealtimePublisher (the abstraction business code uses)
```

**One matching rule** (`matching/coverage.ts`) is used by the lead feed, by "who do I notify", by lead/quote visibility and by worker discovery, so the four can never disagree: radius check when both sides have coordinates, otherwise same city (see `03-api-spec.md §9.2`).

**Concurrency pattern.** No in-memory locks and no read-then-write: each decision is a *conditional update* (`UPDATE jobs … WHERE id=? AND status='OPEN' AND not expired`) whose row count says whether this request won; everything that must change together is in one `$transaction`; quoting takes a `FOR SHARE` lock on the job row so a simultaneous accept (exclusive) is ordered strictly before or after it. Safe with several API instances.

**Events.** Services never touch Socket.IO. They call `JobEventsService` / `RealtimePublisher` after the transaction commits. Replacing the transport (Redis adapter across instances, push notifications for offline workers) changes only `RealtimeModule`.

**Why discovery and matching filter in application code.** Launch scale is one metro (hundreds to a few thousand workers); the rule needs per-worker radii, live positions and optional coordinates. Measured cost is in `05-security-testing.md §7`. The seam to change later is `MatchingService` / `DiscoveryService`; callers do not care how it is computed.

**Configuration added:** `REALTIME_CORS_ORIGINS` (optional, comma-separated browser origins). `JOB_OPEN_TTL_HOURS`, `DIRECT_ACCEPT_TTL_MIN` and `AVG_SPEED_KMH` (arrival estimate on direct bookings) were already defined and are now used.

**Dependencies added:** `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io` (pinned to **4.8.3**, exactly what the Nest adapter pins; a second copy breaks the TypeScript types), and dev-only `socket.io-client` for tests and the smoke script.

## 9. Scheduling and availability as built (extends Phase 4, ahead of Phase 5)

```
scheduling/  booking-window.ts (pure: windows, travel gap, conflicts)  schedule-time.ts (pure: IST day, "tomorrow", limits)
             AvailabilityService (read a worker's bookings, assess, and reserve under a lock)
             LeadDeliveryService (the once-only delivery guard + lead accept/decline records)
             ScheduleController (GET /workers/me/schedule)
offers/      LeadCatchUpService (re-matches leads when a worker's location changes)
```

**Dependency direction.** `SchedulingModule` depends only on the database and configuration, so jobs, offers and workers all use it without importing each other (the workers module reaches `LeadCatchUpService` through a small listener hook, `WorkersService.onLocationFix`, instead of an import cycle).

**One timeline per worker.** A confirmed job occupies `[booked_start_at, booked_end_at)`. `AvailabilityService.assess` is a pure function of the worker's bookings and the candidate job; the quote, lead-accept, direct-booking-create, customer-accept and direct-accept paths all call it, and only the confirming transaction calls `reserve`, which takes the per-worker advisory lock first. Because the lock key is the worker, two confirmations for different workers never wait on each other, and several API instances are safe.

**Two places, two times.** `matching/matching.service.ts` decides who *serves* a job: a job starting within `NEAR_TERM_MS` (2 h) is judged by the worker's live position and `radius_km`; a later one by their base area and `max(radius_km, scheduled_radius_km)` (BR-19, BR-20). `AvailabilityService` decides whether they are *free*, using the job's own place and time and the places of their neighbouring bookings.

**Events added:** `booking.confirmed` (customer and worker) and `location.refresh` (worker). `lead.new` gained optional `scheduledFor` and `reason: 'LOCATION'`. Lead pushes go through `LeadDeliveryService.claim`, so the new-job fan-out and the location catch-up cannot both send the same lead.

**Configuration added:** `BOOKING_DEFAULT_DURATION_MIN` (90), `BOOKING_BUFFER_MIN` (15), `BOOKING_DEFAULT_TRAVEL_MIN` (30), `SCHEDULE_MIN_LEAD_MIN` (30), `SCHEDULE_MAX_DAYS` (30), `SCHEDULED_JOB_OPEN_TTL_HOURS` (72).

**Decided (2026-10-11):** accepting a quote books immediately, with no second worker step (D-11); conflicting quotes and bookings are rejected (D-12); the wider radius is opt-in (D-13); job length = the customer's `durationMin`, else the service's `default_duration_min`, else 90 (D-14).

**Not done on purpose:** routing-based travel times (A-18) and rescheduling an existing booking. The Phase 5 endpoints that start and finish work were built afterwards and use the hook `JobEventsService.workerFreed` as described in §10; the requirements for them are real tests in `test/phase5-requirements.e2e-spec.ts`.

## 10. Fulfilment architecture as built (Phase 5)

```
fulfilment/  ArrivalService  BillService (items, view, approve, photos)  CompletionService
             PaymentService (payment + receipt)  TrackingService  WorkerJobsService
             trip.ts (pure: distance/ETA only from real coordinates)  job-access.ts (404-vs-409 helper, totals)
safety/      SosService  SafetyNotifier (abstract)  Logging / Webhook implementations
jobs/        WorkerBackOutService  open-until.ts (the one "how long is it open" rule)
```

**Ownership is in the query.** Every fulfilment service looks the job up with the caller's id in the `where` (`{id, workerId}` or `{id, customerId}`); a miss is a `404` indistinguishable from an unknown job, and a hit in the wrong state is a `409`. `explainFailedClaim` turns a lost conditional update into the right one of those. Worker routes use `@RequireProfile('worker')` **without** `verified`, so review state never strands a customer (decision D-8).

**Concurrency, again by conditional update.** Arrival counts the try and reads the code in one `UPDATE … RETURNING`; the bill edit and the customer's approval both start with a conditional update of the job row, which is the lock that orders them (an approval carries `expectedTotal` and rolls back if the items differ); payment claims `WORK_COMPLETED → COMPLETED` and inserts the payment in one transaction with a unique `job_id`, and the loser of a double tap re-reads the winner's row. The database backs two of these: one job in progress per worker, and payment per job.

**Back-out** is one transaction (`WorkerBackOutService`): a conditional update of the job, the worker's quote to WITHDRAWN, the bill deleted, and the lead guard reset (`worker_leads` rows with no answer or an acceptance deleted, the worker's own row set to DECLINED). After commit it publishes `location.refresh`, `job.status`, `job.reopened` and calls `leadOpened`, which uses the same once-only guard as a new job, so the same code path serves "new job" and "re-opened job". `POST /jobs/:id/cancel` stays one route: `JobsService.cancel` decides customer or worker by ownership.

**Tracking.** `TrackingService` registers a listener with `WorkersService.onLocationFix` (the same hook the lead catch-up uses, so no module imports another in a circle). The socket handler `location:update` in `RealtimeGateway` checks the job belongs to this worker and then calls the same `WorkersService.updateLocation` as REST.

**SOS** follows the OTP pattern: an abstract `SafetyNotifier`, selected by one provider factory on `SOS_WEBHOOK_URL`; tests swap in a recording one.

**Configuration added:** `SOS_WEBHOOK_URL` (required and https in production). **Dependencies added:** none.
