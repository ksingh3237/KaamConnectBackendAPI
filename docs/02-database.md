# 02 · Database Architecture

PostgreSQL 16+ (local instance is v18) · Prisma ORM 7.10.x (pin; see §7) · full proposed schema: [`prisma/schema.prisma`](../prisma/schema.prisma).
Every entity below maps to something visible in the app (see `01-requirements.md`). Fields tagged *(gap)* exist because the UI shows the data but never collects it.

## 1. ER diagram

```mermaid
erDiagram
    User ||--o| CustomerProfile : "has"
    User ||--o| WorkerProfile : "has"
    User ||--o{ RefreshToken : "sessions"
    User ||--o{ SosAlert : "raises"

    City ||--|{ Area : "contains"
    Area ||--o{ Address : "located in"
    Area ||--o{ WorkerProfile : "base area"
    Area ||--o{ Job : "job area"

    CustomerProfile ||--o{ Address : "saves"
    CustomerProfile ||--o{ Job : "posts"
    CustomerProfile ||--o{ Review : "writes"

    WorkerProfile ||--|{ WorkerTrade : "offers"
    ServiceCategory ||--o{ WorkerTrade : "listed in"
    WorkerProfile ||--o{ WorkerDocument : "uploads"
    WorkerProfile ||--o| WorkerLocation : "latest GPS"
    WorkerProfile ||--o{ Offer : "sends"
    WorkerProfile ||--o{ Job : "assigned"
    WorkerProfile |o--o{ Job : "direct request target"
    WorkerProfile ||--o{ Review : "receives"

    ServiceCategory ||--o{ Job : "categorises"
    Job ||--o{ Offer : "receives"
    Job |o--o| Offer : "accepted"
    Job ||--o{ JobMedia : "attachments"
    Job ||--o{ BillItem : "itemised bill"
    Job ||--o| Payment : "settled by"
    Job ||--o| Review : "reviewed by"
    Job ||--o{ SosAlert : "during"

    User { uuid id PK
      string phone UK
      enum language
      bool is_admin
      bool is_active }
    OtpChallenge { uuid id PK
      string phone
      string code_hash
      int attempts
      timestamptz expires_at
      timestamptz consumed_at }
    RefreshToken { uuid id PK
      uuid user_id FK
      uuid family_id
      string token_hash UK
      timestamptz revoked_at }
    CustomerProfile { uuid user_id PK
      string full_name
      string photo_key
      enum comm_language
      bool allow_direct_calls }
    Address { uuid id PK
      uuid customer_id FK
      int area_id FK
      string line
      float lat
      float lng
      bool is_primary }
    City { int id PK
      string name UK }
    Area { int id PK
      int city_id FK
      string name
      float lat
      float lng }
    ServiceCategory { string id PK
      string title_en
      string title_hi
      string title_pa
      int base_visit_fee
      bool is_active }
    WorkerProfile { uuid user_id PK
      string full_name
      int base_area_id FK
      int radius_km
      int experience_years
      string_arr skills
      enum_arr languages
      int visiting_fee
      string upi_id
      enum verification_status
      int rating_sum
      int review_count }
    WorkerTrade { uuid worker_id PK,FK
      string category_id PK
      bool is_primary }
    WorkerDocument { uuid id PK
      uuid worker_id FK
      enum type
      string storage_key }
    WorkerLocation { uuid worker_id PK,FK
      float lat
      float lng
      timestamptz updated_at }
    Job { uuid id PK
      uuid target_worker_id FK
      int job_number UK
      uuid customer_id FK
      string category_id FK
      string title
      enum timing
      enum status
      uuid worker_id FK
      uuid accepted_offer_id UK
      string arrival_code }
    JobMedia { uuid id PK
      uuid job_id FK
      enum kind
      string storage_key }
    Offer { uuid id PK
      uuid job_id FK
      uuid worker_id FK
      int visit_fee
      int eta_minutes
      enum status }
    BillItem { uuid id PK
      uuid job_id FK
      enum kind
      string description
      int amount }
    Payment { uuid id PK
      uuid job_id FK,UK
      enum method
      int amount
      enum status }
    Review { uuid id PK
      uuid job_id FK,UK
      int rating
      enum_arr tags
      int tip_amount }
    SosAlert { uuid id PK
      uuid user_id FK
      uuid job_id FK
      enum status }
```

## 2. Entity notes

