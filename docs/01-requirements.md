# 01 · Requirements Analysis

Source of truth: the Expo Router app in `KaamConnect/` (`app/`, `store/useStore.ts`, `constants/mockData.ts`).
`src/` + `index.html` are the earlier web prototype and were used only to cross-check data.
**Legend:** ✅ confirmed in code · ⚠️ implied / inconsistent in the UI · ❓ assumption (listed in §10 and §11 below).

## 1. State of the frontend (what the backend replaces)

- All data is mock: `constants/mockData.ts` + a Zustand store. There is **no API client, no auth token handling, no persistence**. Handlers end in comments such as `// In a real app, save to DB here.` and `setTimeout(...)` fake network calls.
- No map SDK, push SDK, secure storage, or image/audio picker is installed. The tracking map, voice recorder and photo upload are visual mocks.
- The backend directory `KaamConnectBackendAPI/` was **empty**; there is no existing database config or migration history to preserve.

## 2. Product summary ✅

KaamConnect is a hyperlocal home-services marketplace for the **Chandigarh Tricity** (Chandigarh, Mohali, Panchkula).
Customers post a job (or book a worker directly); verified workers send quotes; the customer accepts one; the worker travels (live GPS), arrives (arrival code), inspects, bills, and is paid **directly by cash or UPI**. The platform takes **0% commission** and never handles money. UI is trilingual (en / hi / pa).

## 3. Roles ✅

| Role | How it exists | Notes |
|---|---|---|
| Customer | `CustomerProfile` on a `User` | Created in *Customer onboarding* |
| Worker | `WorkerProfile` on a `User` | Created in *Worker onboarding*; must be verified to be listed |
| Both | One phone number can hold both profiles | ✅ "Toggle freely between Worker and Customer mode anytime" (`toggleRole`, `ModeSwitchCard`). Active mode is a **client-side** choice; the server authorizes by profile + resource ownership |
| Admin | ❓ not in the app | Needed to verify workers (A-7) |

## 4. Screen → backend dependency map

| # | Screen (file) | Role | Backend needs |
|---|---|---|---|
| 1 | Splash (`index.tsx`) | – | none |
| 1B | Carousel (`carousel.tsx`) | – | none (static copy) |
| 2 | Language (`language.tsx`) | – | persist `language` on user after login (en/hi/pa) |
| 3 | Login (`login.tsx`) | – | request OTP for 10-digit +91 number |
| 4 | OTP (`otp.tsx`) | – | verify 6-digit OTP, resend (28 s timer), WhatsApp OTP fallback; session tokens; tell client if user is new / which profiles exist |
| 5 | Role (`role.tsx`) | – | none (client chooses which onboarding to open) |
| 6A | Customer onboarding | C | upsert name*, photo, address (area + free text), GPS, comm language, direct-call toggle; locations list |
| 6B | Worker onboarding | W | upsert name, photo, 1–2 trades, experience 1–40 y, skills (free chips), languages, base area, radius 3/6/12 km, Aadhaar front/back upload, terms consent |
| 7 | Home (`(tabs)/home.tsx`) | C | service categories, verified workers nearby (card data), search box (not wired), direct book |
| 8 | Leads/Services (`leads.tsx`) | C / W | customer: category directory; worker: lead feed with filters All / Immediate / Plumbing / Electrician |
| 9 | Post job (`post-job.tsx`) | C | create job: category*, title*, description, voice note, photos, timing*; broadcast |
| 10 | Lead offer (`lead-offer.tsx`) | W | lead detail (voice/photos); send quote: fee*, ETA 15/30/45, message |
| 11 | Compare offers | C | list offers w/ worker cards, fastest flag, accept, call |
| 12 | Tracking | C (W) | worker position, ETA/distance, arrival code, worker/vehicle info, SOS |
| 13 | Job progress | C / W | milestones, before/after photos, itemised bill, payment (UPI/cash) |
| 14 | Rating | C | rating 1–5, tags, tip |
| 15 | Activity | C / W | tabs Ongoing/Completed/Cancelled; receipts; re-book; worker "earned today" |
| 16 | Profile | C / W | profile summary, commission savings, language, addresses, helpline, logout |

## 5. Functional requirements

