# 08 · Phase 7, Milestone B: designs awaiting your approval

Status: **proposals only**. Nothing here is implemented, no migration exists under `prisma/`, and no database has been
touched. Each section ends with the exact questions I need answered before building it.

---

## 1. `DELETE /me`: account deletion by anonymisation (Q-17)

### 1.1 Why anonymise instead of delete the rows

A user row cannot simply be deleted. `jobs.customer_id` references `customer_profiles`, and `jobs.worker_id`,
`offers`, `reviews` and `payments` hang off the profiles, with no cascade (deliberately: a job is a record two people
rely on). Deleting a customer would either fail or erase the worker's earnings history, and deleting a worker would
erase customers' receipts and ratings. So: **remove everything that identifies the person, keep the records the other
party and the business still need, with the person replaced by "Deleted user".**

### 1.2 Contract

`DELETE /api/v1/me` (authenticated).

| Case | Answer |
|---|---|
| Done | `204`. Every refresh token is gone, the account can no longer log in, and the realtime connections are closed |
| The user has an active job (below) | `409 ACTIVE_JOB_BLOCKS_DELETION`, body lists the user's own blocking jobs (`id`, `reference`, `status`, `role`). Nothing is changed |
| An admin account | `409 ADMIN_CANNOT_DELETE_SELF` (proposed: another admin must demote them first) |
| Wrong or missing confirmation | `422` |
| Too many attempts | `429` (proposed 3 per hour per user) |
| Called again after deletion | the old access token gets `403 ACCOUNT_DISABLED` until it expires (15 min), then `401` |

**Active job** = the user is the customer or the assigned worker of a job in `OPEN`, `ASSIGNED`, `ARRIVED`,
`IN_PROGRESS` or `WORK_COMPLETED` (so payment is still to be recorded), or has an `OPEN` SOS alert. `COMPLETED` and
`CANCELLED` never block. Things that do **not** block and are handled for the user: their pending quotes are set to
`WITHDRAWN`, and direct requests addressed to them are declined (the customer is told, as for any decline).

**Confirmation (needs your decision, section 1.6):** I recommend re-verifying by OTP, because the access token alone
(15 minutes, on a lost phone) must not be enough for something irreversible: the app calls `POST /auth/otp/request`,
then `DELETE /me` with `{ "code": "123456", "confirm": true }`.

### 1.3 What happens, in order (one idempotent operation; safe to retry)

1. Re-check there is no active job, taking a row lock on the user so a quote cannot be accepted in between
   (the same lock order the accept path already uses, to be verified in code review).
2. Delete the user's files from storage first, then their rows: Aadhaar images (private bucket), profile photo, and
   problem photos / voice notes / work photos of the user's own jobs. A delete of a missing object counts as success,
   so a retry after a crash finishes the job. If storage is down the call fails with `502` and changes nothing else.
3. In one database transaction: anonymise (table below), delete refresh tokens, withdraw pending quotes, mark the
   user inactive and deleted.
4. After commit: close the user's Socket.IO connections; write one log line with the user id only.

### 1.4 What is removed, kept and why

| Data | Treatment | Why |
|---|---|---|
| `users.phone` | replaced by a unique tombstone (`del` + 12 hex characters of the id, 15 characters, fits the column); the real number is gone | Identifies the person. Frees the number: signing up again later makes a **brand-new** account with no link to the old one |
| `users.language`, `is_admin`, `is_active` | `language` reset, `is_admin` stays false, `is_active=false` | Not identifying; inactive blocks login |
| `refresh_tokens` | deleted | Session data |
| `otp_challenges` for the old number | deleted | Keyed by phone number |
| Customer profile | `full_name` -> "Deleted user", `photo_key` removed (object deleted); preferences reset | Name and photo |
| `addresses` | deleted | Home addresses |
| Worker profile | `full_name` -> "Deleted worker", `photo_key`, `upi_id`, `vehicle`, `badge`, `rejection_reason`, `skills`, `languages` cleared; `verification_status` set to `REJECTED` so the worker can never be discovered, quoted or accepted (K-36 rule); `rating_sum` and `review_count` kept | Personal and payment details; kept counters keep history arithmetic consistent |
| `worker_documents` (Aadhaar) | objects deleted from the private bucket, then rows | Most sensitive data we hold. Same deletion code as D-9 |
| `worker_locations` | deleted | Location data |
| `worker_trades`, `worker_leads` | deleted | No longer meaningful |
| Jobs (as customer or worker) | **kept**: id, number, category, area, status, timing, dates, bill items, payment, review | The other party's history and the business's accounts. The deleted person appears as "Deleted user/worker" |
| Job free text and address of a deleted **customer** | `address_line` replaced by "(removed)", `lat`/`lng` and `description` cleared, `arrival_code` cleared; `title` kept (proposed, see question 4) | The home address and anything typed about the problem |
| Job media (problem photos, voice notes, work photos) of those jobs | objects and rows deleted | Pictures of a home and a voice |
| `offers` | kept; `message` cleared; pending ones `WITHDRAWN` | Free text may contain contact details |
| `payments`, `bill_items` | kept unchanged | Financial records; retention period to be set with counsel |
| `reviews` | kept (rating and tags); tips stay recorded | They shape the other person's rating and history |
| `job_security_events` | kept; `ip` cleared on rows the user acted in | Security audit trail without the address |
| `sos_alerts` | kept as they are (user id is now the tombstone user) | Safety record; retention period to be set with counsel |
| Logs | already masked (phone numbers and tokens never logged in the clear) | Nothing to do |

