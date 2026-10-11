# 05 · Security & Testing

## 1. Threat-driven security plan

| Area | Risk | Control |
|---|---|---|
| **OTP login** | Brute force of 6-digit code; SMS pumping / cost abuse; account enumeration | 6-digit CSPRNG code (`crypto.randomInt`), HMAC-SHA256 hash with pepper, TTL 5 min, **max 5 verify attempts** per challenge, new request invalidates older challenge, 30 s resend cooldown, ≤ 5 requests/phone/hour, ≤ 20/IP/hour, constant-time compare, identical 202 response whether or not the user exists, optional CAPTCHA/Play Integrity later if abuse appears |
| **Dev-only switches** | Fixed OTP or auto-approval of workers leaking into production | `OTP_DEV_BYPASS`, `SMS_PROVIDER=console` and `WORKER_VERIFICATION_MODE=auto` are honoured only when `NODE_ENV !== 'production'`; env validation **fails boot** if any is set in production (D-2, D-4) |
| **WebSockets** | Unauthenticated sockets; joining other users' rooms; event flooding; private fields leaking via events | JWT checked in the handshake (expired → refused); rooms are server-assigned, `job:watch` verifies ownership/assignment; per-socket rate limit; event payloads built by the same role-shaped mappers as REST; CORS/origin allow-list for the handshake; no secrets or addresses in payloads; sockets disconnected when a user is deactivated or logs out |
| **Direct booking abuse** | Customer spamming one worker; worker ignoring requests | Per-customer cap on pending direct requests (e.g. 3), `DIRECT_ACCEPT_TTL_MIN` expiry, declines/expiries recorded |
| **Sessions** | Token theft, replay | Access JWT 15 min; refresh opaque 256-bit, stored hashed, rotated on use; reuse of an old refresh token revokes the whole family; logout revokes; client stores tokens in `expo-secure-store` |
| **AuthZ / IDOR** | Reading or mutating another user's job, offer, bill | Ownership predicates inside every service query (`where: { id, customerId }`), 404 for foreign ids, role-shaped DTOs (privacy matrix in `03-api-spec.md §3`), tests per endpoint (§3) |
| **Mass assignment** | Client sets `status`, `workerId`, `ratingSum` | `whitelist + forbidNonWhitelisted`; DTOs never mirror DB models; server-only fields set in services |
| **Money integrity** | Tampered amounts | Client never sends totals; `Payment.amount` = Σ bill items; CHECK constraints; integers only |
| **Arrival code** | Guessing 4-digit code | Max 5 attempts then locked; code not exposed to worker; compare constant-time |
| **Aadhaar documents** | Sensitive identity data breach | Do **not** store the Aadhaar number (A-6); images in a **private** bucket with server-side encryption (SSE-KMS or provider equivalent), never returned by customer/worker APIs, admin access through 5-min signed URLs with an audit log line; presigned PUT limited by content-type and size; plan retention/deletion (delete images after verification decision if legally allowed). *Legal check needed: Aadhaar collection/storage rules and UIDAI integration eligibility* |
| **PII exposure** | Worker phones scraped; customer addresses leaked | Discovery routes authenticated + throttled; address/phone gating by job state (matrix); phones masked in logs |
| **Uploads** | Malicious files, oversized uploads, key forgery | Allow-listed MIME + size at presign; keys namespaced by user and verified before attaching to a job/profile; separate buckets (public-read-by-signed-url vs private); no server-side processing of untrusted files in v1 |
| **Transport / headers** | Sniffing, XSS in docs | TLS only (terminate at host), `helmet`, CORS allow-list (Expo web dev origin only), Swagger disabled in production, body size limit 1 MB |
| **Abuse** | Spam jobs/offers | Throttler defaults + per-user caps (e.g. ≤ 10 open jobs per customer, ≤ 30 offers/hour/worker); job TTL |
| **Secrets** | Leaked keys | `.env` git-ignored, `.env.example` keys only, validated at boot, secrets from host secret store in prod, rotation procedure documented, `JWT_ACCESS_SECRET` ≥ 32 bytes |
| **Logging** | PII/OTP in logs | Redaction interceptor; OTP only logged by the `console` sender in dev |
| **DB** | Over-privileged app user | App role has DML only; migrations run with a separate DDL role in CI/CD; backups encrypted; connection via TLS |
| **Dependencies** | Supply chain | Lockfile committed, `npm audit` + Dependabot/Renovate in CI, pin `prisma`/`@prisma/client` to 7.10.x (see `02-database.md §7`) |
| **Privacy law** | DPDP Act 2023 obligations | Consent captured (`termsAcceptedAt`), purpose limitation, deletion path. **Account deletion is not in the current UI but store policies generally require it** → add `DELETE /me` (anonymise PII, keep job/payment rows for records) in Phase 7 if you agree (Q-17). Validate with counsel |
| **SOS** | Alert goes nowhere | `sos_alerts` row + notification to a configured channel (email/webhook) so someone acts; define the safety-desk owner (Q-10) |

