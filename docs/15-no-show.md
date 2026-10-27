# 15. Worker no-show

Status: built 2026-10-27 on branch `feature/worker-location-matching`; policy approved by the owner the same day.
Migration `20261029090000_worker_no_show` is applied to the test database only, not to dev.

## 1. Policy (approved)

| Question | Rule |
|---|---|
| When is a worker late? | Past the **promised arrival**: `jobs.booked_start_at`. For an immediate job that is the moment the customer accepted the quote plus the worker's quoted ETA (15/30/45 min); for a scheduled job it is the appointment time. |
| Warning | Once, at that moment: push + inbox to the worker ("you are late") and to the customer ("your worker is running late; keep waiting or cancel"). `jobs.late_notified_at` is the once-only guard. |
| Release | `NO_SHOW_GRACE_MIN` (default 30) after the promised arrival, if the job is still `ASSIGNED` (the arrival code has not been entered). Automatic: the customer does not have to press anything, but may cancel any time before (existing customer cancel, reason "The worker is taking too long"). |
| What release does | Same as a worker back-out for a worker-side reason (docs/13): a **broadcast** job goes back to `OPEN` for new quotes with everything the assignment set cleared (calendar slot, arrival code, visit-fee bill line); a **direct booking** is closed (`CANCELLED`, `cancelledBy=SYSTEM`). |
| Counts against the worker | **Yes**: a `job_cancellations` row with `actor_role=SYSTEM`, `reason_code=NO_SHOW`, `counts_against_worker=true`. It feeds the existing "3 in 30 days" warning and the admin flag list. Nothing is suspended automatically. |
| Excuse | An admin can excuse one record (`POST /admin/cancellations/:id/excuse`): it stops counting, the record and an `excused_at` stamp stay. |
| Visit fee | None: the worker never arrived. |
| Customer-side no-show | Unchanged: the worker cancels on site with "customer is not answering" / "wrong address" (docs/13). |

The worker's GPS is **not** consulted. A phone that cannot be tracked (dead battery, no signal, tracking never verified on a device) must not
decide a release.

## 2. How it works

`NoShowService` runs every minute (`@nestjs/schedule`, safe on several instances): first it releases jobs past the grace period, then it sends
the late warnings for jobs that are late but inside it (so a job found long overdue after downtime is released, not warned).
`WorkerBackOutService.releaseNoShow` is the same transaction as a worker's own back-out, claimed with a conditional update
(`status = ASSIGNED AND booked_start_at <= now - grace`). The worker entering the arrival code at the same moment and the sweeper cannot both win:
the loser gets no change (the worker's arrival request is refused with 409, or the sweep skips the job). Tested with concurrent runs.

Both people also see it in the job: `noShowReleaseAt` (promised arrival + grace) is on the job view while it is `ASSIGNED`, so the app can show
"you are late, released at 4:35 pm". A cancelled job's `cancellation.by` can now be `SYSTEM`.

## 3. Data (migration `20261029090000_worker_no_show`)

- `NotificationType`: `JOB_WORKER_LATE` (customer), `JOB_YOU_ARE_LATE` (worker), `JOB_NO_SHOW_RELEASED` (worker). The customer's release notice reuses
  `JOB_CANCELLED_BY_WORKER` with `data.reopened`, so the app's existing routing (quotes if re-opened, tracking if closed) applies. The worker's release notice carries `data.reopened` too: re-opened means the job left their list, so the app opens Home; closed (a direct booking) opens the job's cancelled summary.
- `jobs.late_notified_at` (cleared when a job is re-opened), `job_cancellations.excused_at`.
- The three CHECK rules on `job_cancellations` are replaced to also allow `SYSTEM`: `actor_role IN (CUSTOMER, WORKER, SYSTEM)`, a `SYSTEM` row has no
  `actor_id` and has a `worker_id`, counts and re-opens may be `WORKER` or `SYSTEM` only. Every existing row satisfies them.
- Worker history, the 30-day count and the admin flag list now key on `worker_id` (the worker the job was assigned to) instead of `actor_id`, because
  a system row has no actor. Customer cancellations are still excluded by `actor_role`.

## 4. Configuration

`NO_SHOW_GRACE_MIN` (default 30, minimum 5), in `.env.example`.

## 5. Known limits

- A worker who has physically arrived but never gets the code from the customer is still "not arrived" to the system and is released after the grace
  period. The worker should cancel with "customer is not answering" before that (no fault, visit fee is owed only after arrival is verified).
- No grace extension and no "I am stuck in traffic" button. The 30-minute grace and the warning are the whole mechanism.
- Verified by automated tests and a web run; not on a device. Push delivery is as untested as the other pushes.
