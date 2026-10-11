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

No per-IP limit was raised or lowered and no route lost a throttle. The only addition is the per-user layer of 1.4, which is strictly additive (it can only refuse more, never less) and lives on its own branch. Weakening any of
them is a security decision for you, and the strengthening options (T-1, T-4) change behaviour for real users, so they
want your go-ahead and a test pass of their own.

### 1.4 The per-user limit (additive; merged into `main` in PR #5, default 240 a minute)

**What it is.** A second rate limit that counts what one signed-in **account** does, whatever address the requests come
from. It sits **behind** the existing per-IP limit and changes none of its numbers, routes or behaviour.

| Item | Value |
|---|---|
| Limit | `USER_RATE_LIMIT_PER_MIN`, default **240 requests per minute per account across all routes** (4 a second sustained). Allowed range 30 to 100,000 (the floor stops a typo from locking everyone out) |
| What a person needs | A busy screen makes 5 to 10 calls; 240 a minute is far above any person and a hard stop for a script. The existing single-route per-IP limit (60 a minute) is the tighter one for one address, so **for a normal user on one address nothing changes** |
| Exempt | `POST /jobs/:id/sos`: an emergency call is the last thing to refuse (the per-IP limit still applies to it, as today). Requests with nobody signed in (login, refresh, health) are not counted: the per-IP guard handles them |
| Refusal | The same `429 TOO_MANY_REQUESTS` body and a `Retry-After` header, exactly like the per-IP guard, so clients handle both alike |
| Order of guards | per-IP throttle, login, **per-user throttle**, profile/admin check. It needs the user (so after login) and comes before the profile lookup (so a refused request costs no database query) |
| Storage | The same in-memory store as the per-IP limit, so the same caveats apply: per process, reset by a restart, doubled by a second instance (T-3). Keys are hashes (no user id in the clear) |
| A tighter limit on one route | The mechanism exists (`@UserThrottle({ limit, ttlMs })`, counted in addition to the all-routes limit) and is tested, but **no route uses it**: a limit on real users, for example on `GET /workers`, is your decision |

**What it protects against:** one account (or one stolen token) driving the API from many addresses (mobile data, a VPN,
a botnet), which the per-IP limit cannot see. **What it does not fix, and I want to be plain about it:** users who share
one address still share that address's per-route budget (T-1). Fixing that means raising the per-IP numbers for signed-in
traffic, which loosens an existing protection, so it stays your decision, best taken with real traffic data. This layer
is what would make such a decision safer, since an account would still be capped.

**Tests.** 8 unit tests (exactly the limit then refusal with `Retry-After`; users counted separately; nobody signed in or a
non-HTTP request is not counted; `@SkipUserThrottle()`; the window expires; the route-level limit refuses first and the
all-routes counter still counts; the route-level limit does not loosen the all-routes one; keys are hashes) and 8 e2e
tests through the real HTTP stack (one account refused after its limit while every call comes from a different address;
the limit is across routes; another user unaffected; it follows the account across logins; **SOS stays reachable when
the budget is spent**; unauthenticated calls and health are not counted; a refused request creates nothing; **the
per-IP limit is unchanged**: 60 a minute per route per address, also for a signed-in user). Five mutation checks (never
refuse, per route instead of across routes, SOS not exempt, keyed by address instead of user, wrong guard order) each
fail tests.

**To switch it off or tune it:** set `USER_RATE_LIMIT_PER_MIN` (no code change). There is deliberately no "off": the
maximum is 100,000 a minute, which is effectively off, and that setting is for tests.

### 1.5 Review of the per-user limit (default 240 a minute)

**Why 240.** *What a person needs:* the API spec says sockets push and "the app never polls"; one scripted end-to-end
journey (login, post a job, quote, accept, arrive, bill, pay, review) is **37 requests for two users in total** (the CI
smoke script), about 15 to 20 each; a busy screen makes 5 to 10 calls. 240 a minute is 4 a second sustained, more than
ten times a busy screen. *What a server can afford:* measured floors (client and server in one process, 20 concurrent
callers, 6 s each, on a busy laptop) are **141 to 302 requests a second per instance on ordinary routes** and about 22 on
discovery (K-15). One account at its cap therefore uses about 1.3 to 2.8 % of an instance on ordinary routes and about
18 % on discovery. This is an **abuse bound, not a capacity plan**: 100 accounts at their cap would be 400 requests a
second, more than one instance serves, so capacity protection stays an edge concern (T-5).

**Route-specific risks (nothing was changed for any of them).**