| Table | Purpose / UI origin | Key decisions |
|---|---|---|
| `users` | One row per phone number | Phone is E.164 and the only identity. `language` is the app language (Language screen). `is_admin` is ❓ A-7 |
| `otp_challenges` | Login OTP | Only a keyed hash of the code is stored; attempts + expiry enforce brute-force limits; rows purged after 24 h |
| `refresh_tokens` | Sessions / logout | Opaque random token, SHA-256 stored; `family_id` enables reuse detection on rotation |
| `customer_profiles` / `worker_profiles` | Onboarding screens | PK = `user_id` (1:1 with user) — no surrogate id, no join needed. A user may have both |
| `addresses` | Customer address + sector chip | Free text `line` is private until assignment. Exactly one primary per customer (partial unique index, §5) |
| `cities`, `areas` | Tricity location chips | Int PKs; `lat/lng` centroid used when no GPS exists (A-5) |
| `service_categories` | 8 trade tiles | String PK = frontend's stable ids (`electrician`, `ac_repair`, …), never renamed. EN/HI/PA titles stored; colours/icon key stay data so the app can drop its hard-coded list |
| `worker_trades` | Trade chips (max 2) | Composite PK; one primary enforced by partial unique index; "max 2" enforced in service + trigger-free count check |
| `worker_documents` | Aadhaar front/back | Only object-storage **keys**. No Aadhaar number column (A-6) |
| `worker_locations` | Live GPS | Latest fix only (upserted); no history because no screen shows one |
| `jobs` | Post-job form + whole fulfilment lifecycle; `target_worker_id` marks a direct booking the target worker must accept (D-3) | One table instead of separate Request/Booking: the UI treats them as the same "job" (`#KC-88421`). Address is **snapshotted** so later profile edits don't rewrite history. `job_number` is a sequence (`KC-<n>`) |
| `job_media` | Voice note, problem photos, before/after photos | `kind` discriminates; voice note carries `duration_sec` |
| `offers` | Quote form | `(job_id, worker_id)` unique; accepting one marks others `REJECTED` |
| `bill_items` | Itemised bill | Platform commission is **not a row**; API always emits `platformFee: 0` |
| `payments` | UPI/Cash "Paid" buttons | 1:1 with job. Records only; `CONFIRMED` is for a future worker confirmation (no UI yet) |
| `reviews` | Rating screen | One per job; `tags` is an enum array; tip is a recorded amount (Q-8) |
| `sos_alerts` | Tracking SOS | Stores who/where/when so the safety desk can act |
| `worker_leads` | Which lead reached which worker, and their answer (added with scheduling, migration `20261010180000_scheduling_and_availability`) | PK `(job_id, worker_id)`. Its existence is the "already sent" guard that stops a duplicate `lead.new` (BR-22); `response` = ACCEPTED / DECLINED records lead acceptance (BR-18). Cascades with the job and the worker |

**Scheduling columns (same migration).** `jobs.scheduled_for` (requested appointment start, null = as soon as possible), `duration_min` (default 90), `booked_start_at` / `booked_end_at` / `booking_confirmed_at` (the reserved window, set when the booking is confirmed), `offers.accepted_at` (when the customer accepted the quote), `worker_profiles.scheduled_radius_km` (how far the worker will travel for future work; null = same as `radius_km`), and `JobTiming` gained `SCHEDULED`. A second small migration, `20261011090000_category_default_duration`, adds `service_categories.default_duration_min` (nullable, 15–480; empty = use the global default of 90, decision D-14).

Intentionally **not** modelled (not in the UI): wallet balance, notifications inbox, chat, coupons, admin dashboards, worker availability/online toggle ("24 Online" is static text), invoices table (a receipt is generated from job + bill items + payment).

## 3. Derived values (never stored)

| Value | Computation |
|---|---|
| `distanceKm` on cards/leads | Haversine between viewer's point (customer address, else area centroid; worker last fix, else base-area centroid) and the job/worker point |
| `etaMinutes` on tracking | `distanceKm / AVG_SPEED_KMH` (config, 20) rounded up; for direct offers the quoted ETA |
| Worker rating | `ratingSum / reviewCount` (1 decimal; `null` when 0 reviews) |
| `bidsCount` | `COUNT(offers WHERE job_id)` |
| `postedAgo`, "Today at 11:30" | From `created_at`, formatted by the app |
| `urgency` | Mapped from `timing` enum |
| Invoice/booking no. | `KC-${job_number}` |
| Commission saved | `Σ payments.amount × COMMISSION_BENCHMARK_RATE` (D-5) |
| Earned today (worker) | `Σ payments.amount` where `jobs.worker_id = me` and `marked_at` within IST day |