### FR-AUTH ✅
1. Phone-OTP only, no password ("No password needed"). Number is 10 digits, `+91`. OTP is **6 digits**; resend after 28 s; optional WhatsApp channel.
2. After verification the app shows Role selection. The API must return `isNewUser`, `hasCustomerProfile`, `hasWorkerProfile` so the client can skip onboarding for returning users (⚠️ the current UI always shows Role selection; a frontend change, not a backend one).
3. Logout (`Profile → Log Out`) must invalidate the session.

### FR-PROFILE ✅
- Customer: `fullName` (required, error shown when blank), optional photo, primary address (free text + area chip from Tricity list + optional GPS), `commLanguage` ∈ hi/pa/en, `allowDirectCalls` toggle.
- Worker: `fullName`, photo, **max 2 trades** (first = primary, enforced in UI), `experienceYears` 1–40, `skills[]` (removable chips + "Add Skill"), `languages[]` (hi/pa/en), base area, `radiusKm` ∈ {3, 6, 12} (default 6), Aadhaar front + back images (**mandatory**), consent checkbox (**required** to submit).
- ⚠️ Profile menu says "Saved Tricity Addresses" (plural) but UI edits a single address → model supports many addresses with one primary; v1 needs only one.
- Language preference (`en|hi|pa`) is per user.

### FR-DISCOVERY ✅
- Service category catalog (8 categories, see seed): id, EN/HI/PA titles, icon, colours, base visit fee, examples.
- Verified-worker cards: name, trade, rating (+count), distance, ETA, visiting fee, top-3 skills, badge, phone (direct "Call Directly"), avatar.
- Tricity locations: 3 cities → sectors/phases.

### FR-JOBS ✅
- Post job → status OPEN; "Request sent to 24 nearby Tricity technicians" ⇒ response should include the number of matching workers.
- Worker lead feed: category-matched, in radius, newest first; fields: title, category, customer name, area + distance, urgency, posted-ago, has voice note, notes, bids count. Filters: All, Immediate, per category.
- Quote: fee must be a number > 0; ETA 15/30/45; optional message ≤ 1 short line.
- Customer sees quotes live ("LIVE OFFERS"), fastest ETA highlighted; **accept** assigns the worker and starts tracking.
- ⚠️ Home **"Book Pro"** goes straight to tracking without a job post or quotes ⇒ second creation path (direct booking), see D-3 (worker must accept).

### FR-FULFILMENT ✅
- Live GPS tracking: worker position, "Arriving in 11 Mins • 1.1 km away", vehicle, 4-digit **arrival code** (customer shows it to worker; timeline: "OTP 8421 Verified at 11:42 AM").
- Milestones: (1) arrived + code verified → (2) fault inspected & **cost approved** → (3) work complete / ready for settlement.
- Work proof photos: BEFORE and AFTER.
- Itemised bill (visit fee, parts, labour) with **platform commission always ₹0.00**; total payable to worker.
- Payment: "Scan & Pay" UPI QR with worker's UPI ID, or "Paid Cash". Platform only records it.
- SOS button on tracking: alerts "Tricity Safety Response Desk and designated emergency contact".

### FR-FEEDBACK ✅
- Rating 1–5 (default 5), multi-select tags (Punctual, Fair Price, Clean Work, Polite, Expert Skill), optional tip ₹20/₹50/₹100/Custom ("100% to worker"). No free-text comment field exists.
- Worker `rating` and `reviewsCount` shown on cards ⇒ aggregates.

### FR-ACTIVITY ✅
- Customer: Ongoing / Completed / **Cancelled (count)** tabs; completed rows: title, price, "Completed by X on date • Rated 5.0", **Download Receipt** (invoice no. `#KC-99238`), **Re-Book**; ongoing: Call, Track Status, Leave Review.
- Worker: "Worker Earnings & Jobs": today's earnings, jobs done today, platform fee ₹0.
- Profile: **"0% Commission Charter Savings – TOTAL SAVED ₹4,200"** (both roles).

### FR-PLATFORM ⚠️
- Support numbers appear as `1800-123-4567` (Home drawer) and `1800-KAAM-CONNECT` (Profile): serve one value from config.
- "Notifications" bell routes to Activity (no inbox screen) ⇒ **no notification-inbox API in v1**. Push for "new lead" / "new offer" is implied but not designed in the UI (Phase 8, optional).

