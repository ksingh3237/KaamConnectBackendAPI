import { describe, expect, it } from 'vitest';
import {
  ALERT_CHANNEL_ID,
  ALERT_SOUND_ANDROID,
  ALERT_SOUND_IOS,
  ALERT_TYPES,
  DEFAULT_CHANNEL_ID,
  pushOptionsFor,
} from './push-alert.js';

describe('pushOptionsFor', () => {
  it('rings the bell for the things someone is waiting on: leads for the worker, a quote and the arrival for the customer', () => {
    expect([...ALERT_TYPES].sort()).toEqual([
      'BOOKING_CONFIRMED',
      'DIRECT_REQUEST',
      'NEW_LEAD',
      'NEW_QUOTE',
      'WORKER_ARRIVED',
    ]);
    for (const type of ALERT_TYPES) {
      const { android, apns } = pushOptionsFor(type);
      expect(android.priority).toBe('high');
      expect(android.notification).toMatchObject({
        channelId: ALERT_CHANNEL_ID,
        sound: ALERT_SOUND_ANDROID,
        priority: 'max',
        visibility: 'public',
      });
      expect(android.notification.vibrateTimingsMillis?.length).toBeGreaterThan(
        2,
      );
      expect(apns.payload.aps.sound).toBe(ALERT_SOUND_IOS);
      expect(apns.headers['apns-priority']).toBe('10');
    }
  });

  it('keeps every other push a normal heads-up on the default channel, with the phone default sound', () => {
    for (const type of [
      'BILL_CREATED',
      'WORK_COMPLETED',
      'WORKER_EN_ROUTE',
      'JOB_CANCELLED_BY_WORKER',
      'JOB_WORKER_LATE',
      'DIRECT_DECLINED',
    ] as const) {
      const { android, apns } = pushOptionsFor(type);
      expect(android).toEqual({
        priority: 'high',
        notification: { channelId: DEFAULT_CHANNEL_ID },
      });
      expect(apns.payload.aps.sound).toBe('default');
    }
  });

  it('uses the channel ids and sound the app creates (they must never drift apart)', () => {
    expect([DEFAULT_CHANNEL_ID, ALERT_CHANNEL_ID]).toEqual([
      'default',
      'new_leads_v2',
    ]);
    expect(ALERT_SOUND_ANDROID).toBe('new_lead');
    expect(ALERT_SOUND_IOS).toBe('new_lead.wav');
  });
});
