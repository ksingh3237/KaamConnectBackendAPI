# 12. Local full-stack integration, SOS delivery and account deletion (built 2026-10-11/12)

Status: **built and tested locally; nothing here is deployed.** Branch `feature/full-stack-local-integration`
(backend) and `feature/api-integration` (frontend), both local, not pushed, no pull request. How to run both sides:
`KaamConnect/LOCAL-TESTING.md`.

## 1. What this adds

| Area | What exists now |
|---|---|
| Development OTP | `OTP_DEV_BYPASS=true` makes `123456` the code for every number, sends no SMS, and every OTP response carries `devNotice` (the app shows a banner). Config validation **refuses** the setting in production. `npm run dev:local` forces it on and refuses production and non-local databases. |
| Browser access | `CORS_ORIGINS` allow-list (exact origins). Empty by default; `dev:local` allows the Expo ports. Dev-storage downloads send `Cross-Origin-Resource-Policy: cross-origin` so the web app can show uploaded pictures (signed, short-lived URLs). |
| Storage | `StorageService.delete(bucket, key)` for the local and the S3 provider; deleting a missing object succeeds. S3 was **never run against a real bucket** (no credentials); its delete is unit-tested against a stubbed client. |
| SOS | Alert and the exact payload stored together; delivery recorded (`delivered_at`, attempts, last error); retried every 30 s with back-off (30 s .. 10 min, 10 tries) until the desk answers 2xx; admin list / acknowledge / resolve; the raiser sees status (`GET /jobs/:id/sos`) and gets `sos.acknowledged` / `sos.resolved` events; `npm run mock:sos` is the local stand-in desk. |
| `DELETE /me` | Anonymisation as designed in `08` section 1, both doors (below). |
| Frontend | Every screen reads and writes the real API; no mock data remains. |

## 2. SOS, as built

* The raise call **never fails because the desk is down**. The response says honestly whether the desk confirmed
  (`delivered`), and the app shows "SOS saved, not confirmed yet" when it did not.
* One attempt is claimed by a conditional update, so two instances cannot send the same attempt twice (tested with three
  parallel callers).
* The sweep skips alerts a human already acknowledged and alerts older than the tracking feature (no payload).
* After 10 failed tries the alert stays `OPEN` and is logged at error level; it remains on the admin list.
* **Not available until you provide it:** the real receiver (Slack/Teams bridge, PagerDuty, call-centre system).
  `SOS_WEBHOOK_URL` is the only integration point; the mock receiver is not a production channel.

## 3. `DELETE /me`, as built (and where it differs from the design)

* **Door A:** `DELETE /me {code, confirm:true}` with a fresh OTP for the account's own number. `204` on success.
  `409 ACTIVE_JOB_BLOCKS_DELETION` (jobs in OPEN/ASSIGNED/ARRIVED/IN_PROGRESS/WORK_COMPLETED, or an **open SOS**; the
  body lists them), `409 ADMIN_CANNOT_DELETE_SELF`, `401 OTP_INVALID`, `403 ACCOUNT_DISABLED`, `502 STORAGE_UNAVAILABLE`.
* **Door B:** `POST /auth/deletion-requests {phone, code}` answers `202` with the same text for every number and only
  *records* a request for a disabled, non-admin account. Admin queue: `GET /admin/deletion-requests`,
  `POST .../:userId/approve|decline`. **The app has no screen for Door B yet** (rare path; API and admin side are tested).
* Order: files first (storage failure changes nothing), then one transaction under the per-person advisory lock
  `booking:<id>` that the booking code also takes. `AvailabilityService.reserve` now re-reads the worker after taking the
  lock, so a quote accepted at the same moment cannot give a job to a deleted worker (6 racing rounds in the e2e suite;
  either the deletion or the acceptance wins, never a stranded job).
* **Deviation from the design text:** the OTP is spent *inside* the deleting transaction, not before it, so a retry after
  a storage failure works with the same code; the blockers are checked *before* the code is looked at, so a person with a
  job in progress does not use up an attempt.
