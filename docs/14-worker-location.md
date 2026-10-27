# 14. Worker location and lead matching

Status: built on branch `feature/worker-location-matching`, not run on a device, migration not applied to dev.

## What decides whether a lead reaches a worker

One rule (`src/modules/matching/coverage.ts`), used by the lead feed, "who do I notify" and discovery:

| Worker point | Job point | Result |
|---|---|---|
| fresh live fix (under 30 min), else base sector centroid | the customer's GPS pin, else the job sector centroid | straight-line distance against the worker's radius (3, 6 or 12 km; jobs booked for later use the base sector and `scheduledRadiusKm`) |
| anything missing on either side | | same city |

Two things must therefore be true for a radius to be enforced: the worker has a fresh fix, and the job has coordinates.

## Worker side: "I am here" reports (mobile)

- `utils/presence.ts` sends the phone's position with `PUT /workers/me/location` while the app is open, the worker is VERIFIED and "taking jobs" is on. On app start, when the app comes back to the front (at most once a minute) and every 5 minutes. A fix is trusted for 30 minutes, so a worker who keeps the app open is always fresh.
- Nothing is sent while a trip is being shared (`utils/workerTracking.ts` already sends much faster fixes), when the phone's location is off, or when the permission was never granted. This code never shows a permission dialog; the explanation modal and the system dialogs are in `utils/locationPermission.ts`.
- Foreground only. A worker with the app closed is judged by their last fix for 30 minutes, then by their base sector.
- The server needs no change: `PUT /workers/me/location` already accepts verified workers at any time, and each stored fix re-runs lead matching.

## Worker profile: future-booking radius

The onboarding/profile form has a second choice, "Future bookings": Same as above, or any of 6, 12, 25, 50 km that is larger than the live radius (server rule BR-20). Changing the live radius to something at or above the chosen value drops the choice back to "Same". "Same" clears the stored value with a partial update (the profile save cannot send `null`).

## Job side: sector centroids (needs data)

No sector has coordinates yet (Q-18), so a job posted without a GPS pin falls back to "same city". The database has 198 areas, not 13. To fill them:

```
npm run db:centroids -- --template > areas.csv     # every area, empty lat/lng
# fill lat,lng from a verified source, leave unknown rows empty
npm run db:centroids -- areas.csv                  # dry run: checks the file, says what would change
npm run db:centroids -- areas.csv --apply          # writes missing centroids in one transaction
```

Rules: values outside a plausibility box around the Tricity (lat 30.5 to 31.0, lng 76.5 to 77.0) reject the whole file with line numbers; a row with only one of lat/lng is an error; an area that already has a centroid is never overwritten (listed under `keptBecauseAlreadySet`); an unknown city or area is listed and skipped. Values must not come from memory.

## Direct requests: the customer is told

When the worker a customer asked for personally declines, or does not answer before the request expires, the customer now gets a push and an inbox row (`DIRECT_DECLINED`, `DIRECT_EXPIRED`; migration `20261028090000_direct_request_notifications`, additive). Tapping it opens the tracking screen, which says the worker declined or did not answer and that another worker can be chosen.

## Not built

- A worker who never arrives (no timeout, no sweeper): needs a policy (how long, what happens to the visit slot, whether it counts against the worker).
- Background location when the app is closed (would need the "all the time" permission outside a trip and a Play declaration).
