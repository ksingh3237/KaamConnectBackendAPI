import type { AndroidNotification } from 'firebase-admin/messaging';
import type { NotificationType } from '../../generated/prisma/enums.js';

/**
 * How loud a push is. A worker waiting for work needs a new lead, a direct request or a confirmed booking to be
 * noticed with the phone in a pocket, so those ring a bell and vibrate on a high-importance channel. Everything else
 * is a normal heads-up with the phone's default sound.
 *
 * The channel ids and the sound file are created by the app (KaamConnect `utils/pushChannels.ts`); Android fixes a
 * channel's sound and importance when it is created, so the ids here must match the app's and never be reused for
 * a different sound.
 */
export const DEFAULT_CHANNEL_ID = 'default';
export const ALERT_CHANNEL_ID = 'new_leads';
/** Android: the file name without extension, from the app's res/raw. */
export const ALERT_SOUND_ANDROID = 'new_lead';
/** iOS: the file in the app bundle. */
export const ALERT_SOUND_IOS = 'new_lead.wav';

/** Pushes that ring the bell. All of them are sent to workers only. */
export const ALERT_TYPES: ReadonlySet<NotificationType> =
  new Set<NotificationType>([
    'NEW_LEAD',
    'DIRECT_REQUEST',
    'BOOKING_CONFIRMED',
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