## 2. Authorization matrix (summary)

| Capability | Public | Customer | Worker (unverified) | Worker (verified) | Admin |
|---|---|---|---|---|---|
| OTP request/verify, refresh | ✔ | | | | |
| Catalog/locations | | ✔ | ✔ | ✔ | ✔ |
| Customer profile & addresses | | own | | | read |
| Worker profile & docs | | | own | own | ✔ |
| Browse workers; request a direct booking | | ✔ | | | |
| Accept / decline a direct request addressed to them | | | | ✔ (target only) | |
| Post / cancel job, accept offer, approve bill, pay, review | | own jobs | | | |
| View leads, send quote | | | ✘ (403 `NOT_VERIFIED`) | ✔ | |
| Arrival, bill items, complete work, GPS | | | | assigned jobs only | |
| Verify/reject workers, SOS triage | | | | | ✔ |

## 3. Testing strategy

| Layer | Scope | Tooling | Notes |
|---|---|---|---|
| **Unit** | Pure logic: phone normalisation, OTP generate/verify/lockout, haversine+ETA, money sums, savings & earnings math, cursor encode/decode, **job state machine table**, DTO validation edge cases (e.g. `fee=0`, `radius=5`, 3 trades) | Vitest | Fast, no DB. Services unit-tested with a mocked `PrismaService` only where logic branches (OTP, token rotation) |
| **Integration / e2e** | Full HTTP → Nest → real PostgreSQL | Vitest + supertest + dedicated `KaamConnect_test` database (local PostgreSQL, D-1), `prisma migrate deploy` in global setup, `TRUNCATE … CASCADE` between tests, factory helpers | Real DB is mandatory: partial unique indexes, CHECK constraints and the accept-offer race are DB behaviours |
| **Real-time** | Connect with valid/expired/forged JWT; non-participant cannot `job:watch`; `offer.new` reaches only the job's customer; `lead.new` reaches only matching workers and never a direct job; `location:update` from a non-assigned worker is ignored; throttling | Vitest + `socket.io-client` against the running app and the real test DB | Events asserted via the real gateway; business tests use a recording `RealtimePublisher` fake |
| **Concurrency** | Two customers' accepts / double accept same offer / two workers quoting simultaneously / double "Paid" tap | e2e with `Promise.all` | Asserts exactly one winner, siblings `REJECTED`, no duplicate payment |
| **Security** | IDOR matrix (every `:id` endpoint × wrong user → 404/403), role/verification gating, throttling returns 429, refresh-reuse revokes family, privacy matrix (no `addressLine` in lead payloads), no Aadhaar keys in any response | e2e | Table-driven so new endpoints must be added to the matrix |
| **Contract** | OpenAPI doc unchanged unless intended | CI step diffs generated `openapi.json` | Protects the mobile app |
| **Migration** | Fresh DB → all migrations → seed → app boots; and `prisma migrate diff` shows no drift vs `schema.prisma` | CI | Catches hand-edited SQL mistakes |
| **Smoke / load (light)** | `/workers`, `/leads`, `/tracking` at ~200 rps against seeded 5k workers / 50k jobs | k6 or autocannon, once before launch | Validates indexes |