| Pattern | Risk at 240 a minute | Verdict |
|---|---|---|
| App launch or return to foreground (refetch of the main screens) | 10 to 20 calls in a burst | Fine |
| Customer on the tracking screen polling every 3 s | 20 a minute | Fine |
| Worker location by REST every 5 s | 12 a minute (the spec prefers the socket event, which is not counted) | Fine |
| Onboarding photo and Aadhaar uploads | the files go to storage, not through the API; 3 to 8 presign calls | Fine |
| Admin review session (queue, verify, reject) | under 30 a minute by hand; a script reviewing hundreds would hit the cap | Acceptable; deliberately **not** exempt |
| Discovery `GET /workers` | the cap does not protect it: 4 a second is about 18 % of an instance | `@UserThrottle` can carry a lower limit; **not enabled** (it would restrict real users) |
| SOS | exempt from this layer (the per-IP limit still applies) | Intended |
| Socket traffic | not counted by either HTTP limit | Edge concern |

**Guard order and the interaction with the per-IP limits (verified by tests and mutation checks).**
1. Order: per-IP throttle, login, **per-user throttle**, profile/admin check. Putting the user layer before login makes it
   never fire (no user known yet); a mutation check proves a test notices.
2. A request refused by the per-IP layer never reaches the user layer, so it adds nothing to a user's counter.
3. A request refused by the **user** layer has already been counted by the per-IP layer (which runs first and cannot know
   better). So an abusive account sharing an address still spends that address's per-route budget with its refused
   attempts. That is exactly the position before this change, not worse, and this layer does not cure it.
4. Refused hits are not recorded again by the installed throttler's storage, so hammering does not extend a lockout, and
   its windows slide (a hit log per window), so there is no boundary burst.
5. Counters are in memory per process (T-3), shared with the per-IP ones; keys are hashes.
6. **Existing protections are untouched:** the per-IP module settings, every route-level `@Throttle`, and the per-phone
   OTP rules are not edited by the change (it adds files and one provider line), and an e2e test shows the 60-a-minute
   per-route per-IP limit still triggers for a signed-in user.

**Ready for CI review.** The e2e setup lowers nothing for other suites (it sets the limit to 100,000 there); the CI smoke
job runs the built app with the default and needs 37 requests in total; `.env.example` documents the setting; no
migration; the new variable is optional with a safe default. **Rollout suggestion:** merge with the default and watch the
request log for `429`s on authenticated routes; a shadow mode that only logs is possible but is not built.

### 1.6 Shared-address throttling: investigation and proposed limits (**no limit was changed**)

**What is established.**
- Limits are per route and per client address. The installed throttler groups **IPv6 clients by their /64 subnet**
  (its default), so IPv6-native phones, which each receive their own /64, do not share a budget. Sharing is an
  **IPv4** matter: mobile networks that put many users behind one public address, and shared Wi-Fi.
- The tightest limits for a shared address are on the sensitive routes, which is the uncomfortable part.

| Route | Per-address limit | One user's plausible use | Users one address supports |
|---|---|---|---|
| `POST /auth/otp/request` | 20 per hour | one per login, plus up to two resends | about 7 to 20 logins an hour |
| `POST /auth/otp/verify` | 30 per 15 min | one or two per login | about 15 to 30 logins per 15 min |
| `POST /auth/refresh` | 60 per 15 min | one per access token life (15 min) | about 60 active users |
| `POST /media/presign` | 60 per hour | 3 for onboarding, 1 to 4 per job | about 10 users onboarding per hour |
| `POST .../arrival-code/reset` | 20 per hour (3 per job in the database) | rare | not a concern |
| Ordinary routes (default) | 60 per minute **per route** | 1 to 2 a minute per route if the app does not poll | about 30 users |
| `PUT /workers/me/location` (REST) | 60 per minute | 12 a minute at 5 s | about 5 workers |

**Measured versus assumed.** *Measured:* server throughput (141 to 302 requests a second on ordinary routes), the request
count of the scripted journey (37 for two users), the exact throttler behaviour including the IPv6 grouping. *Assumed,
because it cannot be measured today:* how many users share one IPv4 address in the launch cities, and how often the app
calls each route. There is no production traffic, and the mobile app does not call the API yet. Anything below that
depends on those two numbers is a proposal to confirm with data, not a measured limit.