## 6. Business rules

| ID | Rule | Source |
|---|---|---|
| BR-1 | Platform commission is always 0; the bill must show ₹0 and totals equal the sum of items | ✅ job-progress |
| BR-2 | Money is exchanged directly worker↔customer (UPI/cash). The backend records, never processes, payments | ✅ |
| BR-3 | A worker has 1–2 trades; exactly one primary | ✅ onboarding |
| BR-4 | Only **verified** workers appear in discovery and receive leads | ✅ "Verified Artisans". Dev: auto-approve; production: manual admin review (D-4) |
| BR-5 | Customer's exact address is not broadcast; it is shared only after the customer confirms a worker | ✅ "Privacy Shield" text |
| BR-6 | Customer phone reachable by workers only if `allowDirectCalls` | ✅ toggle |
| BR-7 | Aadhaar data is never shown publicly; only a verified badge | ✅ onboarding text |
| BR-8 | One quote per worker per job; a job has at most one accepted quote | ❓ (natural) |
| BR-9 | Only the assigned worker can verify the arrival code; code is 4 digits | ✅ |
| BR-10 | Only the job's customer can review, once, after the job is completed | ❓ (natural) |
| BR-11 | Savings = Σ paid job totals × benchmark commission rate | ❓ rate unknown (Q-9) |
| BR-12 | Distances/ETA are computed server-side, not stored | ✅ |

## 7. Job state machine

```
OPEN ──accept offer (customer) / accept direct request (target worker)──▶ ASSIGNED
ASSIGNED ──arrival code verified (worker)──▶ ARRIVED
ARRIVED ──bill approved (customer)──▶ IN_PROGRESS
IN_PROGRESS ──work done (worker)──▶ WORK_COMPLETED
WORK_COMPLETED ──payment marked (customer)──▶ COMPLETED

OPEN ──cancel (customer) / TTL expiry (system) / decline direct request (target worker)──▶ CANCELLED
ASSIGNED ──cancel (customer)──▶ CANCELLED
ASSIGNED ──cancel (worker)──▶ OPEN (re-opened, see Q-5; direct bookings go to CANCELLED)
```

Activity tabs: **Ongoing** = OPEN…WORK_COMPLETED · **Completed** = COMPLETED · **Cancelled** = CANCELLED.

## 8. Gaps & inconsistencies found in the UI (need decisions, not invented)

