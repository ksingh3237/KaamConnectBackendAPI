# 17. Booked appointments (Afternoon / Tomorrow)

Added 2026-11-02 after a device test showed that a job posted for "Tomorrow" could be started and finished the same
evening, and that an "Afternoon" job posted at 8:30 pm turned into "in 30 minutes".

## What was wrong

1. The app sent only `timing: TOMORROW` / `AFTERNOON`. The server picked the time on its own (10:00 tomorrow, 14:00
   today) and the customer was never told it.
2. Nothing compared the appointment with the clock once a quote was accepted. `ASSIGNED` meant "on the way" for
   every job: the worker's GPS was shared at once, the customer saw "Worker on the way", and the arrival code worked
   straight away, so tomorrow's job could be done today.
3. "Afternoon" posted after 14:00 became "30 minutes from now" with no upper limit, so at 20:30 it was a 21:00 job
   still labelled Afternoon.

## Rules now

| Rule | Where |
|---|---|
| The customer picks the hour: Afternoon 12 PM to 7 PM today (only hours at least 30 min ahead), Tomorrow 8 AM to 8 PM. Sent as `scheduledFor` with `+05:30`. | app `post-job.tsx`, `utils/appointment.ts` |
| Afternoon is hidden once no afternoon hour is left. The server refuses an Afternoon request without a time when 14:00 / now + 30 min falls at or after 20:00 (`422`, "the afternoon … is over for today"). | `schedule-time.ts` |
| The arrival code can be entered from `EARLY_ARRIVAL_MIN` (default 60) minutes before `scheduledFor`. Earlier → `409 TOO_EARLY`, checked before a try is counted. Jobs without an appointment (Immediate) are never held back. | `fulfilment/early-arrival.ts`, `arrival.service.ts` |
| Until then the job is shown as **Booked for <time>**, not "on the way", on both sides; the worker's GPS is not shared for it, and the customer's tracking screen shows the time instead of a countdown. | app `utils/appointment.ts` (`isBooked`), tracking, job-progress, Home, Leads, Activity |
| A quote on a request with a time shows that time instead of "how quickly can you arrive"; quoting means coming at that time. The booking slot was already the appointment, not the ETA (`booking-window.ts`). | app `lead-offer.tsx`, `OfferCard.tsx` |

The no-show sweeper already counted from the appointment (`booked_start_at`), so a booked job is not released early.

## Not done (needs a decision or a migration)

- A reminder push to the worker when the hour before the appointment begins (needs a "reminder sent" column).
- A time window ("9 to 12") instead of an exact hour.
- Letting the worker come earlier with the customer's agreement.
