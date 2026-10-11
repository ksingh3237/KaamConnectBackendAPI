/**
 * How business code pushes events to connected apps. An abstract class so it is the DI token.
 * Business modules depend on THIS, never on the Socket.IO gateway, so the transport can change
 * (e.g. a Redis adapter for several instances) without touching job or offer logic (decision D-6).
 *
 * Rules for callers:
 *  - publish AFTER the database transaction has committed, never inside it;
 *  - delivery is best effort. Postgres stays the source of truth; apps re-fetch on reconnect;
 *  - build payloads with the same privacy rules as the REST responses (no address, no phone).
 */
export abstract class RealtimePublisher {
  /** To every connection of one user (all their devices). */
  abstract toUser(userId: string, event: string, payload: unknown): void;

  /** To everyone currently watching one job (see the `job:watch` message). */
  abstract toJob(jobId: string, event: string, payload: unknown): void;

  /**
   * Closes every connection of one user (account deletion). The default does nothing, which is right for
   * transports with no connections; the Socket.IO gateway overrides it.
   */
  disconnectUser(userId: string): void {
    void userId;
  }
}
