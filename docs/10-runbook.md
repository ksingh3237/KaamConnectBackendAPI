# 10 · Operations runbook (draft)

Status: **a draft written before hosting is chosen**, so it is host-neutral: it names the commands the application
itself provides and the checks that apply wherever it runs. Placeholders look like `<host>`. Nothing here has been run
against a production system, because none exists. Two things in it are **unproven and must be exercised once** before
launch: the restore drill (section 3) and real S3 behaviour (K-3). See `09-production-readiness.md` for the
configuration checklist.

---

## 1. The service in one page

| Fact | Value |
|---|---|
| Process | `node dist/main` (`npm run start:prod`), one instance at launch |
| Port | `PORT` (default 3000) |
| API | `/api/v1/...`; health is outside the prefix |
| Liveness | `GET /health` -> `200 {"status":"ok"}`; never touches the database |
| Readiness | `GET /health/ready` -> `200` when `SELECT 1` answers within 2 s, otherwise `503 DB_UNAVAILABLE`. The process stays up and recovers by itself when the database returns |
| Realtime | Socket.IO namespace `/realtime`; JWT checked at the handshake |
| Background work (inside the process) | job expiry every minute (logs `Expired N unanswered request(s)`, `Expiry run failed: ...`); auth purge every hour (`Purged ...`, `Purge failed: ...`); lead catch-up after a worker is freed |
| Database | PostgreSQL 18, extension `btree_gist`; all times stored in UTC |
| Files | S3 in production (public-by-signed-URL bucket and a private Aadhaar bucket) |
| Shutdown | `SIGTERM` is handled (shutdown hooks on): in-flight requests finish, the pool closes |

### Reading the logs

One line per finished request, with the route **template** (never real ids or query strings), status, time, request id,
user id and a masked address:

```
GET /api/v1/jobs/:id/bill 200 12ms req=3f1c... user=0197a0c0-... ip=203.0.113.x
```

Phones and tokens are masked in every line. Client errors are warnings, server errors are errors, health probes are
not logged. Every response carries `X-Request-Id`; ask a user who reports a problem for that value (or the time and
their user id) and search for `req=<id>`.

---

## 2. Release and rollback

### 2.1 Release (the order matters)

1. CI is green on the exact commit (lint, types, unit and e2e tests, coverage thresholds, build, audit, fresh-database
   migration, drift check, seed, smoke test).
2. **Take and verify a database backup first** (section 3.1).
3. Build the image or bundle (a stage that has the full dependencies: see `09-production-readiness.md` 2.3).
4. Apply migrations: `npm run db:migrate` (`prisma migrate deploy`). It applies only pending migrations, never resets,
   and runs each migration in one transaction. Check the output ends with "All migrations have been successfully
   applied" or "No pending migrations to apply".
5. First release only: `npm run db:seed` (reference data; safe to repeat).
6. Start the new version. Wait for `/health/ready` to answer 200, then make one real login and one read.
7. Watch the request log for 5xx and the two background-job error lines for ten minutes.

The smoke script (`scripts/smoke.sh`) needs the console OTP sender and automatic verification, so it cannot run against
production. Do not enable those settings to make it run: the application refuses to start with them in production.

### 2.2 Rollback

- **Application:** redeploy the previous build. This is safe as long as every migration since is additive (the project
  rule: new nullable columns, new tables, new enum values; no drops or renames in the same release as the code that
  stops using them).
- **A migration that should not have gone out:** Prisma migrations are forward-only. Fix forward with a new migration if
  you can. If you cannot, restore the pre-release backup (section 3.2), accepting the loss of everything written since
  the backup, and tell the team what that window was.
  **The one hand-written reversal on file** is for the D-9 migration (`08-milestone-b-designs.md` §2.5): the reverse SQL
  drops its foreign key and two columns, and then that migration's row is deleted from `_prisma_migrations` by hand
  (Prisma has no down migration). A second person reads both statements first, and a backup is taken before.
- Irreversible by design: deleted Aadhaar images (once D-9 exists), anonymised accounts (once `DELETE /me` exists), and
  the `JobTiming` value `SCHEDULED` (K-21, already in the migrations).

---

## 3. Backup and restore

### 3.1 Take a backup (this is how it was done for the development database, three times)

```bash
pg_dump --format=custom --no-owner --file=<name>-<date>.dump "<DATABASE_URL>"
pg_restore --list <name>-<date>.dump | head        # must print a table of contents, otherwise the dump is unusable
```

Keep dumps **outside both repositories** and outside the server that holds the database. On a managed database also
enable automated backups and, if offered, point-in-time recovery; a dump taken before a release is in addition to
them, not instead.

### 3.2 Restore (always into a new, empty database first)

```bash
createdb <scratch_db>
pg_restore --no-owner --dbname=<scratch_db> <name>-<date>.dump
DATABASE_URL=<scratch url> npx prisma migrate status      # expect: database schema is up to date
```

Compare row counts of the main tables with the source. Only after that decide whether to repoint the application, or to
restore over the original.

### 3.3 The restore drill (not yet done anywhere)

Before launch, once: take a backup of the staging database, restore it into a scratch database as above, start the
application against the scratch database, log in and read a job, and record how long each step took. That time is the
real recovery time; write it here.

| Date | Source | Backup size | Restore time | Result |
|---|---|---|---|---|
| (not yet run) | | | | |

---

## 4. Common problems