**Proposal (nothing is applied; each stage needs your approval).**
- **Stage 0, now:** no change. Sensitive-route protections stay exactly as they are.
- **Stage 1, small and does not weaken anything:** (a) make the per-address limits of the sensitive routes configurable
  by environment variable **with today's values as the defaults**, so an operator can raise one deliberately for a known
  event (for example a college Wi-Fi at launch) with a restart and no code change; (b) use the existing request log, which
  already records every `429` with the route and the masked address, to see which routes and addresses are hit once real
  traffic exists (masking blanks the last part of the address, so counts per address are slightly coarse).
- **Stage 2, only after Stage 1 shows real `429`s from shared addresses:** raise the default per-address limit of
  **ordinary routes** from 60 to 120 a minute for requests that present a bearer token (a resolvable `limit` function on the
  existing setting, about six lines), keeping 60 for requests without one. Sensitive routes are untouched **by
  construction**: each declares its own explicit limit, which replaces the default. The per-user layer (240 a minute per
  account) is what makes this safe, since one account stays capped whatever the address does. Effect: ordinary-route users
  per address about 30 to 60; REST location pings 5 to 10 workers.
- **Trade-off of Stage 2, stated plainly:** a request that merely carries a bearer header gets the higher limit before its
  token is checked, so someone can send a fake token to get 120 instead of 60 invalid-token `401`s a minute per route. Those
  are cheap rejections (no database), so I judge it acceptable, but it is a small loosening on protected routes, hence your
  approval.
- **Not proposed, and why:** raising `otp/request`, `otp/verify`, `refresh`, `presign` or the arrival-code limits. The first
  protects SMS spend, the second and fifth guessing, and the others are inexpensive to leave alone. If a real event needs it,
  Stage 1(a) does it deliberately and temporarily.

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
| 9a | `USER_RATE_LIMIT_PER_MIN` (default 240; only once the per-user layer of 1.4 is merged) | Leave at the default until real traffic shows otherwise |
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
| B-13 | **Approvals pending (Milestone B):** final `DELETE /me` design v3 (`08` §1.9); the D-9 migration (`08` §2): review done, awaiting your approval to push and, separately, to apply on dev with a backup; merging the per-user limit (`09` §1.5); `@nestjs/swagger` and the Scarf opt-out (§3.6) | You | Milestone B items | **Open** |
| B-14 | **Shared-address throttling** (§1.6): approve Stage 1 (configurable sensitive limits at today's values, log analysis); Stage 2 (higher ordinary-route limit for bearer-token requests) only after real `429` data | You | Users behind one IPv4 address (carrier NAT, shared Wi-Fi) seeing `429` at launch events | **Open.** No limit changed; the IPv4 sharing figures are assumptions until traffic exists |
| B-15 | **OpenAPI response schemas:** all 64 response bodies are interfaces, so the export documents requests only (§3.5) | You (scope), then me | A contract check that covers responses | **Open.** Accepting the gap, or scheduling the conversion of about 25 to 30 response interfaces to classes, is your call |
| B-16 | **Counsel and operations for deletion requests:** the retention table (`08` §1.6), the statutory time to act, and how a Door B requester is told the outcome before an SMS template exists | You and counsel | Switching `DELETE /me` on in production | **Open** |

---

## 3. OpenAPI export with `@nestjs/swagger`: verified in an isolated copy (nothing installed in the repository)

**How this was checked.** A copy of the project was made outside the repository (no `.git`, no `.env`) and swagger was
installed **there**; the repository's `package.json`, lock file and `node_modules` were not touched (its `git status` was
clean throughout). The install used `--ignore-scripts` and both analytics opt-outs.

### 3.1 Versions (unchanged from the earlier check)

Nest 12.1.2 and TypeScript 6.0.3 satisfy `@nestjs/swagger` 12.0.2 (needs Nest `^12`, TypeScript `^5.5 || ^6`; ESM; Node
`^20.19 || >=22.12`). `class-validator` 0.15.1, `class-transformer` 0.5.1 and `reflect-metadata` 0.2.2 are accepted. The
project's `legacy-peer-deps` setting would hide a peer mismatch, so these were compared by hand.

### 3.2 Exact dependency impact

| Item | Change |
|---|---|
| `package.json` | **one line**: `"@nestjs/swagger": "12.0.2"` under `devDependencies` (exact version, as the database packages are pinned) |
| Lock file | **7 packages added, all dev-only**: `@nestjs/swagger` 12.0.2, `@nestjs/mapped-types` 12.0.0, `swagger-ui-dist` 5.33.0 (about 11.9 MB), `js-yaml` 5.4.2, `argparse` 2.0.1, `@microsoft/tsdoc` 0.17.0, `@scarf/scarf` 1.4.0. No existing package changed version |
| Install scripts | **only `@scarf/scarf`** has one (`postinstall`) |
| `npm audit` | the same 4 high findings as today (Prisma CLI tooling: `@prisma/config`, `deepmerge-ts`, `mysql2`, `prisma`, all dev-only); **none of the 7 new packages is named**; `npm audit --omit=dev` still reports 0 |
| Production image | contains none of it, since they are devDependencies |

