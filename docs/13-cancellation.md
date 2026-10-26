# 13. Cancelling a job after a worker was given it

Status: built 2026-10-27 on branch `feature/google-push-notification`, **not committed, migration not applied to the dev
database** (the test database has it). Decisions taken with the product owner on 2026-10-27: either side can cancel after
arrival, with the visit fee shown as owed; repeat back-outs are recorded and warned about, with no automatic penalty; the
whole feature was built in one go and stopped for review.

## 1. What was wrong

Before this, `POST /jobs/:id/cancel` already let a customer cancel (OPEN, ASSIGNED) and the assigned worker back out
(ASSIGNED, decision Q-5), but:

1. The app had **no button** for the worker, so "my bike broke down" could not be done from the phone.
2. A cancellation sent **no push and no inbox entry**: each side only heard through the socket, and only with the app open.
3. After five wrong arrival codes the server told the worker to "ask the customer for a new code, or back out". The app
   never called `resetArrivalCode` and had no back-out button: **a dead end**.
4. Once `ARRIVED` the only exits were bill approval and completion. If the customer refused the price, or the worker could
   not do the work, the job stayed there forever, and the one-job-on-site rule (`jobs_one_in_progress_per_worker`) **kept
   that worker from arriving anywhere else**.
5. A broadcast back-out clears `jobs.worker_id`, so the job **vanished from the worker's own history**, and the customer's
   tracking screen said "Waiting for the worker to accept", hiding that the worker had cancelled.
6. Reasons were free text only: nothing to count, nothing to warn about.

## 2. Who can cancel, when

| Job is | Customer | Assigned worker |
|---|---|---|
| `OPEN` | cancels the request (as before) | n/a (not assigned); a direct request can still be declined with `/direct/decline` |
| `ASSIGNED` (on the way) | cancels | backs out: re-opens (broadcast) or closes, depending on the reason, section 3 |
| `ARRIVED` (on site, cost not approved) | **new:** declines the cost, job closes | **new:** leaves the job, job closes |
| `IN_PROGRESS`, `WORK_COMPLETED`, `COMPLETED` | no | no |

`IN_PROGRESS` has no self-serve cancel by design: once the customer has approved the cost the bill is frozen and work has
started. A worker who cannot finish completes with what was done; a safety problem uses SOS. Both are `409 INVALID_TRANSITION`.

State machine (`jobs/state/job-state-machine.ts`): `CUSTOMER_CANCEL` now also allows `ARRIVED`; new action
`WORKER_CANCEL_ARRIVED` (`ARRIVED` to `CANCELLED`). `WORKER_CANCEL_DIRECT` (`ASSIGNED` to `CANCELLED`) is also used for a
broadcast back-out whose reason makes re-broadcasting pointless.

## 3. Reasons

`POST /jobs/:id/cancel` takes `{ reasonCode?, reason? }` (`jobs/cancel-reasons.ts` is the source of truth).
`reasonCode` is optional so an app from before this field still works (a worker with no code behaves exactly as before and
is recorded as `UNSPECIFIED`). `reason` is the person's own words; **`OTHER` requires it** (`422`, field `reason`).
A code that belongs to the other side is refused (`422`, field `reasonCode`).

| Code | Side | Counts against the worker | Re-opens a broadcast job |
|---|---|---|---|
| `VEHICLE_PROBLEM`, `PERSONAL_EMERGENCY`, `DOUBLE_BOOKED`, `TOO_FAR`, `CANT_DO_WORK`, `OTHER` | worker | yes | yes (on the way) |
| `CUSTOMER_UNREACHABLE`, `WRONG_ADDRESS`, `CUSTOMER_ASKED`, `PRICE_DISAGREEMENT`, `UNSAFE_LOCATION` | worker | no | no: the job closes |
| `CHANGED_MIND`, `FOUND_ANOTHER`, `WORKER_LATE`, `WORKER_UNREACHABLE`, `POSTED_BY_MISTAKE`, `PRICE_TOO_HIGH`, `OTHER` | customer | never (customers are not penalised) | n/a |

Invariant (unit-tested): a worker back-out re-opens the request **only** when it was the worker's own doing. Re-broadcasting a
request because the customer would not answer, or the address was wrong, would not help anyone.

On site (`ARRIVED`) a worker's cancellation **always closes** the job, whatever the reason: the customer has already met this
worker, so quietly re-opening would be a surprise.

## 4. What is owed

