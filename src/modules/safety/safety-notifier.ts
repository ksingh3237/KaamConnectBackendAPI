import { Logger } from '@nestjs/common';

/** What the safety desk needs to act on an SOS (decision Q-10: a webhook or log to a named owner). */
export interface SosNotification {
  alertId: string;
  jobReference: string;
  jobStatus: string;
  raisedAt: string;
  raisedBy: { role: 'CUSTOMER' | 'WORKER'; name: string; phone: string };
  /** The other person on the job, so the desk can call both. */
  otherParty: {
    role: 'CUSTOMER' | 'WORKER';
    name: string;
    phone: string;
  } | null;
  /**
   * Where the person is. `REPORTED` = the phone sent coordinates with the alert; `LAST_WORKER_FIX` = the
   * worker's most recent stored fix (it may be old, see `fixAgeSec`); null = we do not know.
   */
  location: {
    lat: number;
    lng: number;
    source: 'REPORTED' | 'LAST_WORKER_FIX';
    fixAgeSec?: number;
  } | null;
  /** The job's address, because that is where help would be sent. Sensitive: the channel must be private. */
  address: { line: string; area: string; city: string };
}

/**
 * How an SOS reaches a human. An abstract class so it is the DI token, like the OTP sender: the alert is
 * ALWAYS stored first; delivery is best effort and must never fail the request (see SosService).
 */
export abstract class SafetyNotifier {
  abstract notify(notification: SosNotification): Promise<void>;
}

/** Development default: writes the alert to the log. Never use as the only channel in production. */
export class LoggingSafetyNotifier extends SafetyNotifier {
  private readonly logger = new Logger('SOS');

  notify(n: SosNotification): Promise<void> {
    this.logger.error(
      `SOS ${n.alertId} on ${n.jobReference} raised by the ${n.raisedBy.role.toLowerCase()} (${n.jobStatus}); location ${n.location ? n.location.source : 'unknown'}`,
    );
    return Promise.resolve();
  }
}

/** Production channel: POSTs the alert as JSON to a URL you control (Slack/Teams/PagerDuty bridge, etc.). */
export class WebhookSafetyNotifier extends SafetyNotifier {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 5000,
  ) {
    super();
  }

  async notify(n: SosNotification): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'kaamconnect.sos', ...n }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`safety webhook answered ${response.status}`);
  }
}