## 4. Indexes (beyond PK/unique)

| Index | Serves |
|---|---|
| `jobs (status, category_id, area_id, created_at)` | Worker lead feed (OPEN jobs per trade/area) |
| `jobs (customer_id, status, created_at)` | Customer Activity tabs |
| `jobs (worker_id, status, created_at)` | Worker Activity tabs, earnings |
| `jobs (status, expires_at)` | Expiry sweeper |
| `offers (worker_id, status)` · unique `(job_id, worker_id)` | Worker's own quotes; duplicate protection |
| `worker_profiles (base_area_id, verification_status)` | Discovery + lead fan-out |
| `worker_trades (category_id)` | Discovery by trade |
| `reviews (worker_id, created_at)` | Worker profile reviews |
| `payments (marked_at)` | Earnings / savings aggregates |
| `otp_challenges (phone, created_at)` | Cooldown + rate-limit lookups |
| `sos_alerts (status, created_at)` | Safety-desk queue |
| `worker_leads (worker_id, delivered_at)` | A worker's leads, newest first; the `(job_id, worker_id)` primary key serves the duplicate guard |
| partial `jobs (worker_id, booked_start_at) WHERE status IN ('ASSIGNED','ARRIVED','IN_PROGRESS')` | The availability check: one worker's active bookings in time order |

No PostGIS in v1 (A-5): Tricity-scale haversine over an area-pre-filtered set is cheap. Revisit if worker count > ~50k or radius search needs ordering by true distance in SQL.

## 5. Constraints Prisma can't express (hand-written at the end of the migrations)

The authoritative SQL is the last block of `prisma/migrations/20261010150000_baseline/migration.sql` and of `prisma/migrations/20261010180000_scheduling_and_availability/migration.sql` and `20261011090000_category_default_duration/migration.sql`; each rule below has a test in `test/db-constraints.e2e-spec.ts` or `test/scheduling.e2e-spec.ts` that runs against a real PostgreSQL.

| Rule | Constraint / index |
|---|---|
| Quote fee 1–100 000, ETA 5–240 min | `offers_fee_range`, `offers_eta_range` |
| Bill items ≥ 0, payment > 0 | `bill_items_amount_nonneg`, `payments_amount_pos` |
| Rating 1–5, tip ≥ 0 | `reviews_rating_range`, `reviews_tip_nonneg` |
| Worker radius ∈ {3, 6, 12}, experience 1–40, counters ≥ 0, fee > 0 | `worker_profiles_radius_allowed`, `_experience_range`, `_counters_nonneg`, `_visiting_fee_nonneg` |
| Category base fee ≥ 0 | `service_categories_fee_nonneg` |
| Latitude/longitude ranges | `areas_/addresses_/jobs_/sos_alerts_coords_range`, `worker_locations_coords_range` |
| One primary address per customer | partial unique index `addresses_one_primary_per_customer` (`WHERE is_primary`) |
| One primary trade per worker | partial unique index `worker_trades_one_primary_per_worker` |
| Assigned/active job must have a worker | `jobs_assigned_has_worker` |
| Arrival code is exactly 4 digits | `jobs_arrival_code_format` |
| A cancelled job records who and when | `jobs_cancelled_has_actor` |
| **No overlapping bookings for one worker** (BR-17): two jobs in `ASSIGNED` / `ARRIVED` / `IN_PROGRESS` cannot have overlapping `[booked_start_at, booked_end_at)` windows; back-to-back is allowed, `WORK_COMPLETED`/`COMPLETED`/`CANCELLED` free the slot | exclusion constraint `jobs_worker_no_overlap` (`EXCLUDE USING gist (worker_id WITH =, tstzrange(...) WITH &&) WHERE …`). Needs the `btree_gist` extension: `CREATE EXTENSION IF NOT EXISTS btree_gist` is in the migration; it is a *trusted* extension, so the database owner can create it (also on RDS) |
| **One job in progress per worker** (BR-14) | partial unique index `jobs_one_in_progress_per_worker` (`WHERE status IN ('ARRIVED','IN_PROGRESS')`) |
| A booking window is both ends or neither, and ends after it starts | `jobs_booking_window_valid` |
| Once assigned a job must have its booking window and confirmation time | `jobs_assigned_has_booking` (the migration back-fills jobs that were already assigned) |
| Duration 15–480 minutes | `jobs_duration_range`, `service_categories_duration_range` (the per-service default) |
| Future-work radius ∈ {3, 6, 12, 25, 50} | `worker_profiles_scheduled_radius_allowed` (the rule "not below `radius_km`" is enforced in the API; matching uses the larger of the two) |
| A lead answer has its time and vice versa | `worker_leads_response_pair` |
| First job is KC-10000 | `ALTER SEQUENCE jobs_job_number_seq START WITH 10000 RESTART` (START WITH, so `TRUNCATE … RESTART IDENTITY` in tests also returns to 10000) |

