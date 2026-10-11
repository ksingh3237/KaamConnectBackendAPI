# 08 · Phase 7, Milestone B: designs awaiting your approval

Status: **proposals only**. Nothing here is implemented, no migration exists under `prisma/`, and no database has been
touched. Each section ends with the exact questions I need answered before building it.

---

## 1. `DELETE /me`: account deletion by anonymisation (Q-17), final design for approval

Status: **design v2, incorporating your decisions; not implemented.** I will not start until you approve it.

**Your decisions, as built into this design:** the person re-confirms with an OTP; an admin cannot delete their own
account; deletion is refused while the user has an active job; a disabled user may ask for deletion only after safe
identity verification; necessary business history is kept and personal data removed; every retention period that is
a legal question is listed in 1.6 for sign-off and none is assumed.

### 1.1 Why anonymise instead of delete the rows

A user row cannot simply be deleted. `jobs.customer_id` references `customer_profiles`, and `jobs.worker_id`,
`offers`, `reviews` and `payments` hang off the profiles, with no cascade (deliberately: a job is a record two people
rely on). Deleting a customer would fail or erase the worker's earnings history; deleting a worker would erase
customers' receipts and ratings. So: **remove everything that identifies the person, keep the records the other party
and the business still need, with the person replaced by "Deleted user".**

### 1.2 Two doors to the same operation

**Door A: an active account (`DELETE /api/v1/me`, authenticated).** The app asks for a code with the existing
`POST /auth/otp/request`, then calls `DELETE /me` with `{ "code": "123456", "confirm": true }`. Both are needed: the
session proves the device, the code proves control of the phone number, so a stolen access token alone cannot erase an
account. The code is checked with the same rules as login (5 wrong tries per code, single use, 5 minutes) but **does
not create a session**.

**Door B: a disabled account (`POST /auth/deletion-requests`, public, strictly throttled).** A disabled user cannot
hold a session (login and refresh are refused), so the authenticated route cannot work for them. Instead they prove
control of the number with an OTP and submit `{ "phone", "code" }`. This **records a request** (it does not delete):
the account was disabled for a reason, possibly an investigation or a safety case, and a code alone (SIM-swap is a
real risk) must not be enough to destroy it. An admin then reviews the request in a short queue
(`GET /admin/deletion-requests`) and approves or declines it (`POST /admin/deletion-requests/:userId/approve|decline`,
logged with the admin id). Approval runs the same operation as Door A. The public route answers the same way for
every phone number (`202`, "if this number belongs to an account, your request has been received"), so it cannot be
used to find out who has an account. How quickly a request must be answered is a legal question (1.6).

*Alternative for Door B, if you prefer it simpler:* the OTP alone deletes a disabled account at once. I do not
recommend it, for the reason above, but it removes the admin queue.

| Case | Answer |
|---|---|
| Door A done | `204`. Refresh tokens deleted, realtime connections closed, the account can no longer log in |
| Door A, active job | `409 ACTIVE_JOB_BLOCKS_DELETION`, body lists the caller's own blocking jobs (`id`, `reference`, `status`, `role`). Nothing changed |
| Door A, admin account | `409 ADMIN_CANNOT_DELETE_SELF` (an admin must be demoted by another admin first; an admin account also cannot be approved for deletion through Door B) |
| Door A, wrong, expired or reused code | `401 OTP_INVALID` (same body as login), counts against the code's 5 attempts |
| Door A, missing confirmation | `422` |
| Door A, disabled account | `403 ACCOUNT_DISABLED` with a pointer to Door B |
| Door B | `202` always (generic); `429` when throttled (proposed 3 per hour per number and 5 per hour per IP) |
| Admin approves while the user now has an active job | `409`, the request stays pending |
| Called again after deletion | the old access token gets `403 ACCOUNT_DISABLED` until it expires (15 min), then `401` |

