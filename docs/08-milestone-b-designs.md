# 08 · Phase 7, Milestone B: designs awaiting your approval

Status: **design documents.** Section 1 (`DELETE /me`) is **not implemented** and will not be until you approve this
final design. Section 2 (D-9) describes a migration that exists on a separate local branch and is applied to the
**test database only**. No other database has been touched. Each section ends with what I still need from you.

---

## 1. `DELETE /me`: account deletion by anonymisation (Q-17), final design for approval (v3)

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

**Door B: a disabled account (`POST /auth/deletion-requests`, public, strictly throttled). Decided by you: OTP proves
control of the registered number, and an admin must approve.** A disabled user cannot
hold a session (login and refresh are refused), so the authenticated route cannot work for them. Instead they prove
control of the number with an OTP and submit `{ "phone", "code" }`. This **records a request** (it does not delete):
the account was disabled for a reason, possibly an investigation or a safety case, and a code alone (SIM-swap is a
real risk) must not be enough to destroy it. An admin then reviews the request in a short queue
(`GET /admin/deletion-requests`) and approves or declines it (`POST /admin/deletion-requests/:userId/approve|decline`,
logged with the admin id). Approval runs the same operation as Door A. The public route answers the same way for
every phone number (`202`, "if this number belongs to an account, your request has been received"), so it cannot be
used to find out who has an account. How quickly a request must be answered is a legal question (1.6).

*Considered and rejected:* the OTP alone deleting a disabled account at once. It would let a SIM-swap destroy a flagged
account's evidence.

