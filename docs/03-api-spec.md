# 03 · API Specification

REST/JSON, base path `/api/v1`, OpenAPI generated from the DTOs (`/api/docs`, disabled in production). Priorities: **P1** needed for the core flow, **P2** needed by an existing screen but not on the critical path, **P3** nice-to-have.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <accessToken>` on everything except `Public` routes |
| Active role | **Not** sent by the client. A user may hold both profiles, so role-specific resources live under `/customers/me/*` and `/workers/me/*`; guards check the profile exists and ownership |
| IDs | UUIDv7 strings, except `areaId`/`cityId` (int) and `categoryId` (string key e.g. `plumber`) |
| Money | Integer INR (`visitFee: 250`). Never floats |
| Time | ISO-8601 UTC. Client formats "4 mins ago" / "Today at 11:30" |
| Phone | Request: `"98765 43210"` or `"+919876543210"` accepted, normalised to E.164 |
| Pagination | `?limit=20&cursor=<opaque>` → `{ items: [], nextCursor: string \| null }` |
| Errors | `{ "statusCode": 422, "code": "VALIDATION_FAILED", "message": "…", "details": [{ "field": "fee", "issue": "must be > 0" }] }`. Codes are machine-readable; user text stays in the app (en/hi/pa) |
| Status codes | 200/201/204 · 400 malformed · 401 unauthenticated · 403 wrong role/not owner · 404 (also used instead of 403 to avoid leaking existence) · 409 state conflict · 422 validation · 429 throttled |
| Idempotency | `PUT` upserts are idempotent; create-job accepts optional `Idempotency-Key` header (double-tap on "Broadcast") |
| Request id | Every response carries `X-Request-Id`. A plain value sent by the client or a proxy (8 to 64 characters of letters, digits, `.`, `_`, `-`) is kept; anything else is replaced by a new UUID. Quote it when reporting a problem: it is in the server's request log line and in the log line of any 5xx error |

## 2. Endpoints by screen

### 2.1 Auth (Login, OTP, Profile→Logout) — P1

| Method & path | Auth | Body → Response |
|---|---|---|
| `POST /auth/otp/request` | public, throttled | `{ phone, channel?: "SMS"\|"WHATSAPP" }` → `202 { resendAfterSec: 30, expiresInSec: 300 }`. Always 202 (no account enumeration) |
| `POST /auth/otp/verify` | public, throttled | `{ phone, code }` (6 digits) → `{ accessToken, refreshToken, expiresIn, isNewUser, user: { id, phone, language, hasCustomerProfile, hasWorkerProfile } }`. Wrong/expired → `401 OTP_INVALID`; too many tries → `429 OTP_LOCKED` |
| `POST /auth/refresh` | public | `{ refreshToken }` → new pair (rotation; reuse ⇒ whole family revoked) |
| `POST /auth/logout` | auth | `{ refreshToken }` → `204` |

Validation: `phone` matches `^(\+91)?[6-9]\d{9}$` after stripping spaces (Q-12); `code` `^\d{6}$`.
Screen mapping: Login "Get OTP" → request; OTP "Verify & Continue" → verify; "Resend OTP Now" → request again (server enforces 30 s cooldown, UI shows 28 s); "Get OTP on WhatsApp" → request with `channel=WHATSAPP`; Profile "Log Out" → logout.
The "Audio code help" button reads the code aloud on-device; no endpoint.

### 2.2 Account & settings — P1/P2

| Method & path | Auth | Notes |
|---|---|---|
| `GET /me` | auth | `{ id, phone, language, customer: {…}\|null, worker: {…, verificationStatus}\|null }` → Profile screen, app bootstrap |
| `PATCH /me` | auth | `{ language: "en"\|"hi"\|"pa" }` → Language screen (P1) |
| `GET /me/savings` | auth | `{ commissionSaved: 4200, benchmarkRate: 0.2, currency: "INR" }` for the Profile card. KaamConnect charges 0 %; the figure is what the same jobs would have cost at a competitor commission of `COMMISSION_BENCHMARK_RATE` (D-5, default 20 %). Computed per BR-11 (P2) |
| `GET /config` | auth | `{ supportPhone, avgSpeedKmh?, otpResendSec }` — single source for the 2 helpline numbers (P3) |

### 2.3 Reference data (Customer onboarding chips, Home, Leads directory) — P1

> Built in Phase 1. Public until Phase 2 adds the global JWT guard, after which they require login. Response `Cache-Control: private, max-age=300` + ETag.

| Method & path | Response |
|---|---|
| `GET /locations` | `[{ id, name: "Chandigarh", areas: [{ id, name: "Sector 22" }] }]` — cacheable, `ETag` |
| `GET /service-categories` | `[{ id: "plumber", title: { en, hi, pa }, iconKey: "Droplet", color, bgColor, baseVisitFee: 200, examples }]` — cacheable |

### 2.4 Customer profile (Customer onboarding, Profile→Addresses) — P1

| Method & path | Notes |
|---|---|
| `PUT /customers/me` | Upsert. Body below. `fullName` required (maps the UI's blank-name error) |
| `GET /customers/me` | Profile + addresses |
| `GET /customers/me/addresses` · `POST` · `PATCH /:id` · `DELETE /:id` · `POST /:id/primary` | P2 – Profile menu "Saved Tricity Addresses"; v1 UI only edits the primary one |

```jsonc
// PUT /customers/me
{
  "fullName": "Sunita Sharma",           // 1–80 chars, trimmed, required
  "photoKey": "u/…/avatar.jpg",          // optional, from /media/presign
  "commLanguage": "hi",                  // en|hi|pa
  "allowDirectCalls": true,
  "address": { "areaId": 2, "line": "House #1402, Near Subhash Park", "lat": 30.73, "lng": 76.78 } // lat/lng optional (GPS detect)
}
```

### 2.5 Worker profile (Worker onboarding) — P1

| Method & path | Notes |
|---|---|
| `PUT /workers/me` | Upsert. Sets `verificationStatus=PENDING` on first save (or when a rejected profile is re-submitted). With `WORKER_VERIFICATION_MODE=auto` (dev only, D-4) the worker is set `VERIFIED` as soon as both Aadhaar images are present; in `manual` mode (production) only an admin can verify |
| `GET /workers/me` · `PATCH /workers/me` | Profile + verification state + trades + documents status (never document URLs) |
| `PUT /workers/me/documents/:type` | `type = AADHAAR_FRONT\|AADHAAR_BACK`, body `{ key }` — each box uploads separately |
| `PUT /workers/me/location` | `{ lat, lng }` GPS ping every ~10 s while a job is ASSIGNED/ARRIVED (P1). Also accepted as socket event `location:update` (§6). Server throttles to 1 accepted fix per 3 s per worker and rebroadcasts to the job room |
| `GET /workers/me/earnings?period=today` | `{ amount: 1450, jobsDone: 4, platformFee: 0 }` – IST day (P2) |

```jsonc
// PUT /workers/me
{
  "fullName": "Rajesh Kumar",
  "photoKey": "u/…/avatar.jpg",
  "trades": ["electrician", "appliance"],   // 1–2 valid category ids; first = primary
  "experienceYears": 8,                     // 1–40
  "skills": ["Wiring", "MCB Box Repair"],   // ≤ 15 items, each ≤ 40 chars, de-duplicated
  "languages": ["hi", "pa"],                // ≥ 1
  "baseAreaId": 3,
  "radiusKm": 6,                            // 3 | 6 | 12
  "upiId": "rajesh@okaxis",                 // optional now; required before settlement QR works (G-3)
  "vehicle": "Hero Splendor (CH 01 BG 4590)", // optional (G-4)
  "visitingFee": 200,                       // optional (G-6, Q-6)
  "termsAccepted": true                     // must be true (maps the agree checkbox)
}
```

### 2.6 Media uploads (photos, voice note, Aadhaar) — P1

| Method & path | Notes |
|---|---|
| `POST /media/presign` | `{ purpose: "PROFILE_PHOTO"\|"JOB_PHOTO"\|"JOB_VOICE"\|"WORK_PROOF"\|"AADHAAR", contentType, sizeBytes }` → `{ uploadUrl, key, expiresInSec: 300 }`. Allow-list: images ≤ 5 MB (`jpeg/png/webp`), audio ≤ 2 MB (`audio/mp4`, `audio/aac`, `audio/mpeg`), Aadhaar → private bucket. Keys are namespaced `u/<userId>/…`; later requests that reference a key are rejected if the prefix isn't the caller's |

Reads: responses embed short-lived signed GET URLs (`photoUrl`, `voiceNoteUrl`, 10 min). Aadhaar keys are never returned by any non-admin endpoint.

### 2.7 Discovery (Home) — P1

| Method & path | Notes |
|---|---|
| `GET /workers?categoryId=&areaId=&sort=distance\|rating&limit=&cursor=&q=` | Customer only. Only `VERIFIED`. Item: `{ id, name, trade, tradeId, areaName, distanceKm, rating, reviewsCount, visitingFee, etaMinutes, badge, experienceYears, vehicle?, skills[], photoUrl, phone }`. `phone` is exposed because "Call Directly" is a core feature (Q-16); route is rate-limited. `q` free-text search is P3 (search bar is not wired in the app) |
| `GET /workers/:id` | Detail + latest 10 reviews summary (P2) |
| `POST /jobs/direct-booking` | "Book Pro": request a specific worker, who must accept (D-3) – see 2.8 |

### 2.8 Jobs – customer side (Post Job, Compare Offers, Tracking) — P1

| Method & path | Auth | Notes |
|---|---|---|
| `POST /jobs` | customer | Body below → `201 { id, jobNumber, status: "OPEN", notifiedWorkers: 24 }`. Rejects unknown category/area (422). Sets `expiresAt = now + JOB_OPEN_TTL_HOURS` |
| `GET /customers/me/jobs?tab=ongoing\|completed\|cancelled` | customer | Activity tabs + counts in `meta.counts` (the "Cancelled (0)" label) |
| `GET /jobs/:id` | job's customer or assigned worker | Role-shaped view (§3) |
| `GET /jobs/:id/offers` | customer owner | Compare screen: `[{ offerId, visitFee, etaMinutes, message, isFastest, worker: {…card…} }]` sorted by fee/eta. Live updates: socket event `offer.new` / `offer.updated` (§6) |
| `POST /jobs/:id/offers/:offerId/accept` | customer owner | `409 JOB_NOT_OPEN` if raced. Returns `{ status: "ASSIGNED", arrivalCode: "8421" }` |
| `GET /jobs/:id/tracking` | customer owner (assigned worker may read too) | `{ status, worker: {name, trade, vehicle, phone, verified}, location: {lat,lng,updatedAt}\|null, distanceKm, etaMinutes, arrivalCode (customer only) }`; initial state on screen open, then live via `job.location` / `job.status` events (§6) |
| `POST /jobs/:id/cancel` | customer owner (OPEN/ASSIGNED) | `{ reason? }` → CANCELLED |
| `POST /jobs/:id/bill/approve` | customer owner (ARRIVED) | "Cost approved" → IN_PROGRESS |
| `POST /jobs/:id/payment` | customer owner (WORK_COMPLETED) | `{ method: "UPI"\|"CASH" }`; amount computed server-side → job COMPLETED. Idempotent (2nd call returns existing) |
| `POST /jobs/:id/review` | customer owner (COMPLETED) | `{ rating: 1–5, tags: ReviewTag[], tipAmount?: 0–5000 }`; `409` if already reviewed |
| `GET /jobs/:id/receipt` | customer owner / assigned worker (COMPLETED) | JSON receipt `{ receiptNo: "KC-10042", date, customer, worker, items[], platformFee: 0, total, method }` (PDF = P3) |
| `POST /jobs/:id/sos` | customer or assigned worker | `{ lat?, lng? }` → `201 { alertId }`; also notifies the safety channel |
| `GET /jobs/:id/bill` | both parties | `{ items[], platformFee: 0, total, payTo: { name, upiId } }` (client builds the UPI QR) |

```jsonc
// POST /jobs
{
  "categoryId": "plumber",
  "title": "Kitchen Sink Under-pipe Burst",      // required, 1–120
  "description": "PVC pipe cracked…",            // optional, ≤ 1000
  "timing": "IMMEDIATE",                         // IMMEDIATE | AFTERNOON | TOMORROW
  "addressId": "…",                              // OR inline { areaId, line, lat?, lng? }
  "photoKeys": ["u/…/p1.jpg"],                   // ≤ 5
  "voiceNote": { "key": "u/…/v1.m4a", "durationSec": 14 } // optional, ≤ 30 s (A-12)
}

// POST /jobs/direct-booking  (D-3) — same body plus { "workerId": "…" }
// Creates an OPEN job with targetWorkerId, visible only to that worker; response: { id, jobNumber, status: "OPEN", awaitingWorker: true, expiresAt }.
// Worker then calls POST /jobs/:id/direct/accept (-> ASSIGNED at visitingFee, falling back to category baseVisitFee) or /direct/decline (-> CANCELLED).
```

### 2.9 Leads & quotes – worker side (Leads radar, Lead offer, Job progress) — P1

| Method & path | Auth | Notes |
|---|---|---|
| `GET /leads?filter=all\|immediate&categoryId=&limit=&cursor=` | verified worker | OPEN jobs whose category ∈ worker trades and within `radiusKm` of base area/last fix, excluding own cancelled; item: `{ id, title, category: {id,title}, customerName, areaName, cityName, distanceKm, urgency: "IMMEDIATE", postedAt, hasVoiceNote, notes, offersCount, baseVisitFee, myOffer: {id, visitFee, etaMinutes, status}\|null }`. New leads arrive live via `lead.new` (§6); this endpoint is the initial load and reconnect catch-up. Direct requests addressed to the caller appear with `isDirect: true`; other workers never see them |
| `GET /leads/:id` | verified worker | Detail incl. `voiceNoteUrl`, `photoUrls`. **No** `addressLine` and no phone |
| `POST /leads/:id/offers` | verified worker | `{ visitFee: 1–100000, etaMinutes: 15\|30\|45, message?: ≤ 300 }` → `201`; `409 OFFER_EXISTS`, `409 JOB_NOT_OPEN` |
| `POST /jobs/:id/direct/accept` · `POST /jobs/:id/direct/decline` | target worker (verified, job OPEN with `targetWorkerId = me`) | D-3. Accept → ASSIGNED at `visitingFee` (fallback category `baseVisitFee`), returns job summary; decline → CANCELLED (`DECLINED`); `409 NOT_DIRECT_TARGET` / `JOB_NOT_OPEN` otherwise. Normal quotes on a direct job are rejected (`409 DIRECT_JOB`) |
| `PATCH /offers/:id` · `DELETE /offers/:id` | offer owner (PENDING) | Revise / withdraw (P2) |
| `GET /workers/me/jobs?tab=ongoing\|completed\|cancelled` | worker | Worker Activity (+ pending quotes in `ongoing`, flagged) |
| `POST /jobs/:id/arrival` | assigned worker (ASSIGNED) | `{ code }` → ARRIVED. 5 wrong tries ⇒ `423`-style `429 CODE_LOCKED` |
| `PUT /jobs/:id/bill-items` | assigned worker (ARRIVED) | Replaces non-visit-fee items: `[{ kind: PARTS\|LABOUR\|OTHER, description, amount }]`; visit-fee item is added automatically at acceptance |
| `POST /jobs/:id/work-photos` | assigned worker | `{ kind: "BEFORE"\|"AFTER", key }` |
| `POST /jobs/:id/complete-work` | assigned worker (IN_PROGRESS) | → WORK_COMPLETED |
| `POST /jobs/:id/payment/confirm` | assigned worker | P3: worker confirms receipt (no UI yet) |
| `POST /jobs/:id/cancel` | assigned worker (ASSIGNED) | Q-5: default re-opens the job and marks that worker's offer WITHDRAWN |

### 2.10 Admin (minimal, A-7) — P2

| Method & path | Notes |
|---|---|
| `GET /admin/workers?status=PENDING` | Queue with signed, 5-min document URLs |
| `POST /admin/workers/:id/verify` · `/reject` | `{ badge?, reason? }`; writes an audit log line |
| `PATCH /admin/sos/:id` | Acknowledge / resolve |

`isAdmin` users only. Replace with a proper admin tool later; do not build a UI in this project.

### 2.11 Ops — P1
`GET /health` (liveness) · `GET /health/ready` (DB reachable). Public, no data.

## 3. Role-shaped visibility (privacy matrix)

| Field | Customer (owner) | Assigned worker | Other verified worker (lead) | Other users |
|---|---|---|---|---|
| Job title / notes / photos / voice | ✔ | ✔ | ✔ | ✘ |
| Customer full name | ✔ | ✔ | ✔ (shown on lead cards today) | ✘ |
| Area + approx distance | ✔ | ✔ | ✔ | ✘ |
| Exact `addressLine`, lat/lng | ✔ | ✔ **after ASSIGNED** | ✘ | ✘ |
| Customer phone | ✔ | ✔ only if `allowDirectCalls` and ASSIGNED+ | ✘ | ✘ |
| Worker phone | ✔ (discovery, offers, tracking) | ✔ | – | ✘ (auth required, throttled) |
| Arrival code | ✔ | ✘ (must be told by customer) | ✘ | ✘ |
| Direct-booking job (`targetWorkerId` set, still OPEN) | ✔ | ✔ if it is the target | ✘ (hidden from feed and sockets) | ✘ |
| Worker Aadhaar docs | ✘ | ✘ | ✘ | admin only |

## 4. Validation summary (class-validator DTOs, global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`)

| Field | Rule | Frontend origin |
|---|---|---|
| phone | Indian mobile, 10 digits | login.tsx |
| otp code | exactly 6 digits | otp.tsx `OTP_LENGTH` |
| fullName | 1–80, trimmed | "Please enter your full name" |
| job title | 1–120 | "Please describe the main problem" |
| offer fee | integer 1–100000 | `!Number(fee)` check |
| offer ETA | 15, 30, 45 | lead-offer.tsx |
| radiusKm | 3, 6, 12 | worker-onboarding.tsx |
| trades | 1–2, valid ids, unique | `MAX_TRADES = 2` |
| experienceYears | 1–40 | stepper clamp |
| termsAccepted | `true` | agree checkbox |
| rating | 1–5 | rating.tsx |
| tipAmount | 0–5000 (UI offers 20/50/100/custom) | rating.tsx |

## 5. Frontend integration prerequisites (not done in this phase; frontend untouched)

1. API client module + token storage (`expo-secure-store`), refresh-on-401 interceptor.
2. Replace Zustand mock slices (`leads`, `activeBooking`, `commissionSaved`, `mobile`) with server state (TanStack Query recommended) fed by REST + Socket.IO events (§6), using `socket.io-client`.
3. Real media pickers / recorder, location (`expo-location`), and a map SDK for the tracking screen (currently a mock).
4. Collect missing fields: worker UPI ID, vehicle, visiting fee; add a cancel button; extend trade list to all 8 categories.
5. Direct booking (D-3): "waiting for worker" state for the customer and an accept/decline screen for the worker. Worker onboarding (D-4): handle `verificationStatus` (`PENDING` shows "under review" in production).

## 6. Real-time (Socket.IO) — decision D-6

REST stays the **source of truth** (initial load, reconnect catch-up, all writes except GPS pings). Sockets are server → client push so the app never polls. Events are *hints plus a minimal payload*: on (re)connect the client re-fetches the REST resources it is showing, so a missed event is never fatal.

**Connection:** `wss://<host>/realtime` (Socket.IO namespace `/realtime`), `auth: { token: <accessJWT> }` in the handshake. Invalid/expired token → connection refused (`unauthorized`); the client refreshes the token and reconnects. A connected user is auto-joined to the server-controlled room `user:<userId>`. Clients **cannot** join rooms themselves except via the validated events below.

| Client → server event | Who | Effect |
|---|---|---|
| `job:watch` `{ jobId }` | job's customer or assigned/target worker (checked server-side) | joins room `job:<jobId>`; ack `{ ok }` |
| `job:unwatch` `{ jobId }` | same | leaves room |
| `location:update` `{ jobId, lat, lng }` | assigned worker | same as `PUT /workers/me/location`; throttled; rebroadcast as `job.location` |

| Server → client event | Delivered to | Payload (no private fields; privacy matrix §3 applies) |
|---|---|---|
| `lead.new` | each matching verified worker (`user:<workerId>`): category ∈ trades, within radius, not a direct job | `{ id, title, categoryId, areaName, distanceKm, urgency, postedAt, hasVoiceNote, offersCount }` |
| `lead.closed` | workers who saw the lead | `{ id, reason: "ASSIGNED"\|"CANCELLED"\|"EXPIRED" }` |
| `direct.request` | the target worker | same shape as `lead.new` + `{ isDirect: true, expiresAt }` |
| `direct.declined` / `direct.expired` | the customer | `{ jobId }` |
| `offer.new` / `offer.updated` | the job's customer | `{ jobId, offerId, visitFee, etaMinutes, message, status, worker: {id, name, rating, …} }` |
| `offer.accepted` / `offer.rejected` | the quoting worker | `{ jobId, offerId }` |
| `job.status` | participants (`user:<id>`, `job:<id>`) | `{ jobId, status, at }` (e.g. ASSIGNED, ARRIVED, IN_PROGRESS, WORK_COMPLETED, COMPLETED, CANCELLED) |
| `job.location` | customer in `job:<id>` | `{ jobId, lat, lng, updatedAt, distanceKm, etaMinutes }` |
| `bill.updated` | customer in `job:<id>` | `{ jobId, total }` — customer re-fetches `GET /jobs/:id/bill` |
| `sos.acknowledged` | the raiser | `{ alertId }` |

Rules
- Events are published **after the DB transaction commits** through `RealtimePublisher` (never inside the transaction).
- `lead.new` fan-out = the same matching query used by `GET /leads`; its row count is also the `notifiedWorkers` value returned by `POST /jobs`.
- Every inbound event is rate-limited per socket (e.g. 20/s) and payload-validated with the same DTO validators as REST.
- Heartbeats: Socket.IO ping/pong; app should also reconnect and refetch when returning to foreground.
- Scaling: with one instance nothing else is needed. With several instances (AWS) enable the Redis adapter (`REDIS_URL`) and **either** sticky sessions on the load balancer **or** force the `websocket` transport only.

## 7. Authentication contract (built in Phase 2)

Everything is under `/api/v1` and **requires `Authorization: Bearer <accessToken>` unless marked public**. Public: `GET /health*`, `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`. Phone numbers may be sent as `98765 43210`, `9876543210` or `+919876543210`; the server stores E.164 and accepts Indian mobiles only (`[6-9]` + 9 digits).

| Endpoint | Success | Notes |
|---|---|---|
| `POST /auth/otp/request` `{phone, channel?}` | `202 {resendAfterSec: 30, expiresInSec: 300}` | Identical answer whether or not the number has an account. A new code replaces the previous one |
| `POST /auth/otp/verify` `{phone, code}` | `200 {accessToken, refreshToken, expiresIn: 900, isNewUser, user:{id, phone, language, hasCustomerProfile, hasWorkerProfile}}` | `isNewUser` is true only for the call that created the account. Use the two `has…Profile` flags to decide whether onboarding is needed |
| `POST /auth/refresh` `{refreshToken}` | `200 {accessToken, refreshToken, expiresIn}` | **Rotates**: the old refresh token is spent; store the new one |
| `POST /auth/logout` `{refreshToken}` | `204` | Auth required. Ends that login (all its tokens). Idempotent. **Also allowed for a disabled account** (K-37): the only protected route that is |
| `GET /me` | `200 {id, phone, language, customer, worker}` | `customer`/`worker` are `null` until Phase 3 creates profiles |
| `PATCH /me` `{language}` | `200` same as `GET /me` | Only `en`, `hi`, `pa`. Any other field → `422` |

### Error codes the app should handle

| Status | `code` | Meaning / app behaviour |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No/invalid token → go to login |
| 401 | `TOKEN_EXPIRED` | Access token expired → call `/auth/refresh`, retry once |
| 401 | `OTP_INVALID` | Wrong, expired, unknown or already-used code (deliberately indistinguishable) |
| 401 | `REFRESH_INVALID` | Unknown or expired refresh token → login |
| 401 | `REFRESH_REUSED` | Refresh token already used or its login was ended (logout / suspected theft) → login |
| 403 | `ACCOUNT_DISABLED` | Account switched off |
| 422 | `VALIDATION_FAILED` | `details: [{field, issue}]` |
| 429 | `OTP_COOLDOWN` | Resend too soon; `retryAfterSec` + `Retry-After` header |
| 429 | `OTP_LIMIT` | 5 codes per phone per hour reached; `retryAfterSec` |
| 429 | `OTP_LOCKED` | 5 wrong attempts on this code; request a new one |
| 429 | `TOO_MANY_REQUESTS` | Per-IP rate limit (OTP request 20/h, verify 30/15 min, refresh 60/15 min, default 60/min) |
| 501 | `CHANNEL_NOT_AVAILABLE` | `channel: "WHATSAPP"` is not built yet |
| 502 | `OTP_SEND_FAILED` | SMS provider failure; the user may retry immediately |

### Token lifetimes and limits
- Access token: HS256 JWT, **15 min** (`JWT_ACCESS_TTL_SEC`), claims `sub`, `jti`, `iat`, `exp` only. Not revocable before expiry (logout / disabling takes effect at the next refresh).
- Refresh token: opaque, **30 days**, one-time use, grouped per login. Replaying a spent token revokes that whole login.
- OTP: 6 digits, valid 5 min, 5 attempts, resend after 30 s, max 5 per phone per hour (about 25 guesses per hour per phone against 1,000,000 possibilities).
- Dev only: `OTP_DEV_BYPASS=true` makes every code `123456`; with `SMS_PROVIDER=console` the code is printed in the server log. Both are refused at boot in production.

### What the mobile app must do (frontend prerequisites)
1. Keep tokens in `expo-secure-store`, never in AsyncStorage.
2. **Single-flight refresh**: when several requests get `TOKEN_EXPIRED` together, send **one** `/auth/refresh` and let the rest wait for it. Two parallel refreshes with the same token are treated as theft and end the login.
3. Always store the *new* refresh token returned by `/auth/refresh`.
4. Behind the AWS load balancer set `TRUST_PROXY=1` so rate limits use the real client IP.

## 8. Profiles, uploads and verification contract (built in Phase 3)

All routes need a login. "Profile" in the last column means the caller must already have that profile (otherwise `403`).

| Method & path | Needs | Body → response |
|---|---|---|
| `POST /media/presign` | – | `{purpose, contentType, sizeBytes}` → `200 {uploadUrl, method:"PUT", headers:{…}, key, expiresInSec:300}` |
| `PUT /customers/me` | – | `{fullName, photoKey?, commLanguage?, allowDirectCalls?, address:{areaId, line, lat?, lng?}}` → customer view. Creates or updates the profile **and its primary address**; omitted options keep their value |
| `GET /customers/me` | – | customer view, or `404 PROFILE_NOT_FOUND` before onboarding |
| `PATCH /customers/me` | – | any of `fullName`, `photoKey` (`null` removes), `commLanguage`, `allowDirectCalls` |
| `GET/POST /customers/me/addresses` | customer | list (primary first) / add (max 5, the first becomes primary) |
| `PATCH /customers/me/addresses/:id` | customer | `areaId`, `line`, `lat`+`lng` (both numbers to set, both `null` to clear) |
| `POST /customers/me/addresses/:id/primary` | customer | moves the primary flag |
| `DELETE /customers/me/addresses/:id` | customer | `204`; deleting the primary promotes the oldest remaining one |
| `PUT /workers/me` | – | worker onboarding save (fields below) → worker view |
| `GET /workers/me` · `PATCH /workers/me` | – | worker view / partial update (`null` clears `upiId`, `vehicle`, `visitingFee`, `photoKey`) |
| `PUT /workers/me/documents/:type` | worker | `type` = `AADHAAR_FRONT` or `AADHAAR_BACK`, body `{key}` → worker view |
| `PUT /workers/me/location` | **verified** worker | `{lat, lng}` → `200 {accepted}`; a fix less than 3 s after the previous one is acknowledged but dropped (`accepted:false`) |
| `GET /admin/workers?status=&limit=&cursor=` | admin | `{items, nextCursor}`; default status `PENDING`, oldest first, `limit` 1–50 (default 20) |
| `POST /admin/workers/:id/verify` | admin | `{badge?}` → `{userId, verificationStatus, badge, rejectionReason}` |
| `POST /admin/workers/:id/reject` | admin | `{reason}` (1–300 chars) → same shape |

### Upload flow (identical for S3 and the development stand-in)
1. `POST /media/presign` with the file's `purpose`, `contentType` and exact `sizeBytes`.
2. `PUT` the bytes to `uploadUrl` with **exactly** the returned `headers` and a `Content-Length` equal to `sizeBytes`. The signature covers type and size, so any difference is refused (`403`).
3. Send the returned `key` in the profile / document call. The server only accepts keys that this user generated for this purpose **and** that really exist in storage (`422` otherwise).
4. Files are read back through short-lived signed links (`photoUrl`, 10 min). The raw key is never returned.

| Purpose | Types | Max | Bucket |
|---|---|---|---|
| `PROFILE_PHOTO`, `JOB_PHOTO`, `WORK_PROOF` | `image/jpeg`, `image/png`, `image/webp` | 5 MB | media |
| `JOB_VOICE` | `audio/mp4`, `audio/aac`, `audio/mpeg` | 2 MB | media |
| `AADHAAR` | images as above | 5 MB | **private** (never returned to customers or workers; admin links last 5 min) |

### Worker fields (`PUT /workers/me`)
`fullName` (1–80), `trades` (1–2 category ids, first = primary), `experienceYears` (1–40), `skills` (≤ 15 chips of ≤ 40 chars; blanks and case-insensitive duplicates are removed), `languages` (≥ 1 of `en|hi|pa`), `baseAreaId`, `radiusKm` (3, 6 or 12), `termsAccepted` (**must be `true`**), optional `photoKey`, `upiId` (`name@bank`), `vehicle` (≤ 80), `visitingFee` (₹1–100,000). `verificationStatus`, `badge`, ratings and ids are **never** accepted from the client (`422`).

### Verification rules
- A new worker is `PENDING`. **Production (`WORKER_VERIFICATION_MODE=manual`):** only an admin can set `VERIFIED`, and only when both Aadhaar images exist (`409 DOCUMENTS_MISSING`). **Development (`auto`):** becomes `VERIFIED` automatically once both images are uploaded.
- Editing a `REJECTED` profile, or replacing an Aadhaar image on a `VERIFIED`/`REJECTED` one, sends it back to `PENDING` (in `auto` mode it is re-approved at once).
- **Built (D-8, Q-22), 2026-10-11:** changing `fullName` on a `VERIFIED` worker also sends it back to `PENDING`, but only when the normalised name (trimmed, spaces collapsed, case-insensitive) differs from the stored one. A save that re-sends the same name changes nothing. The same applies to `photoKey` (Q-22): a different key sends it back to `PENDING`, the same key changes nothing, and removing the photo (`null`) does not trigger review. In `auto` mode the existing auto-approval re-verifies at once when both Aadhaar images exist. A worker under review disappears from discovery and the lead feed (`403 NOT_VERIFIED` on `verified` routes) but keeps every job already assigned to them, because those routes check ownership, not verification. Adding a first photo to a profile that had none counts as a different photo.
- **Decided (D-9), not built yet (Phase 7):** Aadhaar images are deleted `AADHAAR_RETENTION_DAYS` (default 7) after the VERIFIED/REJECTED decision; afterwards `documents.AADHAAR_FRONT/BACK` read `false` and a re-review needs both images uploaded again.
- Rejecting or re-submitting also takes effect immediately for guarded routes: a worker who loses `VERIFIED` gets `403 NOT_VERIFIED` on the next live-location call.
- Admin routes answer **404** (not 403) to everyone who is not an active admin. Make someone an admin by hand: `UPDATE users SET is_admin = true WHERE phone = '+91…';`

### New error codes

| Status | `code` | Meaning |
|---|---|---|
| 403 | `CUSTOMER_PROFILE_REQUIRED` / `WORKER_PROFILE_REQUIRED` | The route acts as that profile; create it first |
| 403 | `NOT_VERIFIED` | Worker profile is not `VERIFIED` |
| 404 | `PROFILE_NOT_FOUND` | `GET`/`PATCH` of a profile that was never created |
| 409 | `ADDRESS_LIMIT` | More than 5 addresses |
| 409 | `DOCUMENTS_MISSING` | Admin tried to verify a worker without both images |
| 422 | `VALIDATION_FAILED` | `details[].field` uses dotted paths, e.g. `address.areaId`; unknown area/category and bad upload keys are reported the same way |

### Development storage stand-in
With `STORAGE_PROVIDER=local` (default outside production) the signed URLs point at this API (`/api/v1/dev-storage/...`) and files go to `.local-storage/`. These routes are public but protected by an HMAC signature and expiry, answer `404` when S3 is configured, and the app **refuses to start in production** with `local`.

## 9. Marketplace contract: jobs, discovery, leads, quotes, direct booking, push (built in Phase 4)

Everything is under `/api/v1` and needs a login. "Needs" is the profile the caller must hold; a route that acts as a worker also requires `VERIFIED` (otherwise `403 NOT_VERIFIED`).

### 9.1 Routes

| Method & path | Needs | Purpose / notes |
|---|---|---|
| `POST /jobs` | customer | Post Job → `201 {id, jobNumber, reference:"KC-10000", status:"OPEN", expiresAt, notifiedWorkers}` |
| `POST /jobs/direct-booking` | customer | "Book Pro": same body plus `workerId` → `201 {…, awaitingWorker:true}` (no `notifiedWorkers`) |
| `GET /customers/me/jobs?tab=&limit=&cursor=` | customer | Activity: `tab` = `ongoing` (default) / `completed` / `cancelled`; `{items, nextCursor, meta:{counts:{ongoing,completed,cancelled}}}` |
| `GET /jobs/:id` | customer, assigned worker, or requested worker | Role-shaped job view (§9.3); anyone else `404` |
| `POST /jobs/:id/cancel` `{reason?}` | customer (owner) | OPEN or ASSIGNED → CANCELLED; waiting quotes are rejected |
| `GET /jobs/:id/offers?sort=fee\|eta` | customer (owner) | Compare Offers: live quotes (waiting or accepted) with a worker card each, `isFastest`, and (§10) `available`, `startsAt`, `nextFreeAt` |
| `POST /jobs/:id/offers/:offerId/accept` | customer (owner) | → `{status:"ASSIGNED", arrivalCode, booking:{startAt,endAt,confirmedAt}, worker}`; `409 WORKER_UNAVAILABLE` if the worker has since taken a clashing booking (§10) |
| `POST /jobs/:id/direct/accept` · `/direct/decline` | the requested worker | Answers a direct booking → job view |
| `GET /leads?filter=all\|immediate&categoryId=&limit=&cursor=` | verified worker | Leads Radar (§9.2) |
| `GET /leads/:id` | verified worker | Full lead: photos, voice note; never the address or a phone |
| `POST /leads/:id/offers` `{visitFee, etaMinutes, message?}` | verified worker | Send a quote → `201 {id, visitFee, etaMinutes, message, status:"PENDING", createdAt}` |
| `PATCH /offers/:id` · `DELETE /offers/:id` | verified worker (owner) | Revise (fee, ETA, message) or withdraw (`204`) while the quote is waiting |
| `GET /workers?categoryId=&areaId=&sort=distance\|rating&limit=&cursor=` | customer | Home "Verified Artisans Near You": `{items:[card], nextCursor}` |
| `GET /workers/:id` | customer | A verified worker's card plus `languages`, `radiusKm`, `trades` |

`POST /jobs` body: `categoryId`, `title` (1–120), `description?` (≤ 1000), `timing` (`IMMEDIATE` / `AFTERNOON` / `TOMORROW` / `SCHEDULED`; see §10 for `scheduledFor` and `durationMin`), **either** `addressId` (a saved address) **or** `address:{areaId, line, lat?, lng?}`, `photoKeys?` (≤ 5 upload keys, purpose `JOB_PHOTO`), `voiceNote?:{key, durationSec 1–30}` (purpose `JOB_VOICE`). The address text is **copied onto the job**; later edits to the address book do not change it. `status`, `workerId`, `expiresAt`, `jobNumber` and similar are rejected (`422`).

Quote rules: `visitFee` integer ₹1–100,000; `etaMinutes` is one of **15, 30, 45** (the three choices on the screen); `message` ≤ 300. One quote per worker per job; withdrawing and quoting again revives the same row.

### 9.2 Who sees which job (matching)

| Rule | Detail |
|---|---|
| A worker is told about / shown a broadcast job when | verified, offers the job's trade, is not the customer, **and serves the place** |
| "Serves the place" | With coordinates on both sides: the straight-line distance is within the worker's own radius (3, 6 or 12 km); their position is a live GPS fix less than 30 minutes old, else their base area. **Without coordinates** (area centroids are not filled yet, Q-18): the worker's base area is in the **same city**; `distanceKm` is then `null` |
| Direct bookings | Visible **only** to the requested worker (feed, detail, quotes, job view, pushes); everyone else gets `404` |
| Order | Newest first |
| Hidden always | the address line, exact coordinates, the customer's phone, the arrival code |
| Customer name | shown on lead cards (`customerName`), as on the current screens |

Lead card fields: `id, reference, title, category{id,title{en,hi,pa}}, customerName, areaName, cityName, distanceKm, urgency (timing), postedAt, hasVoiceNote, notes, offersCount, baseVisitFee, isDirect, expiresAt, myOffer`. `baseVisitFee` replaces the old mock `budget`; the "Within 1 Hour" urgency does not exist (decision Q-4).

### 9.3 Job view by viewer

| Field | Customer (owner) | Assigned worker | Requested worker (still OPEN) |
|---|---|---|---|
| Title, description, timing, category, photos, voice note | ✔ | ✔ | ✔ |
| `addressLine`, `lat`, `lng` | ✔ | ✔ (once assigned) | ✘ |
| `customer {name, phone}` | – | name always; **phone only while in service and only if the customer allows direct calls** | name only |
| `worker` (full card with phone) | ✔ once assigned | – | – |
| `arrivalCode` | ✔ while ASSIGNED / ARRIVED | ✘ | ✘ |

### 9.4 Job lifecycle (single source of truth: `jobs/state/job-state-machine.ts`)

`OPEN → ASSIGNED → ARRIVED → IN_PROGRESS → WORK_COMPLETED → COMPLETED`, and `CANCELLED` from `OPEN` or `ASSIGNED` (customer), from `OPEN` by the requested worker (decline) or by the system (expiry). Phase 4 built the transitions out of `OPEN` and the customer cancel; **Phase 5 wired the rest** (arrival, bill approval, completion, payment, worker back-out: a broadcast job re-opens, a direct booking is cancelled; see §11).

| Timer | Value | Result |
|---|---|---|
| Broadcast request unanswered | `JOB_OPEN_TTL_HOURS` (24 h) | `CANCELLED`, `cancelledBy=SYSTEM`, `cancelReason=EXPIRED`, waiting quotes rejected |
| Direct request unanswered | `DIRECT_ACCEPT_TTL_MIN` (10 min) | same |

A sweeper runs every minute (safe on several instances). A request that has expired but not yet been swept can no longer be quoted on or accepted (`409 JOB_NOT_OPEN`).

### 9.5 New error codes

| Status | `code` | Meaning |
|---|---|---|
| 403 | `OWN_JOB` | A worker tried to quote on their own request |
| 404 | `NOT_FOUND` | Not yours / not a lead for you / unknown (deliberately the same answer) |
| 409 | `JOB_LIMIT` | More than 10 open requests |
| 409 | `DIRECT_LIMIT` | More than 3 pending direct requests |
| 409 | `JOB_NOT_OPEN` | Closed, cancelled, expired or already assigned |
| 409 | `OFFER_EXISTS` | You already quoted on this job |
| 409 | `OFFER_NOT_PENDING` | Quote was withdrawn, rejected or accepted |
| 409 | `DIRECT_JOB` | A direct request cannot be quoted on or accepted through quotes |
| 409 | `INVALID_TRANSITION` | The job's status does not allow that action (e.g. cancelling after the worker arrived) |
| 422 | `VALIDATION_FAILED` | Includes: `workerId` not available / not serving you / yourself; bad media keys (`photoKeys.0`, `voiceNote.key`); unknown address |

### 9.6 Real-time (Socket.IO) as built

Connect to namespace **`/realtime`** with `auth: { token: <access JWT> }`. Refusals arrive as `connect_error` with message `unauthorized` or `token_expired`. A socket is closed when its token expires, so reconnect with a fresh token. The server puts you in `user:<yourId>` automatically; you can additionally send `job:watch {jobId}` / `job:unwatch` (ack `{ok:true}` or `{ok:false,error:"NOT_FOUND"|"INVALID"|"RATE_LIMITED"}`). Limits: 20 messages per second per connection, frames over 16 KB close the connection. Browser origins must be listed in `REALTIME_CORS_ORIGINS` (native apps need nothing).

| Event | Sent to | Payload |
|---|---|---|
| `lead.new` | each covering verified worker | lead summary (no address/phone): `id, title, categoryId, areaName, distanceKm, urgency, postedAt, hasVoiceNote, offersCount, isDirect:false` |
| `direct.request` | only the requested worker | same, with `isDirect:true` and `expiresAt` |
| `offer.new` / `offer.updated` | the job's customer | `jobId, offerId, visitFee, etaMinutes, message, status, worker:{id,name,rating,reviewsCount}` |
| `offer.accepted` | the winning worker | `{jobId, offerId}` |
| `offer.rejected` | workers whose waiting quote lost | `{jobId, offerId}` |
| `lead.closed` | covering workers that did not get a more specific message | `{id, reason: ASSIGNED \| CANCELLED \| EXPIRED}` |
| `job.status` | the customer and the involved worker | `{jobId, status, at}` |
| `direct.declined` / `direct.expired` | the customer | `{jobId}` |

Differences from the earlier draft in §6: `job.status` goes to the participants' personal rooms only (the `job:<id>` room is reserved for high-frequency `job.location`, Phase 5), so nobody receives it twice; pushes are best effort, so apps must re-fetch the REST resource on (re)connect.

### 9.7 Not built yet in this area
`Idempotency-Key` on `POST /jobs` (a double tap creates two requests; the 10-open-jobs cap limits the damage), free-text search `q` on `GET /workers`, (`GET /workers/me/jobs`, arrival, bill, tracking and payment were built in Phase 5: see §11.)

## 10. Scheduling and availability contract (built after Phase 4, before Phase 5)

Rules and reasons: `01-requirements.md` (FR-SCHEDULING, BR-13 to BR-22, A-13 to A-18). Everything below is under `/api/v1`.

### 10.1 Routes

| Method & path | Needs | Purpose / notes |
|---|---|---|
| `POST /jobs`, `POST /jobs/direct-booking` | customer | Now also accept `timing:"SCHEDULED"`, `scheduledFor`, `durationMin` (§10.2). `201` adds `scheduledFor` (ISO or null) and `durationMin` |
| `POST /leads/:id/accept` | verified worker | **Lead acceptance**: "this one is mine to quote on". Checks the worker's schedule. `200 {jobId, state:"ACCEPTED", availability}`. Idempotent. A direct request: `409 DIRECT_JOB` |
| `POST /leads/:id/decline` | verified worker | Hides the lead and stops further pushes about it. `200 {jobId, state:"DECLINED"}`. `409 OFFER_EXISTS` while the worker has a live quote (withdraw it first). A worker may accept again later while the request is open |
| `POST /leads/:id/offers` | verified worker | Unchanged body. Now also refused with `409 SCHEDULE_CONFLICT` if the worker cannot make the time; counts as accepting the lead |
| `PATCH /offers/:id` | verified worker | Changing `etaMinutes` re-checks the schedule (`409 SCHEDULE_CONFLICT`) |
| `GET /leads?filter=all\|immediate\|scheduled` | verified worker | `scheduled` = jobs booked for a time. Declined leads are left out |
| `GET /workers/me/schedule?from=&to=&limit=` | any worker profile | The calendar: `{inProgress: Booking\|null, upcoming: Booking[]}`; `Booking = {jobId, reference, title, status, category, areaName, cityName, scheduledFor, startAt, endAt, durationMin, onSite}`. Works while the profile is under review |
| `GET/PATCH/PUT /workers/me` | worker | New `scheduledRadiusKm` ∈ 3, 6, 12, 25, 50 or `null` (PATCH). Must not be smaller than `radiusKm` (`422`) |

### 10.2 Posting a job for a time

| `timing` | `scheduledFor` | Result |
|---|---|---|
| `IMMEDIATE` | **not allowed** (`422`) | As soon as possible. `scheduledFor: null`. The booking window starts at confirmation + the quote's ETA |
| `SCHEDULED` | **required** | An exact appointment |
| `AFTERNOON` | optional | Default: 14:00 IST today, or 30 minutes from now if that is later. An exact time, if sent, must be today 12:00–20:00 IST |
| `TOMORROW` | optional | Default: 10:00 IST tomorrow. An exact time, if sent, must be tomorrow (IST) |

`scheduledFor` is ISO 8601 **with an offset** (`2026-10-20T11:00:00+05:30` or `…Z`), at least `SCHEDULE_MIN_LEAD_MIN` (30) minutes and at most `SCHEDULE_MAX_DAYS` (30) days ahead. `durationMin` 15–480: if omitted, the service's own default (`service_categories.default_duration_min`, currently empty for every service) is used, else `BOOKING_DEFAULT_DURATION_MIN` (90). The job's `durationMin` is returned in the response. A scheduled request keeps collecting quotes until its appointment time or 72 hours, whichever is sooner (`expiresAt`); a direct request still lapses after 10 minutes.

### 10.3 What the worker sees on a lead

Lead cards (`GET /leads`, `GET /leads/:id`) gain:

| Field | Meaning |
|---|---|
| `scheduledFor`, `durationMin` | The appointment (null = as soon as possible) |
| `leadState` | `NEW` / `ACCEPTED` / `DECLINED` (the worker's answer, separate from any quote) |
| `extendedReach` | Inside the worker's wider future-work radius but outside their normal one |
| `availability` | `{free, etaOptions, reason, nextFreeAt}`. For an immediate job `etaOptions` lists which of 15 / 30 / 45 the worker could keep (empty = none); for a scheduled job it is `null`. `reason` is `OVERLAP` or `TRAVEL_BUFFER`; `nextFreeAt` is the earliest start that would clear the clash. **A busy worker still sees the lead**; this only says whether they can take it |

### 10.4 The five steps, and who sees each

| Step | Record | Event | Failure |
|---|---|---|---|
| Lead received | `worker_leads.delivered_at` | `lead.new` to each covering worker, once | – |
| Lead accepted / declined | `worker_leads.response` | – | `409 SCHEDULE_CONFLICT` on accept if booked |
| Quote submitted | `offers` PENDING | `offer.new` to the customer | `409 SCHEDULE_CONFLICT` |
| Quote accepted by the customer | `offers.accepted_at`, status ACCEPTED | `offer.accepted` to the worker | – |
| Booking confirmed | `jobs.booked_start_at/_end_at`, `booking_confirmed_at` | `booking.confirmed` to customer and worker | `409 WORKER_UNAVAILABLE` (nothing changes, the quote stays) |

The last two commit in one transaction: a customer never holds an accepted quote with no booking.

### 10.5 Availability rule (same for every check)

A booking occupies `[start, start + duration)`. Two bookings of one worker need a gap of at least the larger of `BOOKING_BUFFER_MIN` (15) and the straight-line travel time between the two places at `AVG_SPEED_KMH` (30 minutes if either place has no coordinates). A job the worker is already on site for (`ARRIVED`/`IN_PROGRESS`) keeps them busy until it ends even if it overruns. A worker may have one job in progress and any number of confirmed `ASSIGNED` bookings that respect the gaps. `WORK_COMPLETED` (payment pending) and later no longer hold the slot.

### 10.6 Where the worker is judged to be

| Job starts | Worker's position | Radius |
|---|---|---|
| within 2 hours, or as soon as possible | live GPS fix younger than 30 min, else base area | `radiusKm` |
| later | base area | `max(radiusKm, scheduledRadiusKm)` |

When a worker's location update has moved ≥ 0.5 km from where leads were last matched (or a minute has passed), open leads that now reach them and were not sent before arrive as `lead.new` with `reason:"LOCATION"`. After a job ends or is cancelled the server sends `location.refresh {reason:"JOB_ENDED", jobId}`; **the app must answer it by sending a fix if the person has allowed location**.

### 10.7 Events added

| Event | Sent to | Payload |
|---|---|---|
| `booking.confirmed` | the customer and the worker | `{jobId, startAt, endAt, confirmedAt}` |
| `location.refresh` | the worker | `{reason:"JOB_ENDED", jobId}` |
| `lead.new` / `direct.request` | as before | plus `scheduledFor` (only when booked for a time) and, for catch-up, `reason:"LOCATION"` |

### 10.8 New error codes

| Status | `code` | Meaning |
|---|---|---|
| 409 | `SCHEDULE_CONFLICT` | The **worker's** own action would double-book them (lead accept, quote, revise, direct accept). `details`: `reason`, `nextFreeAt`, `etaMinutes` (the arrival times that would work) |
| 409 | `WORKER_UNAVAILABLE` | The **customer** picked a worker who is no longer free at that time (accept a quote, create a direct booking). Same `details` |
| 409 | `DIRECT_JOB` | Also returned by `/leads/:id/accept` and `/decline` for a direct request |
| 422 | `VALIDATION_FAILED` | `scheduledFor` / `durationMin` / `scheduledRadiusKm` rules above |

### 10.9 What the app must do

Send `scheduledFor` with an offset; show `leadState` and `availability` on lead cards (a busy worker should see *why* they cannot quote and when they are free); grey out quotes with `available:false` and offer the next-free time; handle `409 WORKER_UNAVAILABLE` by refreshing Compare Offers; answer `location.refresh` with a location update; add a screen for `GET /workers/me/schedule`; collect `scheduledRadiusKm` in worker onboarding.

## 11. Fulfilment contract (built in Phase 5)

Everything is under `/api/v1`. **Who may call what is decided by owning the job**, never by a worker's verification status (decision D-8): worker routes need a worker profile but not `verified`, and the query itself says `worker = caller` (or `customer = caller`). Anybody else, and an unknown id, gets the same `404`; a caller with no profile of the required kind gets the usual `403`.

### 11.1 Routes

| Method & path | Who | Notes |
|---|---|---|
| `POST /jobs/:id/arrival` `{code}` | assigned worker, job ASSIGNED | `code` = exactly 4 digits. Right → `200`, job ARRIVED (worker's job view). Wrong → `422 ARRIVAL_CODE_INVALID` with how many tries are left; the 5th wrong try and everything after → `429 CODE_LOCKED` (even the right code). A right code on the 5th try still works. `409 WORKER_BUSY` if the worker is already on site at another job (that refusal does not use up a try). Early arrival (before the booked time) is allowed |
| `POST /jobs/:id/arrival-code/reset` (no body) | the job's customer, job ASSIGNED | **Arrival-code recovery.** Issues a NEW random 4-digit code (never equal to the old one), sets the wrong-try counter back to 0, and the old code stops working at once. Returns the customer's job view with the new `arrivalCode`. Works whether or not the job is locked (a customer who misread the code can use it too). **Limits, enforced inside the one database update:** at most **3** resets per assignment and at least **60 s** apart; `429 RESET_COOLDOWN` (`details[0] = {field:"retryAfterSec"}`) or `429 RESET_LIMIT`. Any other state: `409 INVALID_TRANSITION`. A worker, a stranger or an unknown id gets `403` / `404`. Per-address backstop: 20 calls per hour. Every use and every refusal is written to the audit table (§11.9). The worker gets the push `job.arrival_code_reset` (no code in it) |
| `PUT /jobs/:id/bill-items` `{items:[{kind,description,amount}]}` | assigned worker, job ARRIVED | **Replaces** the worker's items. `kind` ∈ PARTS, LABOUR, OTHER; `description` 1–120; `amount` whole ₹1–100,000; at most 20 items; `[]` clears. The visit-fee line is untouched. Returns the bill. `bill.updated` goes to the customer |
| `GET /jobs/:id/bill` | the customer or the assigned worker | `{jobId, status, items[{id,kind,description,amount}], platformFee:0, total, approved, payTo:{name, upiId}}`. `409 BILL_NOT_AVAILABLE` until a worker is chosen |
| `POST /jobs/:id/bill/approve` `{expectedTotal}` | job's customer, job ARRIVED | The customer approves the total **they were shown**. If the bill has changed: `409 BILL_CHANGED` and nothing happens. Success → IN_PROGRESS and the items freeze (a later edit is `409`). *This differs from the first draft, which had no body* |
| `POST /jobs/:id/work-photos` `{kind:"BEFORE"\|"AFTER", key}` | assigned worker, job ARRIVED or IN_PROGRESS | `key` from `POST /media/presign` with purpose `WORK_PROOF`, uploaded by this worker. At most 5 per kind (`409 PHOTO_LIMIT`); the same key twice is one photo. `201 {before:[url], after:[url]}`. The customer and the worker see them as `workPhotos` in `GET /jobs/:id` |
| `POST /jobs/:id/complete-work` | assigned worker, job IN_PROGRESS | → WORK_COMPLETED. Frees the worker's calendar and sends them `location.refresh` |
| `POST /jobs/:id/payment` `{method:"UPI"\|"CASH"}` | job's customer, job WORK_COMPLETED | Records the payment; **the amount is the bill total, computed on the server** (an `amount` in the body is rejected with `422`). → COMPLETED. Idempotent: a second call (even with the other method, or many at once) returns the first payment unchanged. `{jobId,status,receiptNo,method,amount,platformFee:0,markedAt}` |
| `GET /jobs/:id/receipt` | the customer or the assigned worker, job COMPLETED | `{receiptNo:"KC-10042", date, jobTitle, customer:{name}, worker:{name}, items[], platformFee:0, total, method}`. No phone, no address. `409 RECEIPT_NOT_AVAILABLE` before payment |
| `GET /jobs/:id/tracking` | the customer or the assigned worker, job ASSIGNED to WORK_COMPLETED | See §11.3 |
| `POST /jobs/:id/sos` `{lat?, lng?}` | the customer or the assigned worker, job ASSIGNED to WORK_COMPLETED | `201 {alertId, repeated}`. Both coordinates or neither (`422`). A second tap by the same person within a minute returns the first `alertId` with `repeated:true` and does not page the desk again. `409 SOS_NOT_AVAILABLE` otherwise |
| `GET /workers/me/jobs?tab=ongoing\|completed\|cancelled&limit=&cursor=` | any worker profile (own history; works while under review) | `{items, nextCursor, meta:{counts}, pendingQuotes?}`. Jobs the worker was given only (ASSIGNED…WORK_COMPLETED / COMPLETED / CANCELLED), newest first. `pendingQuotes` (ongoing tab, first page): quotes the customer has not answered, capped at 50. Items carry `customerName`, area and city, `scheduledFor`, the booked window and the bill `total`; **no address or phone** |
| `POST /jobs/:id/cancel` `{reason?}` | the customer **or** the assigned worker | Decided by who owns the job. Customer: OPEN/ASSIGNED → CANCELLED (unchanged). Worker: ASSIGNED only → see §11.2. A stranger: `403` if they have no customer profile (as before), otherwise `404` |
| `PATCH /admin/service-categories/:id/duration` `{defaultDurationMin: 15–480 \| null}` | admin | Sets how long a visit for that service is assumed to take (decision D-14); `null` clears it. Affects only jobs posted afterwards |

### 11.2 A worker backing out

| | Broadcast request | Direct booking (D-3) |
|---|---|---|
| Job | back to **OPEN** with the worker, accepted quote, assignment time, arrival code and attempts, booking window and confirmation all cleared; visit-fee bill line removed; fresh deadline (the same rule as when it was posted) | **CANCELLED** (`cancelledBy=WORKER`, reason `BACKED_OUT` unless the worker gave one); the booked window stays for history and no longer blocks the calendar |
| The worker's quote | WITHDRAWN. They cannot quote or accept that lead again (`409 BACKED_OUT`) and it leaves their radar | – |
| Other quotes | stay REJECTED. Those workers can send a **new** quote (they hear about the re-open) | – |
| Leads | the once-only delivery record is reset for everyone except workers who **declined** and the one who backed out, so `lead.new` is sent again exactly once per re-open | – |
| Events | customer: `job.status` OPEN + `job.reopened`; covering workers: `lead.new`; the worker: `location.refresh` | customer: `job.status` CANCELLED + `direct.declined`; the worker: `location.refresh` |
| After arriving | `409 INVALID_TRANSITION` (too late) | same |

The backed-out worker's response is the job view **without the address**. An assigned worker never sees the address of a CANCELLED job.

### 11.3 Tracking payload and what it will not claim

`GET /jobs/:id/tracking` → `{status, location, distanceKm, etaMinutes, distanceBasis, …}` plus, for the **customer**: `worker {id, name, trade, vehicle, phone, verified}` and `arrivalCode` (while ASSIGNED or ARRIVED); for the **worker**: `customer {name}` and never the code.
- `location` = the worker's latest stored fix `{lat, lng, updatedAt, stale}`, or `null` if they never sent one. `stale` is true after 2 minutes.
- `distanceKm` and `etaMinutes` (straight line ÷ `AVG_SPEED_KMH`) are **only** given when the worker's fix is less than 30 minutes old **and** the job's place has real coordinates. Otherwise both are `null`. Nothing is estimated from a city or guessed.
- `distanceBasis`: `JOB_COORDINATES` (the customer shared GPS with the address), `AREA_CENTROID` (only the centre of the area is known: approximate) or `null` (no coordinates: no distance). Today the 13 areas have no coordinates (Q-18), so until that is done a distance appears only when the customer's address carries GPS.

### 11.4 Reporting the worker's position

- `PUT /workers/me/location {lat, lng}`: verified workers always (it feeds lead matching); a worker in review only while a job is assigned to them (`403 NOT_VERIFIED` otherwise). One fix per 3 seconds is stored.
- Socket event **`location:update {jobId, lat, lng}`** (ack `{ok:true, accepted}` or `{ok:false, error:"NOT_FOUND"\|"INVALID"\|"RATE_LIMITED"}`): same effect, but only for a job assigned to this worker that is ASSIGNED or ARRIVED. Not someone else's job and not a finished one: `NOT_FOUND`.
- Every stored fix of a worker on the way is rebroadcast as **`job.location`** to whoever has done `job:watch` on that job.
- **After a job ends** (work completed, worker backs out, customer cancels an assigned job) the worker gets **`location.refresh`**. The server cannot ask for permission: **the app must answer by sending a fix if the person has allowed location.** If it does not, nothing is invented: matching keeps using the last real fix for 30 minutes, then the worker's base area. A new fix re-runs lead matching within about a minute (§10.6).

### 11.5 Events added in Phase 5

| Event | Sent to | Payload |
|---|---|---|
| `job.location` | watchers of the job (`job:watch`) | `{jobId, lat, lng, updatedAt, distanceKm, etaMinutes, distanceBasis}` (distance fields can be `null`, see §11.3) |
| `bill.updated` | the customer | `{jobId, total}`: re-fetch `GET /jobs/:id/bill` |
| `job.reopened` | the customer | `{jobId, reason:"WORKER_BACKED_OUT"}` |
| `location.refresh` | the worker | `{reason:"JOB_ENDED", jobId}` (also in §10.7) |
| `job.status` | as before | now also ARRIVED, IN_PROGRESS, WORK_COMPLETED, COMPLETED |
| `job.arrival_code_reset` | the assigned worker | `{jobId}` only: the worker must ask the customer for the new code. The code is never pushed |

`sos.acknowledged` from the first draft is **not built** (there is no acknowledge endpoint yet).

### 11.6 SOS delivery

The alert is stored first (`sos_alerts`, status OPEN), then sent through the safety channel: `SOS_WEBHOOK_URL` (JSON `POST`, 5 s timeout, no retry) or, if it is not set (development only), the application log. **Production refuses to start without an https `SOS_WEBHOOK_URL`.** The receiver, the people behind it and the delivery guarantees are **not decided**; the agreed requirements are in `05-security-testing.md §11`. If the channel fails the request still succeeds (`201`) and an error is logged. The payload carries: alert id, job reference and status, who raised it with name and phone, the other person, the job's address (where help goes, so the channel must be private) and a location labelled `REPORTED` (sent with the alert), `LAST_WORKER_FIX` (the worker's latest stored fix, with its age) or `null` (unknown).

### 11.7 New error codes

| Status | `code` | Meaning |
|---|---|---|
| 422 | `ARRIVAL_CODE_INVALID` | Wrong arrival code; `details` says how many tries are left |
| 429 | `CODE_LOCKED` | Five wrong codes; the job cannot be arrived at with a code any more |
| 409 | `WORKER_BUSY` | The worker is already on site at another job |
| 429 | `RESET_COOLDOWN` | A new arrival code was issued less than 60 s ago; `details` has `retryAfterSec` |
| 429 | `RESET_LIMIT` | Three new codes were already issued for this assignment; only cancel or the worker backing out remain |
| 409 | `BILL_CHANGED` | The bill changed since the customer last looked; `details` gives the current total |
| 409 | `BILL_NOT_AVAILABLE` · `RECEIPT_NOT_AVAILABLE` · `TRACKING_NOT_AVAILABLE` · `SOS_NOT_AVAILABLE` | Asked at a stage where it does not exist yet / any more |
| 409 | `PHOTO_LIMIT` | Already five photos of that kind |
| 409 | `BACKED_OUT` | The worker backed out of this request and cannot quote or accept it again |
| 409 | `INVALID_TRANSITION` | The job's state does not allow it (also for every out-of-order call above) |

### 11.8 What the app must do

Show the arrival code to the customer and a code box to the worker (with the tries left); a bill screen where the worker edits and the customer approves the **total shown** (send `expectedTotal`; handle `BILL_CHANGED` by re-fetching); payment and receipt screens; the live map from `GET …/tracking` then `job.location`, **drawing no distance when it is `null`**; the worker app sends `location:update` while on the way and answers `location.refresh` with a fix; handle `job.reopened` (back to "waiting for quotes") and a worker-side "back out" button; an SOS button; the worker's Activity from `GET /workers/me/jobs`.

### 11.9 Arrival-code recovery: behaviour and what it means for a lock

- **Before:** five wrong codes locked the assignment, and the only exits were the worker backing out or the customer cancelling.
- **Now:** the customer can issue a new code (`POST /jobs/:id/arrival-code/reset`). A locked worker is unlocked at once.
- **Guessing stays bounded:** a worker gets 5 tries per code and the customer can issue at most 3 new codes, so one assignment allows at most 5 x 4 = **20 guesses out of 10,000 (0.2 %)**.
- **After the third reset** the customer cannot reset again, however long they wait. If the worker locks that code too, the only exits are the customer cancelling or the worker backing out. This is deliberate: the cap is what keeps the guess budget small.
- **A new assignment starts clean:** when the worker backs out, the reset counter and cooldown are cleared along with the code.
- **App contract:** the customer's job view carries `arrivalLocked` and `arrivalResetsLeft` (while ASSIGNED); the worker's view carries `arrivalLocked`. Show "ask the customer for a new code" to a locked worker, and an "issue a new code" action to the customer (hidden when `arrivalResetsLeft` is 0).
- **Audit trail** (table `job_security_events`, append-only, never contains a code): `ARRIVAL_LOCKED` (actor = the worker, written when the fifth wrong code is entered), `ARRIVAL_CODE_RESET` (actor = the customer; written in the same transaction as the change), `ARRIVAL_RESET_REFUSED` (detail `LIMIT` or `COOLDOWN`; at most one row per job per minute so repeated taps cannot flood it). Each row records the caller's IP address. No endpoint reads the table yet; it is for support and investigation.

## 12. Reviews, activity extras, earnings and savings contract (built in Phase 6)

No database migration was needed: the `reviews` table, the worker's `rating_sum` / `review_count` and their CHECK constraints already existed from the baseline.

### 12.1 Routes

| Method & path | Who | Notes |
|---|---|---|
| `POST /jobs/:id/review` `{rating, tags?, tipAmount?}` | the job's customer, job COMPLETED (payment recorded) | `rating` integer 1–5 (required); `tags` any of PUNCTUAL, FAIR_PRICE, CLEAN_WORK, POLITE, EXPERT_SKILL, each at most once (default none); `tipAmount` whole ₹0–5000 (default 0), **recorded only**: the tip is paid to the worker directly and is not part of the bill, the payment or the earnings (Q-8). There is no free-text comment; unknown fields are rejected. `201 {id, jobId, rating, tags, tipAmount, createdAt, worker:{id, rating, reviewsCount}}`. `409 ALREADY_REVIEWED` (a review is final; there is no edit), `409 REVIEW_NOT_ALLOWED` before COMPLETED or if cancelled, `404` for anyone but the job's customer (including the job's own worker), `403` if the caller has no customer profile |
| `GET /workers/me/earnings?period=today\|week\|month` | any worker profile (verification not required) | `{period, from, to, timezone:"Asia/Kolkata", amount, jobsDone, platformFee:0, currency:"INR"}`. Default `today`. `amount` = sum of the bills of jobs that reached COMPLETED inside the period, by the time the payment was recorded. `from`/`to` is the half-open range counted, in UTC. Days are Asia/Kolkata days (midnight IST); weeks start Monday; months start on the 1st. Tips are not included |
| `GET /me/savings?role=customer\|worker` | any signed-in user | `{commissionSaved, benchmarkRate, currency:"INR", role, jobsCount, jobsTotal}`. `commissionSaved` = `jobsTotal` x `benchmarkRate`, rounded to whole rupees (half up); `jobsTotal` = paid bills of the caller's COMPLETED jobs as customer or as worker. `benchmarkRate` is `COMMISSION_BENCHMARK_RATE` (default 0.20, decision D-5) and must be disclosed in the app: this is a comparison with a competitor's commission, not money the platform holds. Without `role`: the customer side if the user has a customer profile, else the worker side. A user with no jobs gets zeros |
| `GET /workers/:id` | customer | now also `reviews: {rating, reviewsCount, distribution:{"1".."5"}, latest:[{rating, tags, createdAt}]}` with the ten newest, **without any reviewer identity** |

### 12.2 Fields added to existing responses

| Where | Field | Meaning |
|---|---|---|
| `GET /customers/me/jobs`, COMPLETED rows | `rating` (1–5 or `null`), `reviewed` (boolean) | "Rated 5.0" on the row; `reviewed:false` means offer the review screen. Absent on other tabs |
| `GET /workers/me/jobs`, COMPLETED rows | `rating` (1–5 or `null`) | what the customer gave |
| `GET /jobs/:id`, COMPLETED | `review` (`{id, jobId, rating, tags, tipAmount, createdAt}` or `null`); customer view also `canReview` | the customer and the job's worker see the review; nobody else can see the job |

### 12.3 Rules

- **Once, by the owner, after payment** (BR-10): enforced by the ownership query (404 otherwise), the status check and a unique index on `reviews.job_id`.
- **Totals never lose a count:** the review row and the worker's running totals change in one transaction using `SET x = x + n`; ten simultaneous taps on one job produce exactly one review, and twelve customers rating one worker at once produce exactly twelve counted ratings.
- **The average** is `rating_sum / review_count`, one decimal, `null` before the first review.

### 12.4 What the app must do

Offer the review screen when a COMPLETED job has `canReview: true`; send `rating` (default 5), the chosen `tags` and the optional tip; show "Rated x.x" from `rating`; show the worker's `reviews` summary on the profile; show "earned today" from `/workers/me/earnings` and disclose `benchmarkRate` next to "Total saved".

## 13. Contract changes in Phase 7, Milestone A (2026-10-11)

| Change | Detail |
|---|---|
| **`403 ACCOUNT_DISABLED` on every protected route** (K-5) | A user whose account is disabled (`users.is_active = false`) is refused on **every route that needs a login**, even while their access token is still valid, and from the very next request: the check is read from the database each time. The body is the usual `{statusCode:403, code:"ACCOUNT_DISABLED", message}`. Public routes (login, refresh, health, signed dev uploads) are not affected. Admin routes keep answering `404` to everyone who is not an active admin, a disabled admin included. `GET /me`, which used to answer `401` for a disabled account, now answers `403 ACCOUNT_DISABLED`; `POST /auth/refresh` already answered the same code. **The app should** treat it as "this account is disabled": stop calling, show the disabled-account screen, and clear its tokens. **The one exception is `POST /auth/logout` (K-37):** it still works for a disabled account, so the app can always end a session. A valid access token is still required (no token or a forged one is `401`); the call answers `204`, revokes the refresh family named in the body, and only if that token belongs to the caller. After the account is re-enabled the old refresh token answers `401 REFRESH_REUSED`, exactly as after an active user's logout. Every other route stays refused. |
| **Quotes of a worker under review are hidden** (K-36) | `GET /jobs/:id/offers` lists a quote only if it is ACCEPTED, or PENDING from a worker who is VERIFIED. The same rule applies to every "how many quotes" number: `offersCount` on `GET /jobs/:id`, on `GET /customers/me/jobs` rows, and on the lead cards workers see. "Fastest" is judged among the quotes shown. A hidden quote returns by itself when its worker is verified again; nothing is deleted. The worker still sees their own waiting quote in `GET /workers/me/jobs` |
| **`409 OFFER_UNAVAILABLE`** (K-36) | `POST /jobs/:id/offers/:offerId/accept` for a quote whose worker is not VERIFIED. The message says only that the quote is not available right now; it deliberately does not say why. Nothing changes (the job stays OPEN, the other quotes stay PENDING). **The app should** refetch the quote list and let the customer choose again. An already-accepted quote is never affected, and a worker who was chosen while verified keeps the job even if they are later sent back for review |
| Request id | Every response carries `X-Request-Id` (section 1) |
