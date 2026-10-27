# 16. Loud push alerts (bell and vibration)

Status: built 2026-10-27 on branch `feature/worker-location-matching`. Verified by unit and e2e tests and by checking that the app build copies
the sound file into the Android resources. **Not heard or felt on a real phone yet**, and it needs a new app build (native resources changed).

## What the worker gets

| Push | Android | iPhone |
|---|---|---|
| New lead near you, a direct request, a confirmed booking (`NEW_LEAD`, `DIRECT_REQUEST`, `BOOKING_CONFIRMED`) | channel `new_leads`: maximum importance (pops up on screen, lock screen shows it), a 4.4 s bell, four long buzzes | the same bell (`new_lead.wav`) |
| Everything else (quotes, en route, cancelled, late, declined...) | channel `default`: high importance pop-up, short vibration, the phone's own sound | the phone's default sound |

The decision is made per type in `src/modules/notifications/push-alert.ts` (`ALERT_TYPES`). To make another type ring, add it there; no app change is needed
for that. The server also sends `sound`, `priority: max` and a vibration pattern for Android 7 and older, which ignore channels.

## The app side (mobile repo)

- `utils/pushChannels.ts` creates the two channels at sign-in. The lead channel uses the ring volume (like an incoming call): on a silent phone it vibrates but does not ring.
- `assets/sounds/new_lead.wav` is a synthesised bell (`scripts/make-lead-sound.mjs`, no third-party audio). Replace it with any `.wav` and rebuild; keep the name.
  The `expo-notifications` plugin in `app.json` (`sounds`) copies it into Android `res/raw` and the iOS bundle.

## Things that surprise people

- **Android fixes a channel's sound when it is created.** A phone that already has the app keeps its old `default` channel as it was. The `new_leads` channel is new, so it works, but to change
  the bell later you must use a new channel id (and update the server), not edit this one. The person can also change or mute a channel in the phone's settings; the app cannot override that.
- **Do Not Disturb and silent mode win.** The bell follows the ring volume. This is deliberate: an alarm-volume bell that ignores silent mode is intrusive and draws Play Store complaints.
- **A closed or battery-restricted app:** a high-priority FCM message wakes the phone, but some makers (Xiaomi, Oppo, Vivo...) kill background apps and delay pushes; the worker may have to allow
  "autostart" / "unrestricted battery" for KaamConnect. That is a phone setting, not something the app can switch on.
- **Not Rapido's full-screen ringing.** Rapido-style repeated ringing that takes over the screen needs the full-screen-intent permission, which Google Play restricts to calls and alarms. What is built is
  the strongest alert Play allows for this kind of app: a heads-up pop-up with the bell and a long vibration.
- **Foreground:** with the app open the same push still shows and plays through the app's notification handler (`shouldPlaySound: true`).

## How to check on a phone

1. Install the new build (a rebuild is required), sign in as a worker, allow notifications, and make the worker "taking jobs".
2. Lock the phone. From a second phone (customer) post a job in the worker's area: the worker's phone should ring the bell, buzz four times and light the lock screen.
3. In the phone's Settings > Apps > KaamConnect > Notifications there should be two categories, "New job alerts" and "KaamConnect". If "New job alerts" is missing the app was not rebuilt or the worker never allowed notifications.
4. Repeat with the app open, and with the app swiped away.