**Verified (2026-10-10, Prisma 7.10.0, PostgreSQL 18):** `prisma migrate diff` between the migrated database and `schema.prisma` reports *no difference*, i.e. Prisma ignores these CHECKs and partial indexes and will **not** try to drop them on a later `migrate dev`. CI repeats this drift check on every push. Prisma 8 can declare partial indexes in the schema; revisit after it is GA.

## 6. Integrity rules enforced in code (inside a transaction)

*Phase 5 (fulfilment) needed no migration: it uses `jobs.arrival_attempts`, `bill_items`, `payments`, `sos_alerts` and the booking columns that already existed. `worker_leads` rows are now also deleted on a re-open (docs `03-api-spec.md §11.2`).*

| Rule | Mechanism |
|---|---|
| Accept offer: only if job is `OPEN`, offer is `PENDING`, caller owns job | `updateMany({where:{id, status:'OPEN'}})` and check `count === 1`; then set sibling offers `REJECTED` — all in one `$transaction` |
| One offer per worker per job | Unique index → map `P2002` to `409` |
| Worker must be `VERIFIED` and have the job's category as a trade to quote | Service check |
| State transitions | A pure `JobStateMachine` table (from → to, allowed actor) used by every mutation; illegal transition ⇒ `409` |
| Review aggregates | `ratingSum += rating; reviewCount += 1` as atomic increments in the same transaction as the review insert |
| Max 2 trades | DTO `@ArrayMaxSize(2)` + service re-check on write |
| Bill editable only while `ARRIVED` (before approval) | State check; approval snapshots the total |
| Payment amount = Σ bill items | Computed server-side, client sends only the method |
| Confirm a booking only if the worker is free (BR-16) | Inside the confirming transaction: `pg_advisory_xact_lock(hashtext('booking:<workerId>'))`, then read the worker's active bookings and apply the overlap + travel-gap rule (`AvailabilityService.reserve`). The lock is what protects the travel gap (the database cannot see it); the exclusion constraint is the backstop for hard overlaps and its violation (`23P01`) is mapped to the same `409`. Verified by a mutation check: with the lock removed, two simultaneous accepts 15 minutes apart both succeed |
| Send a lead to a worker once (BR-22) | `INSERT INTO worker_leads … ON CONFLICT DO NOTHING RETURNING` (`LeadDeliveryService.claim`): only newly inserted rows are pushed |

## 7. Version pinning (important)

Verified against npm/Prisma docs on 2026-10-10:
- Prisma ORM **7.10.x is the stable line**; **Prisma 8 is still a release candidate** (final expected Oct 2026).
- `npm install prisma` currently resolves to the **8.0 RC CLI, which does not read `schema.prisma` and has no `generate`/`migrate dev`/`db push`**. The project must pin `prisma@7.10.0` and `@prisma/client@~7.10` exactly.
- Prisma 7 specifics we will follow: `prisma.config.ts` holds the datasource URL and the `migrations.seed` command; `generator client { provider = "prisma-client" }` with an explicit `output`; PostgreSQL via the `@prisma/adapter-pg` driver adapter; `.env` is not auto-loaded (load `dotenv` in the config); `migrate dev` does not auto-run seeds.
- Re-evaluate Prisma 8 after GA; the migration guide supports running 7 and 8 side by side.

## 8. Time zone and timestamps

All timestamps are `timestamptz` and every app connection is pinned to the **UTC** session time zone (`src/prisma/pg-adapter.ts`). This was added after a test showed that Prisma's pg adapter stores timestamps shifted by the *server's* own zone when it is not UTC (a local PostgreSQL set to Asia/Calcutta stored rows 5 h 30 min off, invisible in app-only round trips but wrong for SQL `now()` and tools like pgAdmin). `test/timestamps.e2e-spec.ts` guards against regressions. "Today" for earnings is still computed in `Asia/Kolkata` in application code (Phase 6).