Golden-path e2e (the product's core): register customer & worker → worker verified (admin) → post job → worker lead appears → quote → accept → GPS ping → tracking shows ETA → arrival code → bill → approve → complete → pay → review → ratings/earnings/savings/receipt reflect it.

Coverage target: ≥ 85 % lines on `auth`, `jobs`, `offers`, `reviews`; ≥ 70 % overall. CI gate: lint, `tsc --noEmit`, unit, e2e (Postgres service container), migration drift check, `npm audit --omit=dev` (high+), build.

## 4. API validation checks (acceptance)
- Every DTO field has a type decorator and bounds from `03-api-spec.md §4`.
- Unknown properties → 422.
- Every list endpoint caps `limit` at 50.
- Every state-changing job endpoint is covered by a state-machine test (allowed and forbidden actors/states).

## 5. Implemented so far (Phase 2) and how it is tested

| Control | Where | Test (real PostgreSQL) |
|---|---|---|
| 6-digit CSPRNG code, keyed HMAC hash with phone + pepper, constant-time compare | `otp.service.ts` | stores no plain code; wrong/unknown/expired are indistinguishable |
| 5 attempts per code, spent **before** comparing (parallel guesses cannot exceed it) | `otp.service.ts` | 12 parallel wrong guesses → exactly 5 counted |
| Per-phone advisory lock: cooldown, 5/hour cap, one live code | `otp.service.ts` | 4 simultaneous requests → 1 sent |
| Single-use code under a race | `auth.service.ts` (one transaction) | 2 simultaneous correct submits → 1 session |
| No account enumeration on code request | `otp.service.ts` | identical answers for known/unknown number |
| Access JWT HS256 only, 15 min, minimal claims; `alg:none`, wrong-secret, expired, unknown-user tokens refused | `token.service.ts`, `jwt-auth.guard.ts` | dedicated forgery test |
| Opaque refresh tokens stored as SHA-256, rotation, reuse detection revokes the login, race-safe | `token.service.ts` | replay + parallel-refresh tests |
| Global deny-by-default (`@Public()` opt-out) | `app.module.ts` | catalog and `/me` return 401 anonymously |
| Mass-assignment protection on `/me` | validation pipe + DTO | `isAdmin`, `phone`, `isActive` rejected, row unchanged |
| Per-IP rate limits on OTP/refresh | `auth.controller.ts` | 21st request in an hour → 429, other IPs unaffected |
| Dev-only OTP switches refused in production | `env.validation.ts` | boot-guard tests |
| Housekeeping of OTP/session rows | `auth-cleanup.service.ts` (hourly) | purge keeps recent, removes stale |

Known limits (accepted for v1): access tokens cannot be revoked before they expire (15 min); the JWT guard does not hit the database, so a disabled user keeps API access until the next refresh (`/me` does check `isActive`).

## 6. Implemented in Phase 3 and how it is tested

| Control | Where | Test (real PostgreSQL unless noted) |
|---|---|---|
| Upload keys: only ones this user generated, for this purpose, that exist in storage | `media.service.ts`, `media-rules.ts` | foreign, wrong-purpose, never-uploaded, path-trick keys → 422 (customer + worker suites); unit tests of the key patterns |
| Signed upload locks content type **and** size | `s3-storage.service.ts`, `dev-storage.controller.ts` | unit: `content-length` and `content-type` appear in S3 `X-Amz-SignedHeaders`; e2e: wrong type, bigger/smaller body, tampered or stretched signature → 403 |
| Aadhaar images kept in a separate private bucket, never returned to customers/workers | `media-rules.ts`, `workers.service.ts` | files land under `private/`; worker/`/me` responses never contain the key or a link; admin links expire in 5 min |
| Path traversal / arbitrary file access via the dev stand-in | `local-storage.service.ts` | strict key shape, root-prefix check; `../` and encoded variants → 404 |
| Mass assignment: status, badge, ratings, ids, `isAdmin` | validation pipe + DTOs | every protected field rejected with 422 and the row unchanged |
| IDOR on addresses | `addresses.service.ts` (all queries scoped by `customerId`) | another customer's id → 404 on PATCH/DELETE/primary, nothing changed |
| Role gating from the database (not the token) | `profile.guard.ts` | profile created / verification lost / admin revoked → effective on the next request |
| Admin API hidden | `profile.guard.ts` | non-admin, revoked admin and disabled admin all get 404 |
| Self-verification impossible | `workers.service.ts`, `worker-verification.service.ts` | PUT/PATCH with `verificationStatus` → 422; only admin (manual) or documents (auto, dev) verify |
| Evidence change re-opens review | `workers.service.ts` | replacing an Aadhaar image on a VERIFIED/REJECTED profile → PENDING |
| Prod cannot run dev shortcuts | `env.validation.ts` | `local` storage and `auto` verification refused in production |
| Timestamps are true instants on any server time zone | `src/prisma/pg-adapter.ts` | regression test: DB-side `now()`/age math agrees with the app; every pooled connection runs in UTC |

**Bug found by tests during this phase:** a customer `PUT` with no `address` crashed with a 500 (`@ValidateNested` ignores a missing value); fixed with `@IsDefined()`.

**Finding worth remembering:** Prisma's pg adapter stores timestamps shifted by the *server's* time zone when it is not UTC (this laptop's PostgreSQL is `Asia/Calcutta`: rows were 5 h 30 min off, invisible to app-only round trips). All connections now pin the session to UTC. If you ever put PgBouncer in transaction mode in front of the database, allow the `options` startup parameter (`ignore_startup_parameters = options`) or the pin is lost.

Decided but not yet built (see `01-requirements.md §11.1`): **D-8** name or photo change on a VERIFIED worker re-opens review (needs tests that an unchanged re-sent name or `photoKey` does not, and that removing the photo does not); **D-9** Aadhaar images deleted 7 days after the decision, with an S3 lifecycle hard cap (Phase 7; needs a test that the object and the row are both gone and that no key is logged); **D-10** region `ap-south-1`.
## 7. Implemented in Phase 4 and how it is tested

| Control | Where | Test (real PostgreSQL / real WebSocket) |
|---|---|---|
| Privacy by construction: address, phone and arrival code never appear in lead payloads, lead detail, `lead.new` / `direct.request` pushes, or any event a non-owner receives | `job-view.service.ts`, `leads.service.ts`, `job-events.service.ts` | string scans of every REST body and every pushed event for the address text, phone, `addressLine`, `arrivalCode` |
| Direct bookings invisible to everyone but the requested worker | `leads.service.ts`, `offers.service.ts`, `job-view.service.ts` | other plumbers get nothing from feed, detail, quote, job view, or sockets |
| "Not yours" is indistinguishable from "does not exist" | all job/lead/offer lookups | stranger, wrong trade, wrong city, unknown id → identical `404` |
| One winner when several parties act at once | conditional `UPDATE … WHERE status='OPEN'` is the lock (`offers.service.ts`, `direct-booking.service.ts`, `jobs.service.ts`, `job-expiry.service.ts`) | 2 and 5 simultaneous accepts, accept vs cancel, accept vs decline, duplicate quotes, 2–3 concurrent sweepers |
| No waiting quote can survive on an assigned job | share-lock of the job row while quoting + reject-all inside accept | 6 workers quoting while the customer accepts: every late quote is rejected or refused |
| Expired requests cannot be accepted or quoted even before the sweeper runs | `expires_at` checked in the same statement | backdated `expires_at` → `409`, nothing changed |
| State machine is the only way status changes | `job-state-machine.ts` | unit test walks every action × every status (all 10 actions, 7 statuses) |
| Abuse limits | 10 open requests, 3 pending direct requests per customer; 20 WebSocket messages/s; 16 KB frames | each limit has a test |
| WebSocket authentication and authorisation | `realtime.gateway.ts` | forged / unsigned / expired / unknown / disabled users refused; sockets close at token expiry; `job:watch` only for owner, assigned or requested worker; rooms cannot be joined by name |
| Mass assignment on job and quote bodies | validation pipe + DTOs | `status`, `workerId`, `expiresAt`, `jobNumber`, `customerId` etc. → `422`, row unchanged |
| A user holding both profiles never sees or quotes on their own requests | `leads.service.ts`, `offers.service.ts`, `matching.service.ts` | feed, notified count, quote (`403 OWN_JOB`), discovery |

**Findings during this phase**
- **Real bug found by the benchmark, fixed:** discovery took the first 500 workers (by id) *before* applying the coverage filter, so with 5,000 workers most never appeared. It now filters all candidates first and loads card data only for the returned page. A regression test pages through all 1,500+ covering workers and checks none are missing.
- Both candidate sets (discovery, matching) have a 20,000-worker safety cap that logs a warning if ever reached, because the answer would then be incomplete. The lead feed considers the newest 500 open jobs of a worker's trades; older ones are dropped beyond that (unrealistic for one metro).
- `pg` prints "Calling client.query() when the client is already executing a query is deprecated" during some transactions. The stack is entirely inside Prisma's query runtime and `@prisma/adapter-pg`, not our code; it becomes an error in `pg@9`, so keep `pg` on 8.x until Prisma ships a fix.

**Launch-scale benchmark** (`npm run test:perf`, 5,000 verified workers, 50,000 jobs in `KaamConnect_test`, PostgreSQL 18 on the dev laptop, sequential requests, 40 samples)

| Endpoint | p50 | p95 | Budget |
|---|---|---|---|
| `GET /workers` (all trades, 5,000 workers considered) | 61 ms | 94 ms | 300 ms |
| `GET /workers?categoryId=plumber&sort=rating` | 18 ms | 24 ms | 300 ms |
| `GET /leads` | 12 ms | 22 ms | 300 ms |
| `GET /customers/me/jobs` | 7 ms | 7 ms | 300 ms |
| `POST /jobs` (finds and notifies 244 matching plumbers) | 44 ms | 52 ms | – |
| 20 simultaneous `GET /workers` | 1.0 s wall | – | – |
| Lead-feed SQL (`EXPLAIN ANALYZE`) | 0.4 ms, `Index Scan` on `jobs_status_expires_at_idx` | – | no seq scan |

Reading the last two lines honestly: discovery and notification filtering run in application code, about 40–60 ms of CPU per request over 5,000 workers. By extrapolation from the 20-simultaneous-requests run, one server handles roughly 20 such requests per second before queueing. That is fine for launch, and it is the first thing to move into SQL / a cache (the Redis seam) if traffic grows.

## 8. Scheduling and availability: controls and how they are tested

All of this is in `test/scheduling.e2e-spec.ts` (real PostgreSQL, real WebSockets) unless another file is named; the pure rules are unit-tested in `src/modules/scheduling/*.spec.ts`, `matching/*.spec.ts` and `offers/lead-catch-up.service.spec.ts`.

| Control | Where | Test |
|---|---|---|
| A busy worker is never starved of leads (BR-1, BR-2) | `job-events.service.ts`, `leads.service.ts` | worker with a job in progress still receives `lead.new`, sees it on the radar, can open it, decline it, and is offered a later job |
| Cannot double-book (BR-14, BR-16) | `availability.service.ts` | overlap, travel gap (with and without coordinates), immediate vs upcoming booking, overrunning job, quote revision |
| Confirmation is race-safe | per-worker advisory lock in `reserve` | 2 and 6 simultaneous accepts: exactly one wins, the rest get `409 WORKER_UNAVAILABLE`; a travel-gap race (which the database cannot see) also has one winner. **Mutation check:** with the lock removed that last test fails with `[200, 200]` |
| Database backstop (BR-17) | `jobs_worker_no_overlap`, `jobs_one_in_progress_per_worker` and CHECKs | direct inserts are rejected by name; back-to-back, other workers, and finished jobs are allowed; the real Prisma error is mapped to the same `409` |
| Five states are separate and ordered (BR-18) | `offers.service.ts` | delivered ≤ answered ≤ quoted ≤ accepted ≤ confirmed timestamps; each has its own event; `offer.accepted` arrives before `booking.confirmed` |
| No duplicate leads (BR-22) | `lead-delivery.service.ts` | one `lead.new` per worker; `claim` returns only new rows; catch-up never repeats a lead; a declined lead is not re-sent; a direct request is not re-sent |
| Location rules (BR-19 to BR-21) | `matching.service.ts`, `lead-catch-up.service.ts` | near-term job by live GPS, future job by base area; wider radius only for future work; catch-up after a move; `location.refresh` after a cancelled assignment |
| Input validation | `schedule-time.ts`, DTOs | 11 invalid `scheduledFor` / `durationMin` cases → `422` naming the field, nothing stored |
| Privacy unchanged | `leadPayloadOf` | string scan of pushes for scheduled work: no address, phone or arrival code |
| Access | `ProfileGuard`, `visibleLead` | anonymous 401; customer 403; unverified worker `NOT_VERIFIED`; wrong trade 404; `/workers/me/schedule` shows only your own bookings and works under review |

**Findings during this work**
- The first draft compared consecutive location fixes to decide when to look for new leads. A moving worker's consecutive fixes are always close together, so that would never have triggered. It now compares with the place leads were *last matched*, plus a one-minute floor.
- Existing tests that moved jobs to `ASSIGNED`/`COMPLETED` by hand now need a booking window, because the database refuses an assigned job without one. That is the new rule working, not a regression; `test/helpers/factories.ts` supplies the window.
- A scheduled job's default expiry changed from "24 h" to "until its appointment (max 72 h)". Jobs without an appointment time are unchanged.

## 9. Phase 5 (fulfilment): controls and how they are tested

Tests: `test/phase5-requirements.e2e-spec.ts` (27), `test/fulfilment.e2e-spec.ts` (34), unit specs next to the code (`trip`, `open-until`, `sameCode`, `safety-notifier`, `db-errors`, env), plus the extended built-app smoke test.

| Control | Where | Test |
|---|---|---|
| Ownership decides access, verification does not (D-8) | queries in `fulfilment/*`, `@RequireProfile('worker')` | a PENDING or REJECTED worker completes the whole journey; a stranger gets 404 on 9 routes; the job's own customer acting through a worker profile gets 404; an access matrix over all 11 routes (anonymous 401, outsider 404, unknown id 404, nothing changed) |
| Only the customer approves and pays | `@RequireProfile('customer')` + `customerId` in the query | assigned worker 403, stranger customer 404, a person with both profiles 404; no payment row created |
| Arrival code (see §10 for recovery) | `arrival.service.ts` | constant-time compare; the code is never in the worker's views or events; 4 wrong then the right one works; 5 wrong lock; 10 parallel wrong guesses ≤ 4 refusals and exactly 5 attempts stored |
| One job on site | friendly check + `jobs_one_in_progress_per_worker` | refused without using a try; two simultaneous arrivals give exactly `[200, 409]`; the real database error is recognised by the same detector |
| Bill integrity | `bill.service.ts` | replace-not-append; frozen after approval; `expectedTotal` required; an edit racing an approval cannot both succeed; the visit fee survives every edit; 9 invalid item shapes rejected |
| Money | `payment.service.ts` | amount never taken from the app; idempotent; 10 simultaneous taps → one `payments` row; receipt total = Σ items, platform fee 0, no address/phone |
| Photos | `bill.service.ts` | only the worker's own `WORK_PROOF` uploads, only while on site, max 5 per kind, duplicates ignored |
| Tracking honesty | `trip.ts` | no coordinates → `distanceKm`/`etaMinutes` null and `distanceBasis` null; area centre labelled; stale after 2 min; no distance from a fix older than 30 min |
| Live location | gateway `location:update`, `TrackingService` | only the worker's own job under way; bad payloads `INVALID`; throttled; `job.location` only to watchers and only before arrival |
| SOS | `safety/*` | stored first; webhook failure still 201 and logged; double tap → one alert and one page; location labelled REPORTED / LAST_WORKER_FIX (with age) / null; both-or-neither coordinates; only the two parties; webhook client tested against a mocked `fetch`; production needs an https URL |
| Back-out | `worker-backout.service.ts` | every cleared column asserted; no OPEN job keeps a worker or window (SQL check); rejected quotes stay rejected; backed-out worker blocked from quoting/accepting; **lead re-sent exactly once per re-open** (two successive re-opens counted), decliner and backed-out worker excluded, catch-up adds nothing; direct booking cancelled with its window no longer blocking |
| Privacy | views, events | no address/phone/code in any pushed event over the whole journey; a worker loses the address of a CANCELLED job and the backed-out worker's response has none |
| Service duration | admin route | admin-only (404 for others, 401 anonymous), validated, only affects new jobs |

**Mutation check.** The tests were not trusted on a green run. Six deliberate breakages were applied one at a time and the matching test was run: back-out not resetting the lead guard, back-out leaving the booking window, completion not calling `workerFreed`, completion ignoring job ownership, worker routes requiring verification again, a backed-out worker allowed to quote again. **All six were caught.** The code was restored afterwards.

**Findings during this phase**
- **The lead guard would have hidden re-opened requests.** This was found while writing the requirements (every covering worker already had a delivery row and had been told the lead closed), written up as a requirement, then fixed and covered by a regression test.
- A worker whose quote lost could never quote again on a re-opened request (the old rule allowed re-quoting only after a withdrawal). Now a rejected or withdrawn quote can be sent again, except for the worker who backed out.
- `POST /jobs/:id/cancel` used to be customer-only. It now dispatches on ownership; for strangers the old answers are kept (403 without a customer profile, otherwise 404) so no existing test or client changes.
- An assigned worker used to keep seeing the address of a job after it was cancelled; now they do not.
- The first run of the new suite had two failures, both in my test set-up (a worker cannot take two overlapping immediate jobs, which is the scheduling rule working), not in the product.

**Not tested, honestly:** the webhook against a real receiver; GitHub CI; behaviour under a real multi-instance deployment (still single instance).

## 10. Arrival-code recovery and Phase 6: controls and how they are tested

Files: `test/arrival-code-reset.e2e-spec.ts` (16 tests), `arrival-code-reset.service.spec.ts` (8), `test/db-constraints.e2e-spec.ts` (6 of its 22 are about the audit table and the new CHECK), `test/phase6.e2e-spec.ts` (23), `earnings/ist-time.spec.ts` (4), `earnings/earnings.service.spec.ts` (3).

### 10.1 Arrival-code reset

| Control | Where | Test |
|---|---|---|
| Authorization: only the job's own customer | `customerId` in the conditional `UPDATE`; `@RequireProfile('customer')` | no token 401; a worker 403; a stranger and an unknown id 404; the job's own worker, even holding a customer profile, 404; nothing changes and nothing is audited |
| Only while the worker is on the way | `status = 'ASSIGNED'` in the same `UPDATE` | OPEN, on-site and cancelled jobs 409; code and counter unchanged |
| Cap: 3 per assignment, however long the wait | `arrival_code_resets < 3` in the same `UPDATE` | the 4th is `429 RESET_LIMIT` after the cooldown was skipped; the counter stays 3; at the cap a locked worker is stuck on this assignment but can still back out |
| Cooldown: 60 s | `arrival_code_reset_at` in the same `UPDATE` | a second tap is `429 RESET_COOLDOWN` with `retryAfterSec` 1-60; five simultaneous taps give exactly one 200 and one counted reset |
| A reset racing a guess | one conditional `UPDATE` per side | eight parallel wrong guesses plus a reset: the reset succeeds, the counter ends at most 5, the job stays ASSIGNED |
| New code differs; old code dies; counter restarts | `arrival_code IS DISTINCT FROM` the new one; `arrival_attempts = 0` | the old code is then a normal 422 (not locked); the new code arrives the worker |
| Guess budget stays bounded | cap x tries | 5 tries x (1 + 3 resets) = 20 guesses of 10,000 per assignment (0.2 %) |
| Audit trail without secrets | `job_security_events` (append-only) | `ARRIVAL_LOCKED` (worker), `ARRIVAL_CODE_RESET` (customer, same transaction), `ARRIVAL_RESET_REFUSED` (deduplicated to one per minute); the table has no column that can hold a code; neither code appears in the dump of the rows |
| The code is never pushed | `job.arrival_code_reset` carries only `{jobId}` | the pushed events never contain the new code |
| A new assignment starts clean | worker back-out clears the counters | after back-out the job is OPEN with counter 0 and no cooldown, and the audit rows remain |
| Per-address backstop | `@Throttle` 20 / hour on the route | the 21st call from one address is refused with the generic `429 TOO_MANY_REQUESTS` before it reaches the service, another address still reaches it, and nothing changes (the per-job limits remain the real control) |
| Lock audit under parallel guesses | `arrival.service.ts` | ten simultaneous wrong guesses lock the job once and write exactly one `ARRIVAL_LOCKED` event (attempts stored: 5) |
| Direct-booking jobs | same reset path | a direct booking the worker accepted can be locked, reset and arrived at, with the same audit rows |
| Who hears about a reset | `JobEventsService.arrivalCodeReset` | only the assigned worker gets `job.arrival_code_reset`; the customer, a stranger and an unrelated worker get none, and the new code is in nobody's pushes |
| `RESET_FAILED` and the redraw | `ArrivalCodeResetService.reset` | unit tests with a stubbed database: three repeated codes in a row give `503 RESET_FAILED` and change, audit and push nothing; a repeat followed by a good code succeeds on the second draw; an unknown job is a 404 with no redraw |
| Database integrity of the new objects | migration `20261011150000_arrival_code_reset` | the counter cannot be negative; an audit row needs an existing job; a job that has audit rows cannot be deleted (`ON DELETE RESTRICT`); deleting the actor keeps the row and blanks the actor (`ON DELETE SET NULL`); only the three event types can be stored |

**Lockout implications.** A worker who fills the five tries is locked until the customer issues a new code. The customer can do that three times per assignment. If the third code is also locked, the only exits are the customer cancelling or the worker backing out. A customer who never opens the app can leave a worker locked; the worker can back out. There is deliberately no time-based unlock and no worker-side or admin-side unlock.

### 10.2 Reviews, earnings, savings (Phase 6)

| Control | Where | Test |
|---|---|---|
| Review: owner only, once, after payment | ownership in the query; status check; unique index `reviews_job_id_key` | stranger / the job's own worker / unknown id 404; worker without a customer profile 403; OPEN, WORK_COMPLETED and CANCELLED 409; second review 409 and totals unchanged; ten simultaneous taps give one review |
| No lost ratings | one transaction; `SET x = x + n` | twelve customers rate one worker at once: all counted, and `rating_sum` / `review_count` equal the sum and count of the rows |
| Input | `CreateReviewDto` | 12 invalid bodies are 422 (rating 0/6/4.5/text, unknown or duplicate tag, negative/over-5000/fractional tip, a free-text comment); nothing stored; the edge values 1, all five tags and a 5000 tip are accepted |
| Tip is record-only | not in `payments` or earnings | the payment amount and the worker's earnings are unchanged by a tip |
| Reviewer privacy | `WorkerReviewSummary` | the public summary has exactly `rating`, `tags`, `createdAt` per entry: no name, no id |
| Earnings | `EarningsService` | only this worker's COMPLETED jobs inside the IST period; a stray payment on a not-completed job does not count (mutation-checked); a payment 1 ms before midnight IST belongs to yesterday, one exactly at midnight to today; week starts Monday; verification not required; customer 403 |
| Savings | `EarningsService.savings` | only the caller's own COMPLETED jobs, as customer or as worker; tips excluded; default role customer; rate disclosed |
| Day boundaries | `istRange` | unit tests around 23:59:59.999 / 00:00 IST, Sunday night to Monday, month end, December |

Review follow-up, 2026-10-11: the tests added after the code review were mutation-checked as well. Changing the earnings upper bound from `<` to `<=`, auditing the lock on every refusal, removing the per-address throttle and also pushing the reset to the customer each made a test fail; so did shortening the redraw loop and removing the refusal explanation (unit tests). The database constraints cannot be mutated through code, so the CHECK and the two foreign keys were changed on the **test database only** (CHECK dropped; each key made `ON DELETE CASCADE`), each change made one test fail, and the original definitions were then restored and compared: identical.

Mutation checks run on 2026-10-11: removing the reset cap, the cooldown or the owner check, and for Phase 6 removing the review ownership check, the totals update, the IST offset and the COMPLETED filter in earnings and in savings, each made at least one test fail; the code was restored each time.

## 11. SOS delivery: agreed requirements (nothing below is built or enabled)

**Status:** pending your decisions. No receiver has been chosen, no on-call person has been named, and no vendor is selected here. Production SOS stays disabled: the application refuses to start in production without an https `SOS_WEBHOOK_URL`, and real delivery has never been tested against a real receiver. These are the requirements agreed so far; each must be met before SOS is enabled.

| Area | Requirement |
|---|---|
| **Receiver and people** | A receiver that can page a human and record an acknowledgement is **to be chosen** (a paging service, a chat channel as a secondary copy only, or a duty phone). A **named primary and backup on-call person**, 24/7 including holidays, and an **escalation policy** (who is called when an alert is not acknowledged, and after how long) are **to be decided** and written into a runbook. Nothing in this repository names them |
| **Runbook** | Who calls the customer and the worker, when to contact emergency services, who owns follow-up, and how an alert is closed |
| **Acknowledgement** | Two levels: the receiver acknowledging that a person has the alert, and the platform recording the outcome through an admin route (`PATCH /admin/sos/:id`) that also notifies the person who raised it with `sos.acknowledged`. Neither exists yet. A 2xx from the receiver alone means only "received" |
| **Retry handling** | Delivery state kept with the alert (status, attempts, next attempt, last error, never the payload); a sweeper that is safe across instances; backoff of 30 s, 1 min, 2 min, 5 min, then every 10 min for about an hour; retry on network errors, timeouts, 5xx and 429; any other 4xx is a permanent failure; the alert id is the idempotency key so the receiver can de-duplicate. Needs a migration, to be reviewed first |
| **Failure visibility** | The alert is always stored first and the SOS request never fails because of the receiver. When retries run out the alert is marked as failed delivery and logged at error level. An admin view lists alerts that are undelivered or unacknowledged for too long; an optional second channel is used if the first fails. The app must still show an emergency-number fallback (frontend work) |
| **Data minimisation** | Send the receiver the least it needs: alert id, job reference, who raised it, the phone numbers, a location label and a link to a protected admin page for the address. Do not put the full address and other personal data in a third-party service by default. Never log the full payload |
| **Secrets and authenticity** | Receiver keys and the request-signing secret come only from environment variables or a secrets manager, never from the repository; production requires the signing secret; each request carries a timestamp and an HMAC signature so the receiver can reject forged or replayed alerts |
| **Verification** | Mock-receiver tests (200, 500, timeout, 4xx, slow) prove our behaviour but not real delivery. Real delivery is claimed only after a **clearly labelled test alert with fake data** reaches a receiver you own and authorise, and is then repeated on a schedule |
