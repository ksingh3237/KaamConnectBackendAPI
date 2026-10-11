# 09 · Production readiness: throttling review and environment checklist

Status: **review and checklist only. No setting, limit or production configuration was changed.** Everything below was
read from the code on branch `feature/phase-7-milestone-b`; where something cannot be known until hosting is chosen,
it says so. Findings are split into **confirmed facts** and **risks** (things that may bite at scale but are not
defects today), and nothing is proposed that weakens a control.

---

## 1. Throttling review

### 1.1 What exists (confirmed)

| Layer | Setting | Where |
|---|---|---|
| Global default | 60 requests per minute **per client IP, counted separately for each route** (the counter key contains the controller and handler name, read in the installed `@nestjs/throttler` source), in memory | `app.module.ts` (`ThrottlerModule.forRoot`) |
| `POST /auth/otp/request` | 20 per hour per IP, **plus** per-phone rules: 30 s between codes, 5 codes per phone per hour | `auth.controller.ts`, `otp.service.ts` |
| `POST /auth/otp/verify` | 30 per 15 min per IP, **plus** 5 wrong attempts per code | same |
| `POST /auth/refresh` | 60 per 15 min per IP | same |
| `POST /media/presign` | 60 per hour per IP | `media.controller.ts` |
| `POST /jobs/:id/arrival-code/reset` | 20 per hour per IP, a coarse backstop; the real cap is 3 per assignment, 60 s apart, enforced in one database update | `fulfilment.controller.ts` |
| Arrival code | 5 wrong tries per assignment then locked (database-enforced) | fulfilment services |
| `POST /jobs/:id/sos` | **no route-specific limit** (only the generic 60 per minute per IP). Deliberate to keep: an emergency call should be the last thing to be throttled | `safety.controller.ts` |
| Health probes | not throttled (`@SkipThrottle`) | `health.controller.ts` |
| Socket.IO | not throttled by the HTTP throttler; handshake needs a valid JWT; `location:update` stores at most one fix per 3 s | `realtime.gateway.ts` |
| Business caps | 10 open jobs per customer, 20,000-worker safety cap on discovery | services |
| Guard order | throttle, then JWT, then profile/admin check, so floods are cheap to refuse | `app.module.ts` |
| Client IP | trusted only through `TRUST_PROXY` (hops); 0 means the header is ignored and cannot be spoofed | `app.setup.ts` |

The throttler's counters are **per process, in memory**: a restart resets them, and two instances double every limit.

### 1.2 Findings

**Confirmed (no defect found).** The per-route limits are tight where abuse costs money or safety (SMS, OTP guessing,
arrival code, presign). The guard order is right. Rate-limited requests are logged (429s appear in the request log).
Throttling is the first guard, so a flood of unauthenticated calls never reaches the database.

**Risks, each with a recommendation. None is applied.**

