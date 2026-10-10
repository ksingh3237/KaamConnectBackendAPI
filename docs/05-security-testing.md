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
| **Unit** | Pure logic: phone normalisation, OTP generate/verify/lockout, haversine+ETA, money sums, savings & earnings math, cursor encode/decode, **job state machine table**, DTO validation edge cases (e.g. `fee=0`, `radius=5`, 3 trades) | Jest + ts-jest | Fast, no DB. Services unit-tested with a mocked `PrismaService` only where logic branches (OTP, token rotation) |
| **Integration / e2e** | Full HTTP → Nest → real PostgreSQL | Jest + supertest + dedicated `KaamConnect_test` database (local PostgreSQL, D-1), `prisma migrate deploy` in global setup, `TRUNCATE … CASCADE` between tests, factory helpers | Real DB is mandatory: partial unique indexes, CHECK constraints and the accept-offer race are DB behaviours |
| **Real-time** | Connect with valid/expired/forged JWT; non-participant cannot `job:watch`; `offer.new` reaches only the job's customer; `lead.new` reaches only matching workers and never a direct job; `location:update` from a non-assigned worker is ignored; throttling | Jest + `socket.io-client` against the running app and the real test DB | Events asserted via the real gateway; business tests use a recording `RealtimePublisher` fake |
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