KaamConnect never moves money. When the worker had arrived **and it is not the worker's doing**, the cancellation records
`visitFeeDue` (the job's `VISIT_FEE` bill line) and both people are told it is payable to the worker directly:

- customer declines the cost after arrival: due;
- worker leaves with a non-fault reason (`PRICE_DISAGREEMENT`, `UNSAFE_LOCATION`, ...): due;
- worker leaves for their own reason (`CANT_DO_WORK`, ...): **not** due;
- any cancellation before arrival: not due.

## 5. Data

Migration `20261027090000_job_cancellations` (additive: two enum values and one table).

`job_cancellations`: `job_id`, `actor_id` (`ON DELETE SET NULL`), `actor_role` (CUSTOMER or WORKER), `worker_id`, `stage`
(OPEN / ASSIGNED / ARRIVED), `reason_code`, `note`, `reopened`, `counts_against_worker`, `visit_fee_due`, `created_at`.
`jobs.cancelled_*` only keeps the last outcome and a broadcast back-out clears the worker, so this table is the only record of
who backed out, when and why. Hand-written CHECKs: the actor is a person (never SYSTEM), the stage is cancellable, the fee is
not negative, only a worker row can count against a worker, only a worker back-out on an assigned job can re-open.

`NotificationType` gains `JOB_CANCELLED_BY_CUSTOMER` and `JOB_CANCELLED_BY_WORKER`. The reason is stored as text, not an enum,
so adding a reason later needs no migration.

**Account deletion** removes the free-text `note` of that person's cancellations (it may name people or places) and keeps the
reason code, which is how repeat back-outs are counted.

## 6. Notifications and the repeat back-out warning

Sent after the transaction commits, fire-and-forget (a failed push never fails the cancel); inbox row plus FCM push; no
address or phone in the payload.

| Event | Who | Push |
|---|---|---|
| Customer cancels a job that has (or was asked of) a worker | that worker | `JOB_CANCELLED_BY_CUSTOMER` "The customer cancelled the job": title, reason, visit fee if owed |
| Worker cancels, request re-opened | customer | `JOB_CANCELLED_BY_WORKER`, `data.reopened = true`: "Your worker cannot make it ... open again" |
| Worker cancels, job closed | customer | same type, `data.reopened = false`: "Your worker cancelled the job" (+ visit fee if owed) |
| Customer cancels an `OPEN` broadcast request | nobody pushed | workers see `lead.closed`, as before |

FCM data values are all strings, so a tapped **push** carries `reopened: "true"` while the **inbox** row carries the boolean;
the app accepts both.

Not covered (existing behaviour, unchanged): a worker **declining** a direct request (`/direct/decline`) still sends the
customer only the socket event, not a push.

**Repeat back-outs.** `countsAgainstWorker` rows in the last 30 days are counted (`BACK_OUT_WINDOW_DAYS`); at 3
(`BACK_OUT_WARN_AT`) the worker is warned in the app. The same count feeds a read-only admin list. Nothing is suspended or
penalised automatically: a person decides.

## 7. API

| Route | Who | Notes |
|---|---|---|
| `POST /jobs/:id/cancel` `{reasonCode?, reason?}` | the customer **or** the assigned worker | as section 2; worker response is the job view (without the address if it re-opened); `409 INVALID_TRANSITION` when too late or already cancelled; `422` for a bad reason |
| `GET /jobs/:id` | either party | a CANCELLED job now carries `cancellation: {by, stage, reasonCode, reason, visitFeeDue}` (absent for expiry and older rows) |
| `GET /workers/me/cancellations` | any worker profile | `{summary: {windowDays, warnAt, recent, warn}, items[20]}`, newest first. A re-opened job is in no other list of theirs |
| `GET /admin/workers/cancellation-flags?days=&min=` | admin | workers with at least `min` (default 3) own-fault back-outs in `days` (default 30), most first; `404` for non-admins like every admin route |

## 8. Race conditions

Every cancel is a conditional update on **the exact status the caller saw**, in a transaction (not on "any cancellable
status"). If the other side moved first (the worker verified the code, the customer approved the cost, the customer
cancelled) the loser gets `409 INVALID_TRANSITION` and **no `job_cancellations` row is written**. The app shows "this job
has just changed" and refreshes.

This matters for one case in particular: a customer cancels from the "worker on the way" screen at the instant the worker
enters the arrival code. A cancel that accepted any cancellable status would succeed but be recorded as `ASSIGNED` with no
visit fee owed, although the worker had arrived. Matching the status seen makes the customer retry from the on-site screen,
where the wording and the visit fee are shown first. Pinned by `jobs.cancel-race.spec.ts` (found in review, not by the
e2e suite: the interleaving cannot be produced on demand against a real database).

## 9. Verification (2026-10-27)

- Unit: `cancel-reasons.spec.ts` (catalogue invariants, validation, fee rule), `jobs.cancel-race.spec.ts`, state machine spec
  updated. Two older e2e tests that asserted "no cancel once on site" were rewritten to "no cancel once the work has started".
- E2E `test/cancellation.e2e-spec.ts`: 24 tests on the real test database (every stage, both sides, fee rule, notifications,
  history and warning, window, admin list, account deletion, database CHECKs, and "nothing is written when refused").
- Mutation checks: 7 deliberate breakages of the rules above each made at least one test fail (visit fee, re-open rule,
  customer notification, warning count, `ARRIVED` cancel, note removal, worker notification).
- The app side is verified by `tsc` and unit tests of the pure logic; **no screen has been run on a device or emulator**.