| # | Risk | Why it matters | Recommendation (needs your approval) |
|---|---|---|---|
| T-1 | **Everything is keyed by IP.** Mobile networks in India put many phones behind one public address (carrier-grade NAT), as do shared Wi-Fi networks | Counters are per route, so a busy screen's mix of calls does not add up to one budget. The exposure is on routes one client calls **repeatedly**: for example `PUT /workers/me/location` pings (if the app pings every 5 seconds that is 12 a minute per moving worker, so five workers behind one address reach 60 and the rest see `429`; the ping interval is the frontend's choice; the socket event `location:update` is not throttled, so the app should use it), and the single-route auth limits: `refresh` (60 per 15 min per IP allows about 60 users behind one address, since each refreshes every 15 min) and `otp/request` (20 per hour per IP, which a shop or event where many people sign up on one Wi-Fi could exhaust) | An additive **per-user** layer (built as a separate change, section 1.4) protects against one account (or one botnet rotating IPs) abusing the API, but **does not fix the shared-address case**: that needs the per-IP numbers raised for authenticated traffic, which loosens an existing protection and is therefore your decision, best taken with real traffic data |
| T-2 | **`TRUST_PROXY` must match the real hop count.** Too low (0 behind a load balancer): every user appears to be the balancer's address, so the whole user base shares each route's 60/min bucket: an outage that looks like load. Too high: a client can forge `X-Forwarded-For` and dodge limits | Easy to get wrong at first deployment | A release-checklist step (section 2): after deploy, make one call from each of two different networks and confirm the request log shows two different masked client addresses (`ip=` in the log line) |
| T-3 | **In-memory counters per instance** | With 2+ instances limits multiply and are inconsistent; a restart or deploy resets them (an attacker gains a fresh budget every deploy) | Fine for one instance at launch (D-6). Move storage to Redis with the Phase 8 Redis work, before scaling out |
| T-4 | **Expensive read routes sit under the generic limit.** Discovery costs about 40 to 60 ms of CPU per call (K-15) and one user may make 60 per minute (per route, per IP) | About 17 users doing that continuously would saturate one core. Unlikely at launch unless the app polls discovery (the frontend should confirm it does not), but nothing stops a script | The per-user layer of section 1.4 can carry a lower limit for `GET /workers` (the mechanism exists; **not enabled**, as it would restrict real users); revisit with real traffic |
| T-5 | **Socket.IO handshakes are not rate limited by the app** | A flood of connection attempts is refused at the handshake (invalid JWT) but still costs the server a little each | Handle at the edge (load balancer or WAF rate rule) when hosting is chosen; not an application change |
| T-6 | **No limit on `POST /jobs/:id/payment`, cancel, quote and bill routes beyond the default** | Each is guarded by state and ownership (idempotent payment, state machine), so repeated calls do no harm, only cost | Covered by the generic limit; no change |
| T-7 | **Clients must back off on `429`** (frontend): the throttler sends a `Retry-After` header (present in the installed `@nestjs/throttler` code) | A client that retries immediately makes a limit worse | Frontend: wait for `Retry-After`; to be added to the frontend gap list |

### 1.3 What I did not change, and why

No limit was raised or lowered, no route gained or lost a throttle, and the guard order is untouched: weakening any of
them is a security decision for you, and the strengthening options (T-1, T-4) change behaviour for real users, so they
want your go-ahead and a test pass of their own.

---

## 2. Production environment checklist

### 2.1 What the application already refuses (confirmed in `env.validation.ts`; boot fails with a list of problems)

With `NODE_ENV=production`: `OTP_DEV_BYPASS` must be `false`; `SMS_PROVIDER` must not be `console`;
`WORKER_VERIFICATION_MODE` must be `manual`; `SOS_WEBHOOK_URL` must be set and `https://`; `STORAGE_PROVIDER` must be
`s3`. In every environment: `JWT_ACCESS_SECRET` and `OTP_PEPPER` at least 32 characters and different from each other;
with `s3`, region and both buckets set and **different** buckets (Aadhaar goes to the private one), and the access and
secret keys both set or both empty; `REALTIME_CORS_ORIGINS` entries must be exact origins (no wildcards);
`TEST_DATABASE_URL`, if present, must end in `_test`.

**Today those guards cannot all be satisfied**: `SMS_PROVIDER=msg91` is not implemented
(`otp-sender.provider.ts` throws "not implemented yet"), so the application **cannot start in production** until the
MSG91 sender exists (Phase 8, blocked on DLT approval).

### 2.2 Before the first production start

