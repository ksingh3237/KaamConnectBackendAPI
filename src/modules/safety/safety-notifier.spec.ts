import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LoggingSafetyNotifier,
  WebhookSafetyNotifier,
  type SosNotification,
} from './safety-notifier.js';

const alert: SosNotification = {
  alertId: 'a1',
  jobReference: 'KC-10000',
  jobStatus: 'ASSIGNED',
  raisedAt: '2026-10-12T04:00:00.000Z',
  raisedBy: { role: 'CUSTOMER', name: 'Sunita', phone: '+919000000001' },
  otherParty: { role: 'WORKER', name: 'Rajesh', phone: '+919000000002' },
  location: { lat: 30.7, lng: 76.7, source: 'REPORTED' },
  address: { line: 'House 1', area: 'Sector 22', city: 'Chandigarh' },
};

afterEach(() => vi.unstubAllGlobals());

describe('WebhookSafetyNotifier', () => {
  it('POSTs the alert as JSON with a type marker', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await new WebhookSafetyNotifier('https://desk.example.com/sos').notify(
      alert,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://desk.example.com/sos');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: 'kaamconnect.sos',
      alertId: 'a1',
      location: { source: 'REPORTED' },
    });
  });

  it('fails loudly (so the caller can log it) when the desk answers with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502 }),
    );
    await expect(
      new WebhookSafetyNotifier('https://desk.example.com/sos').notify(alert),
    ).rejects.toThrow(/502/);
  });

  it('fails when the desk cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(
      new WebhookSafetyNotifier('https://desk.example.com/sos').notify(alert),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('LoggingSafetyNotifier', () => {
  it('resolves without needing any network', async () => {
    await expect(
      new LoggingSafetyNotifier().notify(alert),
    ).resolves.toBeUndefined();
  });
});