| # | Finding | Impact |
|---|---|---|
| G-1 | Worker onboarding lets workers pick only 4 trades (electrician, appliance, plumber, carpenter) though 8 categories exist | Backend supports all 8; UI must be extended or categories ac_repair/painter/cleaner/car_wash have no workers |
| G-2 | Leads show `budget` ("₹250 – ₹350 Visiting") and urgency "Within 1 Hour", but the Post-Job form collects neither (only Immediate/Afternoon/Tomorrow) | Budget not stored; API returns category base fee instead (Q-4) |
| G-3 | Pay-by-UPI QR uses `<firstname>.tricity@upi`, but no UPI ID is collected | Added optional `upiId` on worker; UI must collect it |
| G-4 | Tracking shows a vehicle string; onboarding doesn't collect it | Optional `vehicle` field |
| G-5 | SOS promises "designated emergency contact"; none is collected | Not modelled; Q-10 |
| G-6 | Discovery cards show a worker visiting fee; onboarding has no fee input (the frontend README mentions a fee slider that doesn't exist in the app) | Optional `visitingFee` on worker (Q-6) |
| G-7 | Customer onboarding says "Aadhaar-free signup" but Profile shows "Aadhaar Verified Citizen" for customers too | Customers have **no** verification in the model |
| G-8 | After a worker sends a quote the app opens `/tracking` (a customer screen) | Frontend flow issue; backend offers `GET /workers/me/jobs` |
| G-9 | Worker name is hard-coded ("Ramesh Kumar" in onboarding, "Rajesh Kumar" in store) | Mock noise; ignore |
| G-10 | Tip: no payment rail exists | Stored as recorded amount only (Q-8) |
| G-11 | Sector lists differ between `mockData.ts`, onboarding chips and legacy `src/data.js` | Seed uses the union of the 2 app lists; legacy extras optional (Q-11) |
| G-12 | No cancel-job control exists, but a "Cancelled" tab does | `cancel` endpoint provided; button to be added later |
| G-13 | Phone validation in UI = 10 digits only | Backend will additionally require Indian mobile prefix `[6-9]` (Q-12) |

## 9. Non-functional requirements

- Scale (assumed, ❓ A-1): launch city, ≤ ~50k users, ≤ ~2k concurrent; single Postgres, single API instance + 1 replica. Design so it works unchanged at 10× with indexes below.
- Latency: p95 < 300 ms for reads, < 600 ms for writes (excluding third-party OTP delivery).
- Availability: 99.5 % (single region); daily backups, PITR if the host offers it.
- Locale: all user-visible API strings are codes; localisation stays in the app. Category titles are returned in all 3 languages.
- Time: stored UTC, "today" for earnings computed in `Asia/Kolkata`.
- Compliance (to be validated with counsel, not legal advice): India DPDP Act 2023 (consent, purpose, deletion), Aadhaar handling restrictions, TRAI DLT for SMS, store policies requiring in-app account deletion (not in current UI).

## 10. Assumptions (proceed on these unless you object)

| ID | Assumption |
|---|---|
| A-1 | Launch scale ≤ ~50k users / ~2k concurrent; single region |
| A-2 | Money = whole INR integers; no paise, no tax |
| A-3 | S3-compatible object storage with presigned uploads (public-via-signed-URL bucket + private bucket for Aadhaar) |
| A-4 | ~~Polling~~ **Superseded by decision D-6:** Socket.IO real-time push; REST `GET` endpoints remain the source of truth and the reconnect catch-up path |
| A-5 | Distance = haversine on GPS, falling back to area centroid; no PostGIS |
| A-6 | Aadhaar **number not stored**; front/back images only |
| A-7 | `User.isAdmin` + 3 admin endpoints for verifying workers; no admin UI |
| A-8 | Access JWT 15 min, rotating refresh token 30 days |
| A-9 | OPEN broadcast jobs auto-cancel after 24 h with no accepted quote; direct requests after 10 min without a worker response (`DIRECT_ACCEPT_TTL_MIN`) |
| A-10 | Modular monolith, single Postgres; Redis **optional** (D-6) |
| A-11 | ETA = distance ÷ 20 km/h (no routing provider) |
| A-12 | Voice note ≤ 30 s, ≤ 5 photos per job, images ≤ 5 MB |

## 11. Decisions

### 11.1 Decided by you (recorded 2026-10-10)

| ID | Decision | Consequence in the design |
|---|---|---|
| **D-1 (Q-1)** | Use the existing **native local PostgreSQL** (v18 service `postgresql-x64-18` is running; pgAdmin 4 installed). No Docker. Databases: `KaamConnect` (dev) and `KaamConnect_test` (automated tests) | `DATABASE_URL` / `TEST_DATABASE_URL`. Note: Postgres folds *unquoted* names to lower case, so a DB created in pgAdmin as `"KaamConnect"` is case-sensitive; the URL must use exactly `/KaamConnect`. Prisma 7.10 + PG 18 compatibility is verified in Phase 0. Integration tests use the real test DB (no Testcontainers). I will **not** create or modify databases without asking |
| **D-2 (Q-2)** | OTP: an `OtpSender` **interface**; dev implementation **logs the OTP to the console**. MSG91 once DLT is done. WhatsApp OTP deferred to a later phase | `channel=WHATSAPP` is accepted by the schema but returns `501 CHANNEL_NOT_AVAILABLE` until implemented. Console sender only active when `NODE_ENV !== 'production'` |
| **D-3 (Q-3)** | "Book Pro" **requires the worker to explicitly accept**: customer requests → worker alerted → worker accepts | New direct-booking flow (below); a "waiting for worker" state and an accept/decline UI are needed in the app |
| **D-4 (Q-7)** | Worker verification: **manual admin review for production**; **simulated auto-approve in dev**; a manual flag stays on until legal sign-off | Config `WORKER_VERIFICATION_MODE=auto\|manual`. Boot **fails** if `auto` with `NODE_ENV=production`. `auto` approves on save only when both Aadhaar images are uploaded |
| **D-5 (Q-9)** | "Total saved" is benchmarked against a competitor commission, **configurable, default 20 %**. KaamConnect itself charges 0 % | `COMMISSION_BENCHMARK_RATE=0.20`; savings = Σ paid job totals × rate. The API labels it `benchmarkRate` so the app can disclose the basis |
| **D-6 (your "Q-14")** | **Socket.IO WebSockets in v1** for bids, lead broadcast and job tracking (no polling). **Redis optional**: v1 stores OTPs/sessions in Postgres; code is structured so Redis can be plugged in for caching and Socket.IO scaling on AWS | New `realtime` module (see `04-architecture.md §3` and `03-api-spec.md §6`). Redis seams: `RealtimePublisher`, `CacheService`, throttler storage, Socket.IO adapter, all behind interfaces with in-memory defaults |
| **D-7 (Q-13)** | `git init` as a **separate repo** | Done: `KaamConnectBackendAPI/.git` created (branch `main`, no commits yet) |

#### Direct booking flow (D-3)
1. `POST /jobs/direct-booking { workerId, …job fields }` → job `status=OPEN`, `targetWorkerId=workerId`, `expiresAt = now + DIRECT_ACCEPT_TTL_MIN`. Visible **only** to that worker (excluded from every other worker's lead feed; quotes on it are rejected with `409`).
2. Socket event `direct.request` to the worker (their feed also shows it flagged `isDirect: true`).
3. Worker `POST /jobs/:id/direct/accept` → `ASSIGNED` at the worker's `visitingFee` (fallback: category `baseVisitFee`); a system offer row records the fee. Or `/direct/decline` → job `CANCELLED` (`cancelledBy=WORKER`, reason `DECLINED`) and the customer is told so they can pick someone else.
4. No response before expiry → `CANCELLED` (`cancelledBy=SYSTEM`).
Frontend impact: Home "Book Pro" must land on a "waiting for worker" state instead of `/tracking`; worker app needs an incoming-request accept/decline UI (G-14).

### 11.2 Still open (I will apply the recommended default unless you say otherwise)

| ID | Question | Default applied |
|---|---|---|
| **Q-4** | Lead `budget` / urgency "Within 1 Hour" are not collected by Post Job — drop, derive, or add fields? | Derive from category base fee; drop "Within 1 Hour" |
| **Q-5** | Worker cancels after assignment: re-open job to other workers? | Yes, re-open and notify customer |
| **Q-6** | Add a default visiting-fee field to worker onboarding (cards show a fee)? | Yes, optional |
| **Q-8** | Tips: record-only (paid off-platform)? | Record-only |
| **Q-10** | SOS: who receives it, and add an emergency-contact field? | Email/webhook to a named owner (you); contact field later |
| **Q-11** | Sector list: the two app lists (12 areas) or the larger legacy list (19)? | 12 now, rest behind a flag |
| **Q-12** | Enforce Indian mobile prefix `[6-9]` on the server? | Yes |
| **Q-14** | Prisma **7.10.0** (stable) rather than Prisma 8 RC? | Yes, revisit after 8 GA |
| **Q-15** | Hosting / object storage provider? You mentioned AWS for production | S3 + RDS PostgreSQL assumed; decide before Phase 3 |
| **Q-16** | Workers' phone shown to any logged-in customer on cards ("Call Directly")? | Yes, rate-limited |
| **Q-17** | Add account deletion (`DELETE /me`), generally required by app stores/privacy law? | Yes, Phase 7 |

### 11.3 New UI gaps created by the decisions

| # | Gap |
|---|---|
| G-14 | "Book Pro" currently opens tracking immediately (D-3): needs a waiting/accepted/declined state; workers need an incoming direct-request screen |
| G-15 | After saving, the worker modal says "Your profile is verified… now live" (D-4): in `manual` mode the copy must say "under review" and the app must handle `verificationStatus` |
| G-16 | The app has no socket client (`socket.io-client`) or token refresh; both required for D-6 |