| # | Item | Notes |
|---|---|---|
| 1 | Secrets generated fresh, never reused from a development machine: `JWT_ACCESS_SECRET`, `OTP_PEPPER` (each 48 random bytes, base64url), stored in the hosting secret store, not in the repository or image | Rotating `JWT_ACCESS_SECRET` signs everyone's access token out (up to 15 minutes); sessions survive because refresh tokens are opaque and stored in the database. Rotating `OTP_PEPPER` invalidates only codes in flight (5 minutes) |
| 2 | `DATABASE_URL` for a role that is **not** a superuser; TLS to the database | Today the local role is `postgres` (superuser). The migrations create the `btree_gist` extension: **unverified** whether the production role may do that (CI passed with a superuser). Confirm on the real database before the first release (`CREATE EXTENSION IF NOT EXISTS btree_gist`) |
| 3 | `TRUST_PROXY` = number of proxies in front (1 behind a single load balancer) | See T-2. Verify after deploy |
| 4 | `STORAGE_PROVIDER=s3`, region `ap-south-1` (D-10), two buckets (public-read-by-signed-URL media, private Aadhaar), encryption at rest on, public access blocked on both, versioning **off** on the private one (D-9), an IAM role for the task (no static keys), permissions limited to those two buckets | `S3StorageService` has never run against a real bucket (K-3): do a real upload, download and delete before launch. `s3:DeleteObject` is needed once D-9 or `DELETE /me` exist |
| 5 | `SOS_WEBHOOK_URL` pointing at a receiver a **named person** watches, with a tested path | No receiver or on-call person has been chosen. Delivery has only been tested against a mock. K-28: no retry, no acknowledge |
| 6 | `SMS_PROVIDER=msg91` with its credentials, once built | Blocked on DLT registration |
| 7 | `WORKER_VERIFICATION_MODE=manual`, and at least one admin user (`users.is_admin = true`) | There is no endpoint to create an admin: it is a database update by an operator. Record who holds it |
| 8 | `PUBLIC_BASE_URL` | Only used by the development file store; leave empty with `s3` |
| 9 | `REALTIME_CORS_ORIGINS` empty (the native app sends no `Origin`) unless a web client is added | |
| 10 | Business settings reviewed: `JOB_OPEN_TTL_HOURS` (24), `DIRECT_ACCEPT_TTL_MIN` (10), `COMMISSION_BENCHMARK_RATE` (0.20, disclosed in the app), booking settings (defaults) | **Per-service durations and the 13 area coordinates are still empty** (Q-18, D-14): matching falls back to same-city and every job is 90 minutes |
| 11 | Node 20.19 or newer (`engines`) | |
| 12 | Time zone: the database session is pinned to UTC by the app's adapter; **PgBouncer in transaction mode would drop that pin** unless startup `options` are allowed (K-13) | Do not put PgBouncer in front without checking |
| 13 | Logs go to a durable sink with access control; they are masked (phones, tokens) and carry a request id, but still contain user ids and masked IPs | Retention period to be set |
| 14 | Backups on, point-in-time recovery on if the host offers it, and a restore **drill** done once (section 3 of the runbook) | Not yet done anywhere |
| 15 | Monitoring: `/health` (liveness, never touches the database) for the process check and `/health/ready` (a `SELECT 1` with a 2 s limit, `503 DB_UNAVAILABLE` when it fails) for traffic decisions; alert on 5xx rate, on `Expiry run failed` and `Purge failed` log lines, and on any `OPEN` SOS alert older than a few minutes | There is no metrics endpoint |

### 2.3 Container and release build (the host is not chosen yet, so there is no Dockerfile)

Facts any image or build script must respect:

- `npm ci` runs `prisma generate` through `postinstall`, and **`prisma` and `tsx` are devDependencies**. A production
  image built with `npm ci --omit=dev` would fail on `postinstall`. Build in a stage with full dependencies (or use
  `--ignore-scripts` plus an explicit generate), and keep the Prisma CLI available to whatever runs the release step.
- The release step is `npm run db:migrate` (`prisma migrate deploy`: applies pending migrations only, never creates a
  migration or resets anything) and, on the first release, `npm run db:seed` (reference data: categories, cities, areas;
  safe to re-run).
