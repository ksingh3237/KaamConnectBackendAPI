import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Turns the comma-separated REALTIME_CORS_ORIGINS setting into a list.
 * Native mobile apps send no Origin and need no CORS; this only matters for browser clients (Expo web).
 */
export function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Socket.IO server options that must be set once, at creation. */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const merged: Partial<ServerOptions> = {
      ...options,
      // Messages are tiny ({ jobId }); a small cap stops anyone pushing large frames at the server.
      maxHttpBufferSize: 16 * 1024,
      ...(this.origins.length > 0
        ? { cors: { origin: this.origins, credentials: false } }
        : {}),
    };
    return super.createIOServer(port, merged as ServerOptions);
  }
}
