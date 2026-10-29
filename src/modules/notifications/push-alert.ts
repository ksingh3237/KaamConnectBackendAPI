import type { AndroidNotification } from 'firebase-admin/messaging';
import type { NotificationType } from '../../generated/prisma/enums.js';

/**
 * How loud a push is. Some moments have someone waiting on the other side with the phone in a pocket, so they ring a
 * bell and vibrate on a high-importance channel: for a worker a new lead, a direct request or a confirmed booking;
 * for a customer the first quote on their request and the worker reaching their door. Everything else - the bill, the
 * work finished, a cancellation - is a normal heads-up with the phone's default sound.
 *
 * The channel ids and the sound file are created by the app (KaamConnect `utils/pushChannels.ts`); Android fixes a
 * channel's sound and importance when it is created, so the ids here must match the app's and never be reused for
 * a different sound - a changed sound needs a new id on both sides (hence the "_v2").
 */
export const DEFAULT_CHANNEL_ID = 'default';
export const ALERT_CHANNEL_ID = 'new_leads_v2';
/** Android: the file name without extension, from the app's res/raw. */
export const ALERT_SOUND_ANDROID = 'new_lead';
/** iOS: the file in the app bundle. */
export const ALERT_SOUND_IOS = 'new_lead.wav';

/** Pushes that ring the bell. Keep in step with the app's LOUD_TYPES (KaamConnect `utils/alerts.ts`). */
export const ALERT_TYPES: ReadonlySet<NotificationType> =
  new Set<NotificationType>([
    // worker
    'NEW_LEAD',
    'DIRECT_REQUEST',
    'BOOKING_CONFIRMED',
    // customer
    'NEW_QUOTE',
    'WORKER_ARRIVED',
  ]);

export interface PushPlatformOptions {
  android: {
    priority: 'high';
    notification: AndroidNotification;
  };
  apns: {
    headers: Record<string, string>;
    payload: { aps: Record<string, unknown> };
  };
}

/** One message serves every phone: each platform reads only its own block. `apns-priority 10` = deliver now. */
export function pushOptionsFor(type: NotificationType): PushPlatformOptions {
  const alert = ALERT_TYPES.has(type);
  return {
    android: {
      priority: 'high',
      notification: alert
        ? {
            channelId: ALERT_CHANNEL_ID,
            // Android 7 and older ignore channels and read these instead
            sound: ALERT_SOUND_ANDROID,
            priority: 'max',
            visibility: 'public',
            vibrateTimingsMillis: [0, 500, 250, 500, 250, 500],
          }
        : { channelId: DEFAULT_CHANNEL_ID },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: alert ? ALERT_SOUND_IOS : 'default' } },
    },
  };
}