- The app starts with `node dist/main` (`npm run start:prod`). It handles `SIGTERM` (shutdown hooks are enabled).
- **One instance at launch.** Background work runs inside the process: the job-expiry sweep (every minute, claims each
  job with a conditional update, so two instances would not double-expire), the auth purge (hourly, idempotent), and
  the in-memory location catch-up (K-24) and Socket.IO rooms (K-19: events do not cross instances, and the throttler
  counters are per instance). Scaling past one instance needs the Redis work first.
- `scripts/smoke.sh` needs the **console** OTP sender and auto verification, so it can run in CI and locally but not
  against production. Production verification after a release is `/health/ready` plus a real login.

### 2.4 Launch blockers register (tracked here and in `progress.md`; nothing is closed until the evidence exists)

| ID | Blocker | Owner | What it blocks | Status (2026-10-11) |
|---|---|---|---|---|
| B-1 | **Hosting for the app.** The plan says "AWS S3 + RDS"; the compute host (ECS, Elastic Beanstalk, EC2, App Runner, another provider) is not decided | You | Dockerfile or Procfile, the `TRUST_PROXY` value, WebSocket and stickiness settings, secret store, staging, the restore drill | **Open.** No Dockerfile exists on purpose |
| B-2 | **MSG91 sender and DLT approval.** `SMS_PROVIDER=msg91` throws "not implemented yet"; the console sender is refused in production | You (DLT, account), then me (sender, Phase 8) | **The application cannot start in production** | **Open.** Phase 8 work, not started |
| B-3 | **SOS receiver and a named on-call person.** `SOS_WEBHOOK_URL` is required (https) at boot | You | Boot in production; a real safety response | **Open.** Delivery only tested against a mock; no retry and no acknowledge (K-28) |
| B-4 | **S3 account, the two buckets, encryption, IAM role** | You | Uploads in production; file deletion for D-9 and `DELETE /me` | **Open.** `S3StorageService` has never touched a real bucket (K-3) |
| B-5 | **Verified coordinates for the 13 areas** | You | Distance, radius matching, travel gaps, ETA (K-4, K-26) | **Open.** 0 of 13 set; matching falls back to same-city |
| B-6 | **Minutes per service (8 categories)** | You | Realistic booking windows (D-14) | **Open.** 0 of 8 set; every job is 90 minutes |
| B-7 | **Idle-machine benchmark** | You (a quiet machine) | The performance claims in `progress.md` §3.4 | **Open, kept pending by your instruction.** The before/after numbers for Milestone B were taken on a busy laptop, with old and new code alternated to cancel the noise; they prove a ratio, not absolute capacity |
| B-8 | **Legal sign-off:** collecting Aadhaar images at all and for how long (D-9); the retention table for `DELETE /me` (`08` §1.6); log and backup retention; the deadline to act on a deletion request | You and counsel | D-9 and `DELETE /me` can be built but not switched on; launch | **Open.** No period is assumed anywhere in code |
| B-9 | **Domain name and TLS** | You | The app's API address | **Open** |
| B-10 | **Restore drill** | Me, once staging exists | The recovery time in the runbook | **Open.** Needs B-1 |
| B-11 | **`btree_gist` on the production database role** (the scheduling migration creates it) | Me, on the real database | The first production migration | **Open.** CI passed only with a superuser |
| B-12 | **Frontend work:** back off on `429` using `Retry-After`; single-flight token refresh (K-6); send location through the socket event rather than REST pings; "re-upload required" copy (G-15); show the benchmark rate beside "Total saved" (D-5) | Frontend | A smooth first launch | **Open** |
| B-13 | **Approvals pending:** `DELETE /me` final design (`08` §1.9); the D-9 migration on dev (`08` §2); merging per-user throttling (§1.4); `@nestjs/swagger` (§3) | You | Milestone B items | **Open** |

---

## 3. OpenAPI export: `@nestjs/swagger` compatibility report (nothing installed, `package.json` and the lock file untouched)

### 3.1 Versions checked

