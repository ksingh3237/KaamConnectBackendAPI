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

### FR-SCHEDULING (requested 2026-10-10; extends Phase 4, ahead of Phase 5)
Workers keep receiving and answering leads while they are busy, and customers can book for later today, tomorrow or a future date. The ten requirements, in the order given:
1. A worker's active job never blocks `lead.new`, the lead feed or lead detail.
2. A worker can review, accept, decline and quote on opportunities (direct requests: accept or decline) at any time.
3. Jobs can be scheduled for later today, tomorrow or another future date (`scheduledFor`).
4. Before a booking is confirmed the worker's availability is validated and overlapping confirmed appointments are detected (BR-13 to BR-17).
5. **Lead received**, **lead accepted / declined**, **quote submitted**, **quote accepted by the customer** and **booking confirmed** are separate recorded states with separate events (BR-18).
6. One job in progress plus any number of non-conflicting future confirmed bookings (BR-14).
7. Nearby-lead discovery uses the worker's current location when it is fresh; a future job is judged by its own place and time (BR-19, BR-20).
8. After a job ends the app is asked for a fresh location, and the next fix re-runs lead matching (BR-21).
9. A future booking is not limited to the 6 km live radius when the worker has said they will travel farther (`scheduledRadiusKm`, BR-20).
10. Socket.IO notifications keep working and a worker is never sent the same lead twice (BR-22).

