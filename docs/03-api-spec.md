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