### 3.3 The `@scarf/scarf` analytics, verified

I ran its real script under a preloaded tracer that records every network attempt and **blocks** it, so nothing was sent.

| Case | Result |
|---|---|
| No opt-out | **1 attempt**: an HTTPS request to `scarf.sh/package-event/install` carrying platform, architecture, Node version and hashed package names |
| `SCARF_ANALYTICS=false` | 0 attempts ("User has opted out") |
| `DO_NOT_TRACK=1` | 0 attempts |
| `"scarfSettings": { "enabled": false }` in the root `package.json` (no environment variable) | **0 attempts** ("Scarf has been disabled via a package.json in the dependency chain") |
| `npm install --ignore-scripts` | the script never runs |

**Recommended configuration:** put `"scarfSettings": { "enabled": false }` in the root `package.json`. It needs no
environment variable, so it holds on every developer machine, in CI and in the container build. **Ordering matters:**
the script runs while swagger is being installed, so the opt-out must be in `package.json` *before* the first
`npm install`. For that very first install run `SCARF_ANALYTICS=false npm install ...`, and commit the opt-out in the same
commit as the dependency. Belt and braces: also set `SCARF_ANALYTICS=false` in the CI workflow and the Dockerfile.

### 3.4 The exact configuration that worked

1. **`nest-cli.json`**: add `"plugins": ["@nestjs/swagger"]` under `compilerOptions` (next to `"deleteOutDir": true`). The
   plugin runs inside `nest build`, so it reads the DTO classes without hand-written annotations. It does not run under
   Vitest, which is fine because the export reads the built output.
2. **`scripts/export-openapi.mjs`** (the spike's script, verbatim in intent): load `dist/app.module.js`; create the app with
   `NestFactory.create(AppModule, { preview: true, logger: false })`; call `setGlobalPrefix(API_PREFIX, { exclude: ['health',
   'health/ready'] })` with `API_PREFIX` imported from `dist/app.setup.js` (so the prefix is never copied); build the
   document with `DocumentBuilder().setTitle(...).setVersion(...).addBearerAuth()`; write it as JSON.
3. **`package.json`**: a script `"openapi:export": "node scripts/export-openapi.mjs docs/openapi.json"`.
4. **CI**: after the Build step, run the export with placeholder values for `DATABASE_URL`, `JWT_ACCESS_SECRET` and
   `OTP_PEPPER` (they only have to pass validation), then `git diff --exit-code docs/openapi.json` as the contract check.

**Results of the spike.** The build with the plugin succeeded (53 s cold; the unmodified project's warm build is 19.5 s, so
the two are not comparable). The export ran in **15.7 s with no database** (preview mode creates the module graph without
instantiating providers; the connection string pointed at a closed port) and wrote **64 operations on 55 paths**.
Two runs were **byte-identical**, which a contract check needs.

### 3.5 What the document contains and what it does not

| Captured | Not captured |
|---|---|
| All 64 operations with method and path | **Response bodies: all 64 are the empty schema `{ "type": "object" }`**, because they are TypeScript interfaces (`JobView`, `LeadItem`, ...) and the plugin only reads classes |
| 30 request-body schemas from the DTO classes, including validator rules (for example the 6-digit code pattern) | Path ids are plain strings (the `ParseUUIDPipe` is not read), so no `uuid` format |
| Query parameters (for example `categoryId`, `areaId`, `sort`, `limit`, `cursor` on discovery) | **Bearer security is not declared on any operation**; it needs a small step that marks every operation as secured except those carrying the existing `@Public` metadata |
| 8 body-less action routes correctly without a body (plus the dev-storage binary upload) | Error responses |

So a contract check built on this today **would catch** added or removed routes, changed methods or paths, and changed
request fields or validators; it **would not catch** a change to a response shape. Documenting responses means converting
the response interfaces to classes or annotating each route, which is a separate, larger decision.

### 3.6 Decision for you

Approve (1) the devDependency and the Scarf opt-out exactly as in 3.2 and 3.3, and (2) the configuration in 3.4 as a
small first PR (about half a day with tests, including the bearer-security step), accepting the response-body gap for now;
or leave OpenAPI export out of Milestone B. I installed nothing in the repository and will not until you decide.