**Delivered 2026-10-11, and its Phase 5 dependencies delivered 2026-10-11** (the Phase 5 contract is `03-api-spec.md §11`; scheduling contract: `03-api-spec.md §10`; design: `04-architecture.md §9`; tests: `05-security-testing.md §8`). Decisions Q-23 to Q-26 approved the same day (D-11 to D-14). Built and tested; migrations `20261010180000_scheduling_and_availability` and `20261011090000_category_default_duration` are applied to **both** the test and the dev database. **Phase 5 (2026-10-11) built what was missing:** arrival, bill, completion, payment, tracking, SOS and a worker backing out, each covered by a real test in `test/phase5-requirements.e2e-spec.ts` (which began as 22 pending tests). Still **not built:** worker payment confirmation, admin SOS acknowledgement, PDF receipts. Also not built: rescheduling an existing booking, a service default duration shown in the app API, and real per-service minutes (no numbers supplied yet).

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
| BR-13 | **Booking window.** A confirmed job occupies `[bookedStartAt, bookedEndAt)`. Scheduled jobs start at `scheduledFor`; immediate jobs start at confirmation time + the quote's ETA. Length = `durationMin` (default 90) | FR-SCHEDULING |
| BR-14 | **Capacity.** A worker may have at most one job in progress (`ARRIVED` / `IN_PROGRESS`) and any number of `ASSIGNED` bookings, provided no window overlaps and the travel gap (BR-15) holds. A job in progress that overruns its window keeps the worker busy until it ends | FR-SCHEDULING |
| BR-15 | **Travel gap.** Between two bookings: at least `BOOKING_BUFFER_MIN` (15) minutes, or the straight-line travel time between the two job places at `AVG_SPEED_KMH`, whichever is larger; `BOOKING_DEFAULT_TRAVEL_MIN` (30) when a place has no coordinates | FR-SCHEDULING |
| BR-16 | **Where availability is checked:** lead accept, quote send (`SCHEDULE_CONFLICT` to the worker), customer quote acceptance and direct-booking creation (`WORKER_UNAVAILABLE` to the customer), direct accept. Only the last check, inside the confirming transaction under a per-worker lock, is authoritative; the earlier ones are early warnings | FR-SCHEDULING |
| BR-17 | **Database backstop.** Overlapping active windows for one worker and a second in-progress job for one worker are rejected by PostgreSQL itself, whatever the application does | FR-SCHEDULING |
| BR-18 | **Pipeline states** (each its own record and event): lead delivered (`worker_leads.delivered_at`, `lead.new`) → lead accepted / declined (`worker_leads.response`) → quote submitted (`offers` PENDING, `offer.new`) → quote accepted by the customer (`offers.accepted_at`, `offer.accepted`) → booking confirmed (`jobs.booking_confirmed_at`, `booking.confirmed`). Sending a quote counts as accepting the lead. Customer acceptance and booking confirmation commit in one transaction; if confirmation fails nothing changes | FR-SCHEDULING |
| BR-19 | **Which place and time judge a job.** A job starting within `NEAR_TERM` (2 h) is matched against the worker's live location (fresh GPS fix < 30 min, else base area) and `radiusKm`. A job starting later is matched against the worker's **base area** (their live position says nothing about where they will be) and `scheduledRadiusKm`, plus the travel gap to their neighbouring bookings | FR-SCHEDULING |
| BR-20 | `scheduledRadiusKm` (3, 6, 12, 25 or 50; never below `radiusKm`; empty = same as `radiusKm`) is the worker's statement that they will travel farther for future work. It never widens matching of near-term jobs | FR-SCHEDULING |
| BR-21 | When an assigned job ends or is cancelled the worker receives `location.refresh`. A location fix that moved ≥ 0.5 km (or follows a stale one) re-runs matching for open leads the worker has not been sent yet | FR-SCHEDULING |
| BR-22 | **No duplicate leads.** A lead is pushed to a worker only if its `(job, worker)` delivery row is newly inserted; declined leads are hidden from the feed and not pushed again | FR-SCHEDULING |

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
| A-3 | S3-compatible object storage with presigned uploads (separate private bucket for Aadhaar). **Built**: S3 provider for production plus a signed local-disk stand-in for development |
| A-4 | ~~Polling~~ **Superseded by decision D-6:** Socket.IO real-time push; REST `GET` endpoints remain the source of truth and the reconnect catch-up path |
| A-5 | Distance = haversine on GPS, falling back to area centroid; no PostGIS |
| A-6 | Aadhaar **number not stored**; front/back images only |
| A-7 | `User.isAdmin` + 3 admin endpoints for verifying workers; no admin UI |
| A-8 | Access JWT 15 min, rotating refresh token 30 days |
| A-9 | OPEN broadcast jobs auto-cancel after 24 h with no accepted quote; direct requests after 10 min without a worker response (`DIRECT_ACCEPT_TTL_MIN`) |
| A-10 | Modular monolith, single Postgres; Redis **optional** (D-6) |
| A-11 | ETA = distance ÷ 20 km/h (no routing provider) |
| A-12 | Voice note ≤ 30 s, ≤ 5 photos per job, images ≤ 5 MB |
| A-13 | A job lasts the customer's `durationMin` (15–480) if sent, else the service's default (`service_categories.default_duration_min`, empty for all services today), else `BOOKING_DEFAULT_DURATION_MIN` (90) — decision D-14 |
| A-14 | `AFTERNOON` without an exact time starts at 14:00 IST today (or 30 min from now if that is later); `TOMORROW` at 10:00 IST tomorrow. "Day" always means `Asia/Kolkata` |
| A-15 | A scheduled job needs `scheduledFor` ≥ 30 min ahead and ≤ 30 days ahead; it stays open for quotes until `min(scheduledFor, 72 h)` |
| A-16 | A scheduled job is quoted at the requested time; the worker does not counter-propose another time. For scheduled jobs `etaMinutes` is only a travel-time hint |
| A-17 | Customer acceptance books the worker at once (no second "worker confirms" step; decision D-11). If the worker's schedule changed since they quoted, acceptance fails with `409 WORKER_UNAVAILABLE` and the quote stays visible as `available:false` |
| A-18 | Travel gaps use straight-line distance and `AVG_SPEED_KMH` (A-11); no routing provider |

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
| **D-7 (Q-13)** | `git init` as a **separate repo** | Done: `KaamConnectBackendAPI/.git` exists on branch `main` (two docs-only commits so far; remote `origin` configured) |
| **D-8 (Q-19)** | Changing the **name** of a VERIFIED worker sends the profile back to `PENDING` (option B), in both verification modes. Compare the **normalised** name (trim, collapse spaces, case-insensitive) with the stored one, so `PUT /workers/me` re-sending an unchanged name never triggers a review | **Decided 2026-10-10, not built yet** (small change in `workers.service.ts` `upsert`/`patch`, plus tests and the `03-api-spec.md §8` verification rules). In `auto` mode the existing `autoApproveIfEligible` re-approves at once, so dev behaves like production. **Phase 5 constraint:** routes that act on an already-assigned job (arrival, bill, completion, payment, SOS, tracking pings) must be gated on **ownership of that job**, not on `VERIFIED`, so a re-review hides a worker from new work but never strands a customer mid-job. **Extended by Q-22 (2026-10-10):** replacing the profile photo (`photoKey` set to a different key) on a VERIFIED worker also sends the profile back to `PENDING`. Re-sending the same `photoKey` changes nothing. Removing the photo (`null`) does not trigger review, since there is no face left to impersonate (my default; say if you want it to trigger too). The admin review queue already shows `photoUrl`, so the reviewer sees the new photo |
| **D-9 (Q-20)** | Aadhaar images are deleted a fixed number of days after the VERIFIED/REJECTED decision: `AADHAAR_RETENTION_DAYS`, **default 7**, configurable (counsel may move it between 0 and 30). Reviewer id and decision time stay as the audit trail. Legal sign-off on collecting Aadhaar images at all is still required before launch | **Decided 2026-10-10, not built (Phase 7).** Scheduled sweep deletes the object from the private bucket first, then the `worker_documents` row, logging the deletion without the key. Also delete on account deletion (Q-17). Add an S3 lifecycle rule on the private bucket as a hard cap, versioning off. REJECTED has no decision timestamp today (only `verifiedAt`), so the job needs a small migration (`reviewed_at`) or an agreed fallback: **ask before migrating**. After deletion `documents.*` is `false` in the worker view, so a later re-review (D-8 or a replaced image) requires a re-upload; the app needs "re-upload required" copy (G-15). Note that the image contains the Aadhaar number even though the database never stores it (A-6) |
| **D-10 (Q-21)** | AWS region for S3 and RDS: **`ap-south-1` (Mumbai)**. Hyderabad (`ap-south-2`) is the intended later home for cross-region backups, keeping data in India | **Decided 2026-10-10.** No code change: it is the `STORAGE_REGION` env var (unit tests already use `ap-south-1`). Choose before the first real bucket is created: moving later means copying buckets and snapshots and recreating KMS keys. Needed for the first real S3 test (K-3) and Phase 7 deployment |
| **D-11 (Q-23)** | **Approved 2026-10-11.** Accepting a customer's quote confirms the booking immediately; there is no second worker-confirmation step | **Built** (A-17, BR-18). If the worker's schedule changed since they quoted, acceptance fails with `409 WORKER_UNAVAILABLE` and nothing changes |
| **D-12 (Q-24)** | **Approved 2026-10-11.** Quotes and bookings that conflict with the worker's confirmed schedule are rejected | **Built** (BR-16): lead accept, quote send and revise, direct accept → `409 SCHEDULE_CONFLICT`; customer accept and direct-booking creation → `409 WORKER_UNAVAILABLE`; backed by database constraints (BR-17) |
| **D-13 (Q-25)** | **Approved 2026-10-11.** The wider future-work radius is opt-in; workers who do not enable it keep their normal matching radius | **Built** (BR-20): `scheduledRadiusKm`, empty = same as `radiusKm`; never applied to work needed within 2 hours |
| **D-14 (Q-26)** | **Approved 2026-10-11.** 90 minutes is the default job duration, and a service that needs a different duration can be configured | **Built**: a job's length is the customer's `durationMin` if sent, else the service's `default_duration_min`, else `BOOKING_DEFAULT_DURATION_MIN` (90). **No service has a number yet** (the column is empty for all 8), so every job is 90 minutes until you supply the values; set them in `prisma/data/service-categories.ts` (`defaultDurationMin`) and re-run the seed, or update the column directly. The API does not yet show the service default to the app |

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
| **Q-5** | Worker cancels after assignment: re-open job to other workers? | Yes, re-open and notify customer. **Built in Phase 5 on this default** (2026-10-11; you asked for the documented requirements, it was not confirmed separately). A direct booking is cancelled instead |
| **Q-6** | Add a default visiting-fee field to worker onboarding (cards show a fee)? | Yes, optional |
| **Q-8** | Tips: record-only (paid off-platform)? | Record-only |
| **Q-10** | SOS: who receives it, and add an emergency-contact field? | A webhook to a person or channel you name (`SOS_WEBHOOK_URL`). **Built in Phase 5 on this default**; required (https) in production. The emergency-contact field is still not collected |
| **Q-11** | Sector list: the two app lists (13 areas) or the larger legacy list (19)? | 13 now (built), the other 6 behind `SEED_LEGACY_AREAS` |
| **Q-18** | Area centroid coordinates (`lat`/`lng`) for the 13 areas: who supplies verified values? Needed before Phase 4 distance/radius matching | You or a geocoding source; seed fills them without overwriting |
| ~~Q-19~~ | Answered: see **D-8** (re-review on a normalised name change) | |
| ~~Q-20~~ | Answered: see **D-9** (delete 7 days after the decision, configurable) | |
| ~~Q-21~~ | Answered: see **D-10** (`ap-south-1` Mumbai) | |
| ~~Q-22~~ | Answered 2026-10-10: **yes**, a changed profile photo on a VERIFIED worker also sends the profile back to review. Folded into **D-8** | |
| ~~Q-23~~ | Answered 2026-10-11: **D-11** (accepting a quote books immediately) | |
| ~~Q-24~~ | Answered 2026-10-11: **D-12** (conflicting quotes and bookings are rejected) | |
| ~~Q-25~~ | Answered 2026-10-11: **D-13** (wider radius is opt-in) | |
| ~~Q-26~~ | Answered 2026-10-11: **D-14** (90 min default, configurable per service). **Open follow-up:** the actual per-service minutes, which only you can supply | Until then every service uses 90 |
| **Q-12** | Enforce Indian mobile prefix `[6-9]` on the server? | Yes |
| **Q-14** | Prisma **7.10.0** (stable) rather than Prisma 8 RC? | Yes, revisit after 8 GA |
| **Q-15** | Hosting / object storage provider? You mentioned AWS for production | S3 + RDS PostgreSQL. **S3 provider is built and unit-tested offline; it has not run against a real bucket yet** (needs your AWS account) |
| **Q-16** | Workers' phone shown to any logged-in customer on cards ("Call Directly")? | Yes, rate-limited |
| **Q-17** | Add account deletion (`DELETE /me`), generally required by app stores/privacy law? | Yes, Phase 7 |

