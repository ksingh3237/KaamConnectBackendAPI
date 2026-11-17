# 18. Quote outcomes, the offline worker who is chosen, "is anyone there", and the Wallet

Added 2026-11-17 from five points the product owner raised after using the app. Point 3 (a cancellation limit of 4) was
not found in the code and is on hold until its source is identified; nothing was changed for it.

## 1. A worker who is switched off

The "taking jobs" switch (`worker_profiles.is_available`) only stops new-lead pushes, discovery and direct bookings.
It never hid the Leads Radar and never stopped a quote; that stays as it was.

| Rule                                                                                                                                                                                                                                                 | Where                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Quoting does not touch the switch.                                                                                                                                                                                                                   | `offers.service.ts` `send`                 |
| When the customer accepts a worker's quote, the same transaction switches that worker on (`UPDATE … WHERE is_available = false`). Only a real change is reported, so a worker who was already on hears nothing and a refused accept changes nothing. | `offers.service.ts` `accept`               |
| After commit: `worker.availability {isAvailable:true, reason:"BOOKING_CONFIRMED", jobId}` to the worker, and the BOOKING_CONFIRMED push ends with "You are online again."                                                                            | `job-events.service.ts` `bookingConfirmed` |
| The app re-reads the profile on that event, on that push (received or tapped), and when a new job appears in Home's polled list (the push can be missed).                                                                                            | app `PushHost.tsx`, `WorkerHome.tsx`       |

A worker accepting a direct request themselves does not switch them on (offline workers do not receive direct requests).

## 2. What became of a quote

`offers.declined_at` (new, nullable) separates "the customer pressed Decline" from "lost because another quote was
accepted"; both leave the quote `REJECTED`. It is cleared when the worker quotes again.

Every lead now carries `outcome` (`offers/lead-outcome.ts`), from the worker's point of view:

| outcome                 | When                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `null`                  | open, or the job is this worker's own (the job screen tells that story) |
| `QUOTE_DECLINED`        | job OPEN and this worker's quote was declined; they may quote again     |
| `CANCELLED_BY_CUSTOMER` | cancelled by the customer before anyone was chosen                      |
| `TAKEN_BY_OTHER`        | another worker was chosen (also when that job was cancelled later)      |
| `EXPIRED`               | past `expires_at`, before or after the sweeper ran                      |
| `CLOSED`                | any other ending (declined direct request, system cancellation)         |

The Leads Radar keeps a lead the worker quoted on (not one they backed out of) for 24 hours after it closed
(`CLOSED_LEAD_VISIBLE_MS`), marked with its outcome. `GET /leads/:id` is also readable by a worker the lead was sent to,
so an old "new job near you" opens on what happened instead of an error. Quoting or changing a quote on a closed
request was already refused by the API (`409 JOB_NOT_OPEN` / `OFFER_NOT_PENDING`); the app now hides the form too.

| Event                            | Push + inbox (new types) | To whom                                                                                                                              |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Customer declines a quote        | `QUOTE_DECLINED`         | that worker (plus the existing live `offer.rejected`)                                                                                |
| Customer accepts another quote   | `QUOTE_NOT_SELECTED`     | workers whose quote was still waiting (plus `offer.rejected`)                                                                        |
| Customer cancels an OPEN request | `LEAD_CANCELLED`         | workers whose quote was still waiting. Workers who only saw the lead get the live `lead.closed` and no push: nothing of theirs ended |

All three have English, Hindi and Punjabi texts (`push-texts.ts`), use the normal (not the loud) channel, and open the
lead screen in the app.

## 4. "Is anyone there for this?"

`GET /jobs/availability?categoryId=&areaId=&lat=&lng=&timing=&scheduledFor=` (any signed-in person) →
`{state, scheduledFor}`. Asked by Post Job as the customer picks the service, place and time. Advisory: posting is never
refused because of it.

| state       | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `NONE`      | no verified, active worker of this trade covers the spot (the customer themself never counts) |
| `ALL_BUSY`  | some do, but every one is switched off, or has a booking that clashes with the time asked for |
| `AVAILABLE` | at least one could take it                                                                    |

Coverage is matching's own rule (`MatchingService.findServingWorkers`, same radius and live-position-or-base-area rule
as `findCoveringWorkers`, but switched-off workers included and flagged). "Booked" is the booking-window check a quote
must pass (`AvailabilityService.assess`), for the requested time: a worker out on a job now is free for tomorrow 10 AM.
`timing`/`scheduledFor` follow `POST /jobs` (`422` the same way).

## 5. Wallet

| Route                                          | Notes                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /workers/me/earnings?period=all`          | New period: every paid job; `from` is 1970-01-01, `to` the time of the request                                                                                                                                                                         |
| `GET /workers/me/earnings/jobs?limit=&cursor=` | The paid (COMPLETED) jobs, most recently paid first: `{items:[{jobId, reference, title, category:{id, title:{en,hi,pa}}, customerName, area, completedAt, amount, method}], nextCursor}`. Same jobs and amounts as the totals. Worker profile required |

The app's Wallet (worker side, from the ☰ menu and Profile) shows the lifetime total, today / this week / this month,
and the list. Top Up is a "Coming soon" tab only: no payment gateway, no balance. The platform holds no money; the
screen says so.

## Migration

`20261117090000_quote_outcomes`: three `NotificationType` values and `offers.declined_at`. Additive only; no row is
changed. Applied to the test database by the e2e harness. **Not applied to dev or production**: that waits for approval.