| Item | Installed here | `@nestjs/swagger` 12.0.2 needs | Fits |
|---|---|---|---|
| `@nestjs/common`, `@nestjs/core` | 12.1.2 | `^12.0.0` | yes |
| `@nestjs/platform-express` (what we use) | 12.1.2 | works with Express; `@fastify/static` is an optional peer we do not need | yes |
| TypeScript | 6.0.3 | `^5.5.0 \|\| ^6.0.0` (optional peer) | yes |
| `class-validator` / `class-transformer` | 0.15.1 / 0.5.1 | any (optional peers) | yes |
| `reflect-metadata` | 0.2.2 | `^0.1.12 \|\| ^0.2.0` | yes |
| Module format | the project is ESM (`"type": "module"`) | the package is `"type": "module"` with `import`/`require` exports | yes |
| Node | `engines >=20.19` (local 24.0.0) | `^20.19.0 \|\| >=22.12.0` | yes |

`latest` is 12.0.2; the `next` tag is an alpha and should not be used. Note: the project's `.npmrc` sets
`legacy-peer-deps`, so npm would not itself report a peer mismatch; the table above is therefore checked by hand.

### 3.2 What installing it would change (an `npm install --dry-run`, run twice; no file was modified)

Adds 7 packages: `@nestjs/swagger` 12.0.2, `@nestjs/mapped-types` 12.0.0, `swagger-ui-dist` 5.33.0 (about 11.9 MB
unpacked), `js-yaml` 5.4.2, `argparse` 2.0.1, `@microsoft/tsdoc` 0.17.0 and **`@scarf/scarf` 1.4.0**.

- **`@scarf/scarf` is an install-analytics package** (a dependency of `swagger-ui-dist`). I read its script from a
  downloaded copy without running it: its `postinstall` reports install statistics to a third party unless switched off
  by `SCARF_ANALYTICS=false`, `DO_NOT_TRACK=1` or `scarfSettings.enabled=false` in `package.json`. For a project that
  handles Aadhaar images, I would not accept that silently: if you approve the dependency, the opt-out goes into CI and
  the Dockerfile (or the install uses `--ignore-scripts`, which `postinstall: prisma generate` makes inconvenient).
- The `EBADENGINE` warnings printed by the dry run are about `@angular-devkit/*` (Nest CLI, a dev tool) and my local
  Node 24.0.0; they are there today, with or without swagger.
- Not yet known: whether `npm audit` has findings for the new packages (that is only visible after installing).

### 3.3 What it can and cannot do for this API (important before you approve)

- **Can:** list every route with its method and path (64 handlers), path/query parameters, request bodies from the
  `class-validator` DTO classes (through the `@nestjs/swagger` compiler plugin, so the DTOs do not need hand-written
  annotations), the global prefix and the bearer-auth requirement.
- **Cannot, as the code is written:** describe **response bodies**. They are TypeScript `interface`s (`JobView`,
  `LeadItem`, `WorkerJobsPage` and so on); the plugin only builds schemas from **classes**. Documenting responses means
  turning those interfaces into classes or annotating each route by hand, which is the larger part of the work.
- The plugin runs inside `nest build` (the TypeScript compiler), not under Vitest, so the export is produced from the
  built output. The export script must start the application, which opens the database: fine in CI (a database is
  there), but it is not a no-dependency step.

### 3.4 Proposal (needs your approval; nothing is done)

1. `npm install -D @nestjs/swagger@12.0.2` as a **devDependency** with an exact version, as the database packages are
   pinned. Dev only means the production image never contains `swagger-ui-dist`, and **no documentation endpoint is
   exposed by the running API**.
2. The Scarf opt-out as above.
3. A short spike (about half a day): the plugin in `nest-cli.json`, `scripts/export-openapi.ts`, and a CI step that
   writes `openapi.json` and fails if it differs from the committed copy ("contract check"). First version covers
   routes, parameters and request bodies; responses are a follow-up you can schedule.
4. Document the result in `03-api-spec.md` as generated, not hand-maintained.

Decision for you: **approve the dependency (and the Scarf handling), or leave OpenAPI export out of Milestone B.**