### 11.3 New UI gaps created by the decisions

| # | Gap |
|---|---|
| G-14 | "Book Pro" currently opens tracking immediately (D-3): needs a waiting/accepted/declined state; workers need an incoming direct-request screen |
| G-15 | After saving, the worker modal says "Your profile is verified… now live" (D-4): in `manual` mode the copy must say "under review" and the app must handle `verificationStatus` |
| G-16 | The app has no socket client (`socket.io-client`) or token refresh; both required for D-6 |
| G-17 | The API requires a customer address **line** (3–200 chars). The onboarding screen pre-fills one but never validates it, so the app must not send an empty value |
| G-18 | The photo and Aadhaar "Upload" buttons are visual mocks. The real flow is presign → PUT to the signed URL → send the key; worker onboarding "Save" becomes `PUT /workers/me` followed by two document calls |
| G-20 | Scheduling needs the app to: send `scheduledFor` (with an offset) and optionally `durationMin`; show `leadState`, `availability` (including *why* a busy worker cannot quote and `nextFreeAt`) and `extendedReach` on lead cards; add Accept / Decline lead buttons; grey out quotes with `available:false`; handle `409 WORKER_UNAVAILABLE` / `SCHEDULE_CONFLICT`; answer `location.refresh` with a location update; add a worker calendar screen (`GET /workers/me/schedule`); collect `scheduledRadiusKm` in worker onboarding (`03-api-spec.md §10.9`) |
| G-19 | Phase 4 changes what the app should send and show: `timing` is `IMMEDIATE` / `AFTERNOON` / `TOMORROW` (the app's "Immediate (Within 30 mins)" text is a label for `IMMEDIATE`); lead cards get `baseVisitFee` instead of the mock "budget"; quote ETA must be 15, 30 or 45; the Compare Offers and Leads screens need Socket.IO (`03-api-spec.md §9.6`) or they will not update live |
