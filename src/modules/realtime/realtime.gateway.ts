import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { SkipThrottle } from '@nestjs/throttler';
import type { Namespace, Socket } from 'socket.io';
import { AppException } from '../../common/exceptions/app.exception.js';
import { JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenService } from '../auth/token.service.js';
import { WorkersService } from '../workers/workers.service.js';
import { RealtimePublisher } from './realtime-publisher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Per-socket budget for incoming messages: 20 per second, then they are refused. */
const MAX_MESSAGES_PER_SECOND = 20;
/** A socket that keeps ignoring the limit is dropped. */
const MAX_VIOLATIONS = 50;

export const userRoom = (userId: string) => `user:${userId}`;
export const jobRoom = (jobId: string) => `job:${jobId}`;

interface SocketData {
  userId: string;
  windowStart: number;
  inWindow: number;
  violations: number;
  expiryTimer?: NodeJS.Timeout;
}

type Ack = { ok: true } | { ok: false; error: string };

/**
 * Socket.IO endpoint `/realtime` (namespace). Push only: apps do their reads and writes over REST.
 *  - The access token is checked in the handshake; expired, forged or unknown users are refused.
 *  - A connection is automatically placed in the server-chosen room `user:<id>`. Clients can never
 *    join an arbitrary room; `job:watch` joins `job:<id>` only after an ownership check.
 *  - A connection is closed when its access token expires, so a session cannot outlive its login.
 *
 * The global HTTP guards do not apply here, so every rule is enforced in this file.
 */
@SkipThrottle()
@WebSocketGateway({ namespace: 'realtime' })
export class RealtimeGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    RealtimePublisher
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly workers: WorkersService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.authenticate(socket)
        .then(() => next())
        .catch((error: unknown) => {
          const code =
            error instanceof AppException ? error.code : 'UNAUTHENTICATED';
          next(
            new Error(
              code === 'TOKEN_EXPIRED' ? 'token_expired' : 'unauthorized',
            ),
          );
        });
    });
  }

  handleConnection(socket: Socket): void {
    const data = socket.data as SocketData;
    void socket.join(userRoom(data.userId));
  }

  handleDisconnect(socket: Socket): void {
    const data = socket.data as Partial<SocketData>;
    if (data.expiryTimer) clearTimeout(data.expiryTimer);
  }

  // --- Publisher side (called by business code) ---

  toUser(userId: string, event: string, payload: unknown): void {
    this.emit(userRoom(userId), event, payload);
  }

  toJob(jobId: string, event: string, payload: unknown): void {
    this.emit(jobRoom(jobId), event, payload);
  }

  // --- Messages from apps ---

  /** Start receiving `job.*` events for one job. Allowed for the customer, the assigned or the requested worker. */
  @SubscribeMessage('job:watch')
  async watch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    if (!this.allow(socket)) return { ok: false, error: 'RATE_LIMITED' };
    const jobId = this.parseJobId(body);
    if (!jobId) return { ok: false, error: 'INVALID' };

    const userId = (socket.data as SocketData).userId;
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [
          { customerId: userId },
          { workerId: userId },
          { targetWorkerId: userId },
        ],
      },
      select: { id: true },
    });
    if (!job) return { ok: false, error: 'NOT_FOUND' }; // same answer for "no such job" and "not yours"

    await socket.join(jobRoom(jobId));
    return { ok: true };
  }

  /**
   * The worker's phone reports its position while on the way to (or at) a job, instead of the REST call.
   * Same effect as `PUT /workers/me/location` (stored, throttled to one fix per 3 s, rebroadcast to the
   * job's watchers as `job.location`), but only for a job assigned to this very worker.
   */
  @SubscribeMessage('location:update')
  async locationUpdate(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack & { accepted?: boolean }> {
    if (!this.allow(socket)) return { ok: false, error: 'RATE_LIMITED' };
    const input = body as {
      jobId?: unknown;
      lat?: unknown;
      lng?: unknown;
    } | null;
    const jobId = this.parseJobId(body);
    const lat = input?.lat;
    const lng = input?.lng;
    if (
      !jobId ||
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      return { ok: false, error: 'INVALID' };

    const userId = (socket.data as SocketData).userId;
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        workerId: userId,
        status: { in: [JobStatus.ASSIGNED, JobStatus.ARRIVED] },
      },
      select: { id: true },
    });
    if (!job) return { ok: false, error: 'NOT_FOUND' }; // not yours, or not under way

    const result = await this.workers.updateLocation(userId, lat, lng);
    return { ok: true, accepted: result.accepted };
  }

  @SubscribeMessage('job:unwatch')
  async unwatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    if (!this.allow(socket)) return { ok: false, error: 'RATE_LIMITED' };
    const jobId = this.parseJobId(body);
    if (!jobId) return { ok: false, error: 'INVALID' };
    await socket.leave(jobRoom(jobId));
    return { ok: true };
  }

  // --- Internals ---

  private async authenticate(socket: Socket): Promise<void> {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)
      ?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');
    }
    const { userId, expiresAt } = await this.tokens.verifyAccessClaims(token);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    if (!user?.isActive)
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');

    const data: SocketData = {
      userId,
      windowStart: Date.now(),
      inWindow: 0,
      violations: 0,
    };
    // End the session when the token that opened it expires; the app reconnects with a fresh one.
    const msLeft = Math.max(0, expiresAt.getTime() - Date.now());
    data.expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.min(msLeft, 2 ** 31 - 1),
    );
    data.expiryTimer.unref();
    socket.data = data;
  }

  /** Validates the payload shape. Returns the job id or null. */
  private parseJobId(body: unknown): string | null {
    const jobId = (body as { jobId?: unknown } | null)?.jobId;
    return typeof jobId === 'string' && UUID.test(jobId) ? jobId : null;
  }

  private allow(socket: Socket): boolean {
    const data = socket.data as SocketData;
    const now = Date.now();
    if (now - data.windowStart >= 1000) {
      data.windowStart = now;
      data.inWindow = 0;
    }
    data.inWindow += 1;
    if (data.inWindow <= MAX_MESSAGES_PER_SECOND) return true;

    data.violations += 1;
    if (data.violations >= MAX_VIOLATIONS) socket.disconnect(true);
    return false;
  }

  private emit(room: string, event: string, payload: unknown): void {
    try {
      this.server.to(room).emit(event, payload);
    } catch (error) {
      // Best effort by design: a failed push must never fail the request that triggered it.
      this.logger.warn(
        `emit ${event} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