What stays can still point to a tombstone user id; nothing that remains lets anyone recover the name, number,
address, photos or Aadhaar images.

### 1.5 Schema change this needs (not applied)

`users.deleted_at TIMESTAMPTZ(3) NULL`. It lets the code tell "deleted" from "disabled by an admin", gives the audit
trail its timestamp, and makes the operation idempotent (`deleted_at IS NOT NULL` -> already done). Additive, nullable,
no backfill, no lock beyond a metadata change. I would bring this migration to you for approval, with a backup first,
exactly as for the earlier ones. A separate audit table is **not** proposed: the user id and `deleted_at` are the
audit.

Code needed: a `delete(bucket, key)` on `StorageService` (the local and S3 providers; `StorageService` has only
presign and `exists` today), shared with D-9. The S3 role needs `s3:DeleteObject` on both buckets.

### 1.6 Tests I would write

Each rule above as an e2e test (refused with a job in each blocking status, as customer and as worker; not blocked by
`COMPLETED`/`CANCELLED`; quotes withdrawn; direct requests declined); the data table checked row by row against the
database afterwards (no phone, name, address, photo key, document row or token survives); the other party's views
still work (worker earnings, customer receipt, ratings) and show "Deleted user"; re-signing up with the same phone
creates a different user; a retry after a simulated storage failure completes; two simultaneous deletions give one
success; a quote accepted concurrently with deletion cannot strand a job; unit tests for the tombstone; and mutation
checks of each guard.

### 1.7 Questions for you

1. **Confirmation:** OTP re-verification (recommended) or just a typed confirmation?
2. **Admins:** refuse self-deletion of an admin account (proposed)?
3. **Disabled accounts:** may a disabled (admin-blocked) user delete their account? I lean no (you may need the data
   for an investigation), but that is a policy decision, and the DPDP Act may say otherwise: counsel.