* Removed/kept: exactly the table in `08` section 1.4. Additionally the stored SOS payload (names, phones, address) is
  nulled for delivered alerts on the person's jobs; coordinates and status stay.
* Ledger: one JSON line per deletion (`user id, time, SELF|ADMIN`, no personal data) to `DELETION_LEDGER_FILE` and the log.
  `AccountDeletionService.reapplyFromLedger(id)` is the operator hook for the restore step; **no operator script or
  runbook step has been written yet**.

## 4. Retention assumptions (NOT legal advice, NOT approved)

Nothing was permanently erased that could be a legal record. By default, and until counsel decides: payments, bill items
and job rows are kept indefinitely (linked only to the anonymised account); reviews and tips are kept; SOS rows (status,
coordinates, who handled it) are kept; the security audit trail is kept without IP addresses; the job `title` is kept
(it is free text); the deletion ledger is kept. The app's delete dialog says that retention periods are still to be
confirmed. Each item is one constant or query to change once the periods are decided (`08` section 1.6).

## 5. Contract notes found by running the real app against the real API

* `GET /me` is deliberately light (`fullName`, `verificationStatus`, `commLanguage`); the app loads the full profile
  from `GET /customers/me` and `GET /workers/me`.
* `Idempotency-Key` on `POST /jobs` is **not implemented** by the server (it was only in the spec as later work); the
  app does not send it (it also would have failed the CORS check) and disables the button while posting instead.
* Real job order: ARRIVED -> the **customer approves the cost** -> IN_PROGRESS (bill frozen) -> the worker finishes ->
  the customer pays. The app now follows this.
* Per-IP limits still apply to local testing (20 OTP requests/hour); restart `dev:local` to reset them.

## 6. Open items

Door B screen; operator restore script + runbook step; real S3 and real SOS receiver; legal retention periods;
Aadhaar retention sweep (D-9 write path: `reviewed_at/by` are not yet written by the decision code); realtime in the app
(polling every 6-15 s is used; the Socket.IO events exist); voice notes (no recorder in the app yet); frontend automated
tests (verification so far is `tsc`, the web/Android export and scripted browser runs); frontend dependency advisories
(29, all in the Expo/Metro build toolchain, no safe upgrade offered).

## 7. Verification (2026-10-12, local)

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `prettier --check` | clean |
| `npm run build` | ok |
| Unit tests (`vitest run`) | 37 files, **334 passed** |
| End-to-end tests (real HTTP, real PostgreSQL `KaamConnect_test`) | 32 files, **808 passed** (new: 10 SOS delivery, 25 account deletion; the route-guard suites now cover the 9 new routes) |
| Coverage gates (`npm run test:cov`) | passed: lines 97.3 % (2528/2598), branches 87.9 % |
| `npm audit --omit=dev` (backend) | 0 vulnerabilities |
| Migration | `20261012090000_account_deletion_and_sos_delivery` applied to `KaamConnect` after a verified backup and restore rehearsal; `migrate status` up to date, `migrate diff` empty; applied to `KaamConnect_test` by the e2e harness |
| Frontend `tsc --noEmit`, web export, Android (Hermes) export | all succeed |
| Frontend `npm audit --omit=dev` | 29 advisories (11 moderate, 18 high), all in the Expo/Metro build toolchain; the offered fixes are major downgrades, so none was applied |
| Scripted two-browser journey (headless Chrome, real API, real DB) | **35 of 35 checks**: worker and customer sign-up with the dev code, onboarding with photo and Aadhaar uploads, post job with photo, quote, accept, SOS reaching the mock desk, wrong then right arrival code, bill, cost approval, work done, payment, review, receipt, earnings, account deletion (refused while an SOS was open, desk resolves it, wrong code refused, right code deletes) |

Not covered by any automated test: the app on a real phone or emulator (only the web build was driven), Door B in the app,
real S3, a real SOS receiver, real SMS. The browser journey is a script kept outside the repository; it is not part of CI.