**Active job** = the user is the customer or the assigned worker of a job in `OPEN`, `ASSIGNED`, `ARRIVED`,
`IN_PROGRESS` or `WORK_COMPLETED` (payment still to be recorded), or has an `OPEN` SOS alert. `COMPLETED` and
`CANCELLED` never block. Handled for the user and not blocking: pending quotes are set to `WITHDRAWN`; direct requests
addressed to a worker are declined (the customer is told, as for any decline).

### 1.3 What happens, in order (one idempotent operation, safe to retry)

1. Take a row lock on the user and re-check there is no active job, so a quote cannot be accepted in between. The
   concurrency rule (a customer accepting this worker's quote while the worker deletes themselves) must be **proven by
   a two-transaction test before it ships**; I have not yet verified the lock order in the accept path.
2. Delete the user's files from storage first, then their rows: Aadhaar images (private bucket), profile photo, and the
   problem photos / voice notes / work photos of the user's own jobs. Deleting a missing object counts as success, so
   a retry after a crash finishes the job. If storage is unreachable the call fails (`502`) and nothing else changes.
3. In one transaction: anonymise (1.4), delete refresh tokens, withdraw pending quotes, set `deleted_at`.
4. After commit: close the user's Socket.IO connections; write one log line with the user id only, and append the user
   id and date to the **deletion ledger** (1.5).

### 1.4 What is removed, kept and why

| Data | Treatment | Why |
|---|---|---|
| `users.phone` | replaced by a unique tombstone (`del` + 12 hex characters of the id, 15 characters, fits the column); the real number is gone | Identifies the person. Frees the number: signing up again later makes a **brand-new** account with no link to the old one |
| `users.language`, `is_admin`, `is_active` | `language` reset, `is_admin` stays false, `is_active=false` | Not identifying; inactive blocks login |
| `refresh_tokens` | deleted | Session data |
| `otp_challenges` for the old number | deleted | Keyed by phone number |
| Customer profile | `full_name` -> "Deleted user", `photo_key` removed (object deleted); preferences reset | Name and photo |
| `addresses` | deleted | Home addresses |
| Worker profile | `full_name` -> "Deleted worker"; `photo_key`, `upi_id`, `vehicle`, `badge`, `rejection_reason`, `skills`, `languages` cleared; `verification_status` set to `REJECTED` so the worker can never be discovered, quoted or accepted (K-36 rule); `rating_sum` and `review_count` kept | Personal and payment details; the kept counters keep history arithmetic consistent |
| `worker_documents` (Aadhaar) | objects deleted from the private bucket, then rows | Most sensitive data held. Same deletion code as D-9 |
| `worker_locations`, `worker_trades`, `worker_leads` | deleted | Location data; no longer meaningful |
| Jobs (as customer or worker) | **kept**: id, number, category, area, status, timing, dates, bill items, payment, review | The other party's history and the business's accounts. The deleted person appears as "Deleted user/worker" |
| Job free text and address of a deleted **customer** | `address_line` replaced by "(removed)"; `lat`, `lng`, `description` and `arrival_code` cleared; `title` kept (proposed: it is what makes the worker's history readable, but it is free text, so it is on the sign-off list) | The home address and anything typed about the problem |
| Job media of those jobs | objects and rows deleted | Pictures of a home and a voice |
| `offers` | kept; `message` cleared; pending ones `WITHDRAWN` | Free text may contain contact details |
| `payments`, `bill_items` | kept unchanged | Financial records; period in 1.6 |
| `reviews` | kept (rating and tags); tips stay recorded | They shape the other person's rating and history |
| `job_security_events` | kept; `ip` cleared on rows the user acted in | Security audit trail without the address |
| `sos_alerts` | kept (user id is now the tombstone user) | Safety record; period in 1.6 |
| Logs | already masked (phones and tokens never in the clear); contain user ids | Retention period in 1.6 |

What stays can still point to a tombstone user id; nothing that remains lets anyone recover the name, number, address,
photos or Aadhaar images.

### 1.5 Backups, restores and the deletion ledger (easy to get wrong)

A deleted person's data still exists in **older backups**, and restoring an old backup would **bring deleted accounts
back**. So: (a) backup retention must be a stated period (1.6), and (b) every deletion appends `user id + date` (no
personal data) to a ledger kept outside the database (the durable log sink, and a copy with the backups), and the
restore procedure in the runbook gets a step that **re-applies every ledger entry newer than the backup** with an
operator script before the application is reopened. The script runs the same anonymisation routine without the OTP
(operator-only, logged). I would write that script and a test for it as part of the build.

### 1.6 Retention and legal decisions: **none is assumed; each needs sign-off from counsel**

| Item | What I propose to build as the default | Question for counsel |
|---|---|---|
| `payments`, `bill_items`, job rows (accounting records) | Kept indefinitely until a period is set | How long must or may they be kept after the account is gone, and may they stay linked to the (anonymised) account? |
| `reviews` and tips | Kept | May ratings stay after deletion, and for how long? |
| `sos_alerts` (and the location in them) | Kept as they are | Safety/legal retention period; should coordinates be cleared after some time? |
| `job_security_events` (IP cleared on deletion) | Kept without the IP | Is the pseudonymous audit trail acceptable, and for how long? |
| Job `title` and offer text | `title` kept, offer `message` cleared | Is a free-text title personal data to be cleared? |
| Aadhaar images | Deleted at account deletion (and 7 days after the decision under D-9) | Is collecting them lawful at all, and is 7 days right? |
| Application logs | Masked already; retention period to be set with the hosting choice | Maximum retention |
| Database backups | Retention period to be set with the hosting choice (1.5) | Maximum time deleted data may remain in backups |
| Deletion ledger (user id + date) | Kept indefinitely | Acceptable as a record that deletion happened? |
| Time limit to act on a request (Door B) and the right to refuse (investigation hold) | An admin answers within days, not stated in code | The statutory deadline and grounds for refusing |
| Who may request on behalf of a person (a family member, a lost SIM) | Nobody: OTP to the number only | Whether a manual identity process is needed |

### 1.7 Schema changes this needs (not applied; to come to you for approval with a backup, as before)

- `users.deleted_at TIMESTAMPTZ(3) NULL`: tells "deleted" from "disabled by an admin", gives the audit its timestamp,
  makes the operation idempotent.
- `users.deletion_requested_at TIMESTAMPTZ(3) NULL` for Door B (the admin queue is `WHERE deletion_requested_at IS NOT
  NULL AND deleted_at IS NULL`). A request table is not proposed: one pending request per user is enough, and the
  decision is logged with the admin id.

Both are additive, nullable, no backfill, metadata-only. Code needed: `StorageService.delete(bucket, key)` (local and
S3; shared with D-9; the S3 role needs `s3:DeleteObject` on both buckets) and a way to verify an OTP without issuing a
session.

### 1.8 Tests I would write

Door A: refused with a job in each blocking status as customer and as worker; not blocked by `COMPLETED`/`CANCELLED`;
admin refused; wrong, reused, expired code refused and counted; a valid token **without** a code refused; quotes
withdrawn; direct requests declined. Door B: the answer is identical for registered, disabled and unknown numbers;
nothing is deleted before approval; a non-admin cannot approve; an admin account cannot be approved; approval with an
active job is refused. After deletion, row by row against the database: no phone, name, address, photo key, document
row or token survives; the other party's views still work (earnings, receipt, ratings) and show "Deleted user";
re-signing up with the same phone makes a different user; a retry after a simulated storage failure completes; two
simultaneous deletions give one success; a quote accepted at the same moment cannot strand a job; the ledger entry is
written; the restore script re-applies a ledger entry. Plus mutation checks of each guard.

### 1.9 Decisions I still need from you (everything else above is settled by your answers)

1. **Door B:** admin-approved request (recommended) or OTP-only immediate deletion?
2. **Job `title`:** keep (proposed) or clear?
3. **Approve the two column additions** (1.7) as a separate, backed-up step when the time comes?
4. **Take 1.6 to counsel.** I will build with the defaults in the middle column unless told otherwise, and each is a
   single constant or query to change.

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