4. **Job `title`:** keep it (the worker's history stays readable) or clear it too (it is free text)?
5. **Retention of `payments`, `bill_items`, `reviews` and `sos_alerts`:** how long, and does counsel agree they may be
   kept at all after deletion? I have not set any period.
6. **Migration:** approve `users.deleted_at` (section 1.5) as a separate, backed-up step?

---

## 2. D-9: delete Aadhaar images N days after the decision (`reviewed_at` migration)

### 2.1 The gap

D-9 deletes the Aadhaar images `AADHAAR_RETENTION_DAYS` (default 7, allowed 0 to 30) after the VERIFIED or REJECTED
decision. The database has `verified_at`, set only on approval, and **nothing for a rejection**. Also, D-9 says the
reviewer id and decision time "stay as the audit trail", but the reviewer id is **only written to the log line**
(`admin=<id> VERIFIED worker=<id>` in `worker-verification.service.ts`); no column holds it.

### 2.2 Proposed schema change

Offline-generated by Prisma (`migrate diff` between the current schema and a copy with the two fields; no database was
connected):

```sql
-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Plus the backfill, hand-written (Prisma does not write data statements), in the same migration after the above:

```sql
-- Existing decisions: approvals keep their own timestamp. A rejection never had one, so the profile's
-- last-update time is the closest honest value (it can only be LATER than the decision, so images are
-- deleted slightly late, never early). PENDING workers have no decision.
UPDATE "worker_profiles"
SET    "reviewed_at" = COALESCE("verified_at", "updated_at")
WHERE  "verification_status" IN ('VERIFIED', 'REJECTED')
  AND  "reviewed_at" IS NULL;
```

`prisma/schema.prisma` gets `reviewedAt DateTime? @map("reviewed_at") @db.Timestamptz(3)`, `reviewedById String?
@map("reviewed_by") @db.Uuid` and the relation `reviewedBy User? @relation("WorkerReviewer", ..., onDelete: SetNull)`
(naming the existing `user` relation as well, since a model with two relations to `User` needs both named; verified in
the offline diff above).

### 2.3 Impact and safety

| Question | Answer |
|---|---|
| Locks and speed | Both columns are nullable with no default, so `ADD COLUMN` is a catalogue change (no table rewrite). The foreign-key creation briefly scans `worker_profiles`; with thousands of rows this is milliseconds. The backfill touches only decided workers: **0 rows on the dev database today** (it has no workers) and on the test database after a run |
| Compatibility | Additive. The old code ignores the columns, so the migration can be applied before the new code is deployed and the old code keeps running |
| Why not a `CHECK` that ties `reviewed_at` to the status | Many e2e helpers set `verification_status` directly; such a check would fail them, and it adds nothing the code does not already do. Instead the sweep treats a `NULL` `reviewed_at` as "no decision time, never delete automatically" |
| Index | Not proposed: the sweep reads `worker_profiles` once per run; a few thousand rows do not need one. Revisit beyond about 100k workers |
| Rollback | Prisma migrations are forward-only. To undo: `ALTER TABLE worker_profiles DROP CONSTRAINT worker_profiles_reviewed_by_fkey, DROP COLUMN reviewed_by, DROP COLUMN reviewed_at;` which loses only the two columns' values. **Before any rollback, set `AADHAAR_RETENTION_DAYS` off** (see below) so the sweep cannot run without them. The real point of no return is not the migration but the sweep: **deleted images cannot be restored**, by design |
| Backup | Taken and verified with `pg_restore --list` before applying, as for the earlier migrations; restore procedure in the runbook |
| Data left behind by a half-applied run | None: the file is one migration, applied in one transaction by `prisma migrate deploy` |

### 2.4 Code that goes with it (a later step, after the migration is approved)

- Set `reviewed_at` (and `reviewed_by` for manual decisions; null for the dev auto-approval) in `approve`, `reject`
  and `autoApproveIfEligible`. Clear both when the profile returns to PENDING (D-8 changes, a replaced Aadhaar
  image), as `verified_at` is cleared today.
- `StorageService.delete(bucket, key)` for the local and S3 providers (`s3:DeleteObject` for the task role).
- A scheduled sweep (the hourly purge job already exists for auth data): select documents of workers with `reviewed_at`
  older than the retention window and status VERIFIED or REJECTED; **delete the object first, then the row**; log the
  worker id and count, never the key; one failure never stops the batch; idempotent.
- `AADHAAR_RETENTION_DAYS` in `env.validation.ts` (integer 0 to 30, default 7), plus an explicit way to switch the sweep
  off for rollback.
- Worker view: `documents.*` false after deletion (the field is already derived from rows); the app needs a
  "re-upload required" state when a later re-review needs images (frontend gap G-15).
- Remaining D-9 item outside the code: an S3 lifecycle rule on the private bucket as a hard cap, versioning off.

### 2.5 Tests I would write

- **Migration:** column exists and is nullable; the foreign key is `SET NULL` (deleting the reviewer admin keeps the
  worker); the backfill statement run against fixture rows (VERIFIED with `verified_at`, REJECTED without, PENDING)
  gives the intended values, in `db-constraints.e2e-spec.ts`, against the test database after you approve applying it
  there.
- **Writes:** approve, reject, auto-approve set the fields; each path back to PENDING clears them.
- **Sweep:** deletes only past the window; never PENDING; never `NULL` `reviewed_at`; object before row; a storage
  failure leaves the row for the next run; one worker's failure does not stop others; logs contain no key;
  `documents.*` false afterwards; window 0 and 30; switch off works.
- Mutation checks of each rule.

### 2.6 Questions for you

1. **Add `reviewed_by` as well as `reviewed_at`?** D-9 assumes the reviewer id is kept, but today it is only in the log.
   I recommend yes (it is the audit trail D-9 describes).
2. **Backfill choice** for REJECTED rows: `updated_at` as above (never early), or leave them `NULL` (never deleted
   automatically, to be cleaned by hand)? It only matters for data that exists before the migration.
3. **Approve applying it** to the test database first, then the dev database after a verified backup?
4. **Counsel:** sign-off on collecting Aadhaar images at all is still open (D-9), and I have not assumed the answer.