| Symptom | What it means | What to do |
|---|---|---|
| `GET /health/ready` is 503 | The database is unreachable or slow (over 2 s). The application is otherwise up | Check the database and the network path; do not restart the application, it recovers by itself |
| Many users get `429` at once | Rate limits are per IP. Behind a proxy with `TRUST_PROXY=0` every user looks like the proxy | Check `ip=` in the request log: if it is always the proxy's address, set `TRUST_PROXY` to the number of proxies and restart (needs approval: production setting) |
| Users report "OTP not received" | The SMS provider, not the application, in almost all cases. Per-phone limits (30 s between codes, 5 per hour) can also apply: the API answers 429 with a wait time | Check the provider's dashboard; check the request log for `POST /api/v1/auth/otp/request` and its status |
| A user says "my account is disabled" (`403 ACCOUNT_DISABLED`) | `users.is_active = false` | Check why (admin action, or account deletion once it exists). Re-enabling is a database update by an operator; the user's old refresh tokens were revoked when they were refused and they must log in again |
| A worker says "I can't see leads" | Not VERIFIED (new, or sent back for review after changing name or photo, D-8), no trade matching, outside radius, or declined | Read the worker's `verification_status`; admin review queue |
| A customer says "my job disappeared" | It expired (24 h open by default, shorter for a scheduled request) or was cancelled | `jobs.status`, `cancelled_by`, `cancel_reason` (`EXPIRED`) |
| A job is stuck in a state | The state machine only moves on actions by the customer, the worker or the expiry sweep | Read the job and its events (below). Do not edit statuses by hand without a second person; the worker-overlap constraint and the one-job-on-site index will refuse inconsistent writes |
| Arrival code locked | 5 wrong tries lock the job; the customer can issue a new code up to 3 times, 60 s apart; after that only cancel or the worker backing out frees it (K-27) | See the audit rows below |
| `SOS <id> was stored but the safety channel failed` in the log | The alert is in the database but did not reach a person. **Treat as urgent**: act on it manually | Query open alerts (below), contact the people involved by phone, then fix the webhook. There is no retry (K-28) |
| `Expiry run failed` or `Purge failed` in the log | A background run failed (usually the database was unreachable). It retries on the next tick | If it repeats, check the database; jobs that should have expired are still OPEN until it succeeds |
| Realtime events missing for some users | Push is best effort (K-18); with more than one instance, events do not cross instances (K-19) | The REST endpoints are the source of truth; apps refetch on reconnect |

### 4.1 Read-only queries (run against a read replica or in a read-only session)

```sql
-- Open SOS alerts, oldest first. Anything older than a few minutes needs a human right now.
SELECT id, job_id, user_id, status, created_at FROM sos_alerts WHERE status = 'OPEN' ORDER BY created_at;

-- Jobs whose arrival code is locked (5 wrong tries) and what was done about it.
SELECT j.id, j.job_number, j.status, j.arrival_attempts, j.arrival_code_resets, j.arrival_code_reset_at
FROM jobs j WHERE j.status = 'ASSIGNED' AND j.arrival_attempts >= 5;
SELECT type, detail, created_at FROM job_security_events WHERE job_id = '<job id>' ORDER BY created_at;

-- One job's money, quotes and state.
SELECT status, worker_id, assigned_at, arrived_at, work_completed_at, completed_at, cancelled_at, cancelled_by, cancel_reason
FROM jobs WHERE id = '<job id>';
SELECT kind, amount FROM bill_items WHERE job_id = '<job id>' ORDER BY created_at;
SELECT method, amount, status, marked_at FROM payments WHERE job_id = '<job id>';

-- Workers waiting for review, oldest first.
SELECT user_id, full_name, verification_status, created_at FROM worker_profiles
WHERE verification_status = 'PENDING' ORDER BY created_at;

-- Migrations applied.
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;
```

Never run `UPDATE` or `DELETE` on these tables from memory. Write the statement, have a second person read it, take a
backup, and keep the statement with the incident notes.

---

## 5. Secrets and access

- Secrets live in the hosting secret store. The two application secrets are `JWT_ACCESS_SECRET` and `OTP_PEPPER`
  (different values, at least 32 characters). Rotating the first signs every access token out (15 minutes at most;
  sessions continue through refresh tokens); rotating the second invalidates only OTP codes in flight (5 minutes).
- Admin access is a database flag, `users.is_admin`, set by an operator; there is no endpoint that grants it. Keep a
  list of who has it and review it on a schedule.
- Database access for people: read-only by default; write access only for the release step and for incidents, with a
  second person.
- The storage role needs only the two buckets; once D-9 or `DELETE /me` exist it also needs `s3:DeleteObject`.

---

## 6. Open items before this runbook is complete

- Fill in hosting-specific commands (deploy, logs, scale, secret store) once hosting is chosen.
- Run the restore drill and record the times (section 3.3).
- Name the on-call person and the SOS receiver, and test the path end to end with a real alert in staging.
- Decide alert thresholds and where alerts go (nothing exports metrics today).
- Add the account-deletion and Aadhaar-retention procedures when those features exist. **One step is already
  known and must not be forgotten:** once `DELETE /me` exists, a restore from an older backup would bring deleted
  accounts back, so the restore procedure (section 3.2) gets a final step before reopening the application: re-apply
  every entry of the deletion ledger newer than the backup (design: `08-milestone-b-designs.md` §1.5).
- Before applying any migration to a real database (the D-9 one is the next candidate): the backup in section 3.1, the
  row counts, `migrate status` before and after, and the drift check, exactly as in `08` §2.6.
- Per-user rate limiting exists on a separate branch and is not merged; if it is, `USER_RATE_LIMIT_PER_MIN` is a new
  setting to record, and a user who reports `429` is looked up by user id in the request log.
