import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type { TestApp } from './app.js';

const open: Socket[] = [];

export function socketUrl(t: TestApp): string {
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}/realtime`;
}

/** A real WebSocket client. Resolves once connected; rejects with the server's refusal message. */
export async function connect(t: TestApp, token?: string): Promise<Socket> {
  const socket = io(socketUrl(t), {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  open.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(new Error(error.message)));
  });
  return socket;
}

export function closeAllSockets(): void {
  while (open.length > 0) open.pop()!.close();
}

export interface Received {
  event: string;
  payload: unknown;
}

/** Records every event a socket receives so a test can look at them afterwards. */
export function record(socket: Socket) {
  const received: Received[] = [];
  socket.onAny((event: string, payload: unknown) =>
    received.push({ event, payload }),
  );

  const matching = (event: string) =>
    received.filter((r) => r.event === event).map((r) => r.payload);

  return {
    received,
    matching,
    /** Waits until `count` events with this name arrived (default 1) and returns their payloads. */
    async waitFor(event: string, count = 1, timeoutMs = 3000): Promise<any[]> {
      const deadline = Date.now() + timeoutMs;
      while (matching(event).length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for ${count} x "${event}". Got: ${JSON.stringify(received.map((r) => r.event))}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return matching(event);
    },
    /** Gives events time to arrive, then asserts none of this name did. */
    async expectNone(event: string, waitMs = 300): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (matching(event).length > 0) {
        throw new Error(
          `Unexpected "${event}": ${JSON.stringify(matching(event))}`,
        );
      }
    },
  };
}

export async function ask(
  socket: Socket,
  event: string,
  body: unknown,
): Promise<any> {
  return socket.timeout(2000).emitWithAck(event, body);
}