**Door B details that follow from the decision.** The request records `users.deletion_requested_at`; an admin sees the
queue, approves or declines (the decision and the admin id are logged, never the phone number in the clear); a decline
keeps the account disabled and the request closed. Approval refuses (`409`) if the user has an active job at that moment
and if the account is an admin account. The person is not told the outcome by SMS until an SMS template for it exists
(MSG91 is not built), so until then the answer is given through support; that is an open operational point, not a code
question.

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
| Job free text and address of a deleted **customer** | `address_line` replaced by "(removed)"; `lat`, `lng`, `description` and `arrival_code` cleared; **`title` replaced by the service name** (the category's English title, for example "Plumber"; the column is required, so a neutral label is stored) | The home address and anything typed about the problem, **including the typed title**. What stays is what the business and the other party need: the job number, service, area, dates, status, bill amounts, payment and rating |
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
| Job `title` and offer text | **Decided: `title` cleared to the service name**; offer `message` cleared | Nothing further; recorded so counsel can see it |
| Bill item descriptions (text the worker typed on the bill, for example "replaced the kitchen tap") | **Kept as written**, because they are lines of a financial record | Do invoice line descriptions have to stay verbatim, or may they be generalised to the item kind after deletion? I have not assumed either |
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

### 1.9 Where this stands

**Settled by you:** OTP reconfirmation; admin self-deletion refused; refused during active jobs; Door B as an OTP-verified
request that an admin approves; the typed job title cleared to the service name while the business history is kept;
retention periods left to counsel.

**Still needed before I implement anything:**
1. **Your approval of this final design (v3) as a whole.** I will not start until you give it.
2. **Approval of the two column additions** (1.7) as a separate, backed-up step, in the same way as D-9.
3. **Counsel's answers** to the table in 1.6. I will build with the defaults in the middle column, each a single constant
   or query to change, and nothing is switched on in production before they are given.
4. **An operational answer** for telling a Door B requester the outcome until an SMS template exists (see 1.2).

---

## 2. D-9: the decision audit migration (`reviewed_at`, `reviewed_by`)

**Status.** Drafted and tested. The files are on the local branch `feature/phase-7-d9-reviewed-at` (not pushed).
**Applied to the isolated test database `KaamConnect_test` only**, after proving by name that it is the test database
(its name ends in `_test` and it is not the development database). **Not applied to the development database or
anywhere else**; that needs your separate approval and the backup plan in 2.6.

### 2.1 Is the schema change justified? Yes, for both columns

D-9 deletes the Aadhaar images `AADHAAR_RETENTION_DAYS` (default 7, allowed 0 to 30) after the VERIFIED or REJECTED
decision, and says the reviewer id and decision time "stay as the audit trail". Today:

- `verified_at` exists, but is set **only on approval**. A rejection leaves no time at all, so a retention clock cannot
  be counted for rejected workers. It is also cleared whenever a profile returns to PENDING, so it is not a decision
  log.
- The reviewer's id is **only written to the log line** (`admin=<id> VERIFIED worker=<id>`); no column holds it, so the
  audit trail D-9 describes does not exist.

So `reviewed_at` (when) and `reviewed_by` (who) are both needed, and neither can be derived from existing columns.

### 2.2 What the migration contains

File: `prisma/migrations/20261011200000_worker_review_audit/migration.sql`. The first two statements are exactly what
Prisma derives from the schema change (compared statement by statement, offline); the third is hand-written.

```sql
ALTER TABLE "worker_profiles" ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" UUID;

ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "worker_profiles" SET "reviewed_at" = "verified_at"
WHERE  "verification_status" = 'VERIFIED' AND "verified_at" IS NOT NULL AND "reviewed_at" IS NULL;
```

`prisma/schema.prisma` gains `reviewedAt DateTime?` and `reviewedById String?` on `WorkerProfile`, the relation
`reviewedBy` (`onDelete: SetNull`) and, on `User`, `reviewedWorkers`. A model with two relations to `User` needs both
named (`WorkerUser`, `WorkerReviewer`); the existing `user` relation keeps its behaviour (a test proves deleting the
worker still cascades the profile). Six added lines, two changed; the rest of the file is untouched.

### 2.3 Backfill: nothing is invented

| Existing row | `reviewed_at` | `reviewed_by` | Why |
|---|---|---|---|
| VERIFIED with a recorded `verified_at` | copied from `verified_at` | **NULL** | The time was recorded; the reviewer never was |
| VERIFIED with no `verified_at` | NULL | **NULL** | Nothing recorded, nothing guessed |
| REJECTED | **NULL** | **NULL** | A rejection never had a time. I did **not** use `updated_at` as a stand-in (my earlier draft did); a made-up time is worse than an honest gap |
| PENDING | NULL | NULL | No decision |

Consequence, and the rule for the sweep that comes later: **a NULL decision time means "unknown, never delete
automatically"**, and any such legacy row is cleaned by hand. It matters only for data that exists before the
migration: the development database has no workers and production does not exist yet.

### 2.4 Impact and safety

| Question | Answer |
|---|---|
| Locks and speed | Both columns are nullable with no default, so `ADD COLUMN` rewrites nothing. **But the three statements run in one transaction, so the locks they take are held until it commits:** `ACCESS EXCLUSIVE` on `worker_profiles` (from `ADD COLUMN`) and `SHARE ROW EXCLUSIVE` on `users` (from the foreign key). Measured (2.10): about 0.23 s in total at 50,000 workers, of which the backfill is 215 ms; reads of `worker_profiles` and writes to `users` wait for that long. At a few thousand workers it is a few tens of milliseconds |
| Compatibility | Additive. The running code ignores the columns, so the migration can be applied **before** the code that uses it is deployed, and the old code keeps working |
| Why no `CHECK` tying `reviewed_at` to the status | Many e2e helpers set `verification_status` directly and a check would fail them; the code enforces the pairing instead, and the sweep treats NULL as unknown |
| Index | None. The sweep reads `worker_profiles` once per run; revisit beyond about 100,000 workers |
| Reviewer removed | `ON DELETE SET NULL`: removing an admin never removes or blocks a worker; the decision time stays. Tested |
| Drift | After applying to the test database, `prisma migrate diff` between that database and `schema.prisma` reports **no difference** |
| Side effect to know about | The test harness runs `migrate deploy` on `KaamConnect_test` at the start of every e2e run. The test database now has this migration recorded, so **a branch that does not contain the migration should still run against it** (checked: see the report), but the migration file travels with this branch when it is merged |

### 2.5 Rollback

Prisma migrations are forward-only. The reverse, which only loses the two columns' values:

```sql
ALTER TABLE "worker_profiles"
  DROP CONSTRAINT "worker_profiles_reviewed_by_fkey",
  DROP COLUMN "reviewed_by",
  DROP COLUMN "reviewed_at";
```

Also delete the row for `20261011200000_worker_review_audit` from `_prisma_migrations`, otherwise `migrate deploy` believes
it is still applied. The rollback SQL was executed on the **test** database inside a transaction that was rolled back
(the columns disappeared inside it and were back afterwards), so it is known to be valid. **Before any rollback, the
sweep must be switched off** (the code that will use these columns does not exist yet; when it does, it ships with an
off switch). The real point of no return is not this migration but the sweep: **deleted images cannot be restored**, by
design.

### 2.6 Plan to apply it to the development database (only after your separate approval)

1. Confirm the target out loud: host, database name `KaamConnect`, `NODE_ENV`, current migration list (4 applied) and
   row counts (0 users, 0 jobs, reference data only), read-only.
2. Backup: `pg_dump --format=custom` of `KaamConnect` into the backups folder **outside both repositories** (the same
   place and format as before), then `pg_restore --list` on it and a size check. Stop if either fails.
3. Apply with `npm run db:migrate` (apply-only; never resets).
4. Verify: `prisma migrate status` (5 applied, up to date), `prisma migrate diff` against the schema (no difference),
   the two columns and the foreign key exist as written, row counts unchanged.
5. Restore instructions, if anything is wrong: drop and recreate `KaamConnect`, then `pg_restore -d KaamConnect <dump>`;
   or run the rollback SQL in 2.5 and delete the `_prisma_migrations` row.

### 2.7 Tests (written; all pass; in `test/db-constraints.e2e-spec.ts`)

Columns exist, nullable, no default, right types. A new worker has no decision. A reviewer can be recorded and an
unknown reviewer is refused by the foreign key. Removing the reviewer sets `reviewed_by` NULL and keeps the time and the
worker. Deleting the worker still cascades. The backfill (read from the migration file itself): copies a recorded
approval time; leaves approved-without-time, REJECTED and PENDING NULL; never sets a reviewer; does not overwrite an
existing decision time; running it twice changes nothing; leaves a worker who went back to PENDING alone.

**Mutation checks** (the backfill SQL broken on purpose, then restored): inventing a time for REJECTED and for approved
workers without one, setting a reviewer, and overwriting an existing time. Each made a test fail.

### 2.8 What comes after approval (not built; the migration alone changes no behaviour)

- Set `reviewed_at` and `reviewed_by` in `approve`, `reject` and (with a NULL reviewer) the dev auto-approval; clear
  both when a profile returns to PENDING (D-8 changes, a replaced Aadhaar image).
- `StorageService.delete(bucket, key)` for the local and S3 providers (shared with `DELETE /me`; `s3:DeleteObject`).
- A scheduled sweep: documents of workers whose `reviewed_at` is older than the window and whose status is VERIFIED or
  REJECTED; object first, then row; never on a NULL time; a failure never stops the batch; idempotent; logs the worker
  id and a count, never a key; an explicit off switch.
- `AADHAAR_RETENTION_DAYS` (integer 0 to 30, default 7) in the environment validation.
- Worker view: `documents.*` false after deletion; the app needs "re-upload required" copy (G-15).
- An S3 lifecycle rule on the private bucket as a hard cap, versioning off.
- Tests for each, with mutation checks.

### 2.9 What I need from you

1. **Approve applying the migration to the development database**, with the backup plan in 2.6, when you are ready.
   Until then it stays test-only.
2. **Approve merging** the migration file (it travels with the branch). Merging does not apply it anywhere: the
   release step does, and dev is applied by hand.
3. **Counsel:** sign-off on collecting Aadhaar images at all, and on 7 days, is still open (D-9).

### 2.10 Review of the migration (2026-10-11): evidence, not a re-read

Everything below was run against `KaamConnect_test` in a **throwaway schema** (`kc_scratch_d9`, created and dropped by a
script that refuses any database not named `*_test`, refuses to reuse an existing schema name, and dropped only that
schema). The test database's own tables were not touched.

| Check | Result |
|---|---|
| The whole migration chain (all 5 files) applied to an **empty** schema, as CI does | **Succeeded in 2.8 s**; 5 migrations recorded |
| `prisma migrate diff` between that fresh result and `schema.prisma` | **No difference** |
| The SQL the migration contains versus what Prisma derives from the schema change | The two schema statements match exactly (compared statement by statement, offline); the third is the hand-written backfill |
| The migration on **50,000 workers** (one third approved, one third rejected, one third pending) | `ADD COLUMN` 1.5 ms, foreign key 13.0 ms, backfill 215.1 ms (16,666 rows). Total about 0.23 s |
| Locks held until commit | `ACCESS EXCLUSIVE` on `worker_profiles`; `SHARE ROW EXCLUSIVE` on `worker_profiles` and on `users` |
| Backfill outcome at that scale | Exactly the 16,666 approved rows got a time; **0 rows** got a reviewer; rejected and pending rows kept a NULL time |
| The rollback SQL | Valid (run inside a transaction that was rolled back; the columns disappeared inside it and were back afterwards) |

**Findings.**
1. *(Corrected here.)* My first description said the foreign key "briefly scans `worker_profiles`". It also takes a lock
   on `users`, and the locks last until the whole migration commits. The duration is negligible at launch scale, but the
   statement was incomplete.
2. *Not a defect, but know it:* if `worker_profiles` ever reached millions of rows, the foreign key should be added
   `NOT VALID` and validated separately to avoid holding the lock. At the scale of this product that is unnecessary.
3. *Rollback detail:* after running the reverse SQL, the `_prisma_migrations` row for this migration must be removed by
   hand, since Prisma has no down migration. That is a manual step on a production database and belongs in the runbook
   (done: `10-runbook.md`, section 2.2 already says migrations are fixed forward; this adds the exception).
4. *Test dependency:* the backfill test reads the migration file from `prisma/migrations/...` using the working
   directory, which is the repository root under both Vitest and CI.
5. *No defect found* in the backfill: it is idempotent (`reviewed_at IS NULL` guard), never writes `reviewed_by`, and
   leaves rows with no recorded time alone.

**Residual risks.** The application code that will write the new columns and the retention sweep do not exist yet, so
this migration changes no behaviour; the real risk of D-9 is the later sweep (deleted images cannot be restored), which
will ship with an off switch and its own review. Counsel's sign-off on Aadhaar images is still open.
