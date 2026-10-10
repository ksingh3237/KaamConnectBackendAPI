import { JwtService } from '@nestjs/jwt';
import { RealtimePublisher } from '../src/modules/realtime/realtime-publisher.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { bookingWindow, makeJob, nextPhone } from './helpers/factories.js';
import { anAreaId } from './helpers/personas.js';
import { ask, closeAllSockets, connect, record } from './helpers/socket.js';

describe('real-time gateway (e2e, real WebSocket connections)', () => {
  let t: TestApp;
  let publisher: RealtimePublisher;

  beforeAll(async () => {
    t = await createTestApp();
    publisher = t.app.get(RealtimePublisher);
  });
  afterAll(async () => {
    closeAllSockets();
    await t.close();
  });
  afterEach(() => closeAllSockets());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  /** A signed-in user who owns a customer profile and one job. */
  async function customerWithJob() {
    const me = await loginAs(t, nextPhone());
    await t.prisma.customerProfile.create({
      data: { userId: me.userId, fullName: 'Sunita' },
    });
    const job = await makeJob(t.prisma, me.userId);
    return { me, job };
  }

  describe('connecting', () => {
    it('accepts a valid access token and puts the user in their own room', async () => {
      const me = await loginAs(t, nextPhone());
      const socket = await connect(t, me.accessToken);
      const events = record(socket);

      publisher.toUser(me.userId, 'test.ping', { n: 1 });
      expect(await events.waitFor('test.ping')).toEqual([{ n: 1 }]);
    });

    it.each([
      ['no token', undefined, 'unauthorized'],
      ['an empty token', '', 'unauthorized'],
      ['a garbage token', 'not.a.jwt', 'unauthorized'],
    ])('refuses %s', async (_label, token, message) => {
      await expect(connect(t, token)).rejects.toThrow(message);
    });

    it('refuses a token signed with another secret, and an unsigned (alg none) token', async () => {
      const me = await loginAs(t, nextPhone());
      const jwt = t.app.get(JwtService);
      const forged = await jwt.signAsync(
        { sub: me.userId },
        { secret: 'attacker-secret-attacker-secret-attacker', expiresIn: 60 },
      );
      await expect(connect(t, forged)).rejects.toThrow('unauthorized');

      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: me.userId, exp: 4102444800 })}.`;
      await expect(connect(t, unsigned)).rejects.toThrow('unauthorized');
    });

    it('tells an expired token apart so the app knows to refresh first', async () => {
      const me = await loginAs(t, nextPhone());
      const expired = await t.app
        .get(JwtService)
        .signAsync({ sub: me.userId }, { expiresIn: -10 });
      await expect(connect(t, expired)).rejects.toThrow('token_expired');
    });

    it('refuses a valid token for a user that no longer exists or was disabled', async () => {
      const ghost = await t.app
        .get(JwtService)
        .signAsync(
          { sub: '018f0000-0000-7000-8000-000000000000' },
          { expiresIn: 60 },
        );
      await expect(connect(t, ghost)).rejects.toThrow('unauthorized');

      const me = await loginAs(t, nextPhone());
      await t.prisma.user.update({
        where: { id: me.userId },
        data: { isActive: false },
      });
      await expect(connect(t, me.accessToken)).rejects.toThrow('unauthorized');
    });

    it('ends the session when the access token that opened it expires', async () => {
      const me = await loginAs(t, nextPhone());
      const shortLived = await t.app
        .get(JwtService)
        .signAsync({ sub: me.userId }, { expiresIn: 2 });
      const socket = await connect(t, shortLived);

      const reason = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error('socket was not closed after the token expired')),
          5000,
        );
        socket.once('disconnect', (why) => {
          clearTimeout(timer);
          resolve(why);
        });
      });
      expect(reason).toBe('io server disconnect');
    });
  });

  describe('who receives what', () => {
    it('delivers only to the addressed user', async () => {
      const alice = await loginAs(t, nextPhone());
      const bob = await loginAs(t, nextPhone());
      const aliceEvents = record(await connect(t, alice.accessToken));
      const bobEvents = record(await connect(t, bob.accessToken));

      publisher.toUser(alice.userId, 'offer.new', { for: 'alice' });

      expect(await aliceEvents.waitFor('offer.new')).toEqual([
        { for: 'alice' },
      ]);
      await bobEvents.expectNone('offer.new');
    });

    it('delivers to every device of the same user', async () => {
      const me = await loginAs(t, nextPhone());
      const phone = record(await connect(t, me.accessToken));
      const tablet = record(await connect(t, me.accessToken));

      publisher.toUser(me.userId, 'job.status', { status: 'ASSIGNED' });

      expect(await phone.waitFor('job.status')).toHaveLength(1);
      expect(await tablet.waitFor('job.status')).toHaveLength(1);
    });

    it("a client cannot subscribe itself to someone else's room by asking", async () => {
      const alice = await loginAs(t, nextPhone());
      const mallory = await loginAs(t, nextPhone());
      const malloryEvents = record(await connect(t, mallory.accessToken));
      const malloryHandle = await connect(t, mallory.accessToken);

      // Unknown messages and attempts to name a room are simply ignored; there is no join-by-name API.
      malloryHandle.emit('join', { room: `user:${alice.userId}` });
      malloryHandle.emit('join', `user:${alice.userId}`);
      publisher.toUser(alice.userId, 'offer.new', { secret: true });

      await malloryEvents.expectNone('offer.new');
    });
  });

  describe('job:watch / job:unwatch', () => {
    it('lets the customer who owns the job watch it', async () => {
      const { me, job } = await customerWithJob();
      const socket = await connect(t, me.accessToken);
      const events = record(socket);

      expect(await ask(socket, 'job:watch', { jobId: job.id })).toEqual({
        ok: true,
      });
      publisher.toJob(job.id, 'job.location', { lat: 30.7, lng: 76.7 });
      expect(await events.waitFor('job.location')).toEqual([
        { lat: 30.7, lng: 76.7 },
      ]);
    });

    it('lets the assigned worker and the requested (direct) worker watch it', async () => {
      const { job } = await customerWithJob();
      const area = await anAreaId(t);

      for (const link of ['workerId', 'targetWorkerId'] as const) {
        const worker = await loginAs(t, nextPhone());
        await t.prisma.workerProfile.create({
          data: {
            userId: worker.userId,
            fullName: 'Rajesh',
            baseAreaId: area,
            experienceYears: 5,
            languages: ['hi'],
            termsAcceptedAt: new Date(),
          },
        });
        // Link this worker to the job the way the app eventually will.
        await t.prisma.job.update({
          where: { id: job.id },
          data:
            link === 'workerId'
              ? {
                  workerId: worker.userId,
                  status: 'ASSIGNED',
                  ...bookingWindow(),
                }
              : { targetWorkerId: worker.userId },
        });
        const socket = await connect(t, worker.accessToken);
        expect(await ask(socket, 'job:watch', { jobId: job.id })).toEqual({
          ok: true,
        });
      }
    });

    it('answers a stranger exactly as it answers an unknown job', async () => {
      const { job } = await customerWithJob();
      const stranger = await loginAs(t, nextPhone());
      const socket = await connect(t, stranger.accessToken);
      const events = record(socket);

      const forbidden = await ask(socket, 'job:watch', { jobId: job.id });
      const unknown = await ask(socket, 'job:watch', {
        jobId: '018f0000-0000-7000-8000-000000000000',
      });
      expect(forbidden).toEqual({ ok: false, error: 'NOT_FOUND' });
      expect(unknown).toEqual(forbidden);

      publisher.toJob(job.id, 'job.location', { lat: 1, lng: 1 });
      await events.expectNone('job.location');
    });

    it('stops delivering after job:unwatch', async () => {
      const { me, job } = await customerWithJob();
      const socket = await connect(t, me.accessToken);
      const events = record(socket);
      await ask(socket, 'job:watch', { jobId: job.id });
      publisher.toJob(job.id, 'job.location', { n: 1 });
      await events.waitFor('job.location');

      expect(await ask(socket, 'job:unwatch', { jobId: job.id })).toEqual({
        ok: true,
      });
      publisher.toJob(job.id, 'job.location', { n: 2 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events.matching('job.location')).toHaveLength(1);
    });

    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['a number', { jobId: 7 }],
      ['not a uuid', { jobId: 'abc' }],
      ['an SQL-looking string', { jobId: "x'; DROP TABLE jobs;--" }],
      ['an array', { jobId: ['018f0000-0000-7000-8000-000000000000'] }],
    ])('rejects %s without touching the database', async (_label, body) => {
      const me = await loginAs(t, nextPhone());
      const socket = await connect(t, me.accessToken);
      expect(await ask(socket, 'job:watch', body)).toEqual({
        ok: false,
        error: 'INVALID',
      });
    });
  });

  describe('abuse limits', () => {
    it('refuses more than 20 messages per second per connection', async () => {
      const me = await loginAs(t, nextPhone());
      const socket = await connect(t, me.accessToken);

      const answers = await Promise.all(
        Array.from({ length: 40 }, () =>
          ask(socket, 'job:watch', { jobId: 'x' }),
        ),
      );
      const limited = answers.filter((a) => a.error === 'RATE_LIMITED').length;
      const invalid = answers.filter((a) => a.error === 'INVALID').length;
      expect(invalid).toBe(20);
      expect(limited).toBe(20);
    });

    it('closes a connection that sends an oversized frame', async () => {
      const me = await loginAs(t, nextPhone());
      const socket = await connect(t, me.accessToken);

      const closed = new Promise<string>((resolve) =>
        socket.once('disconnect', resolve),
      );
      socket.emit('job:watch', { jobId: 'x'.repeat(40_000) });
      expect(await closed).toBeTruthy();
    });
  });

  describe('publisher', () => {
    it('never throws into the caller, even for a user nobody is connected as', () => {
      expect(() =>
        publisher.toUser('018f0000-0000-7000-8000-000000000000', 'x', {}),
      ).not.toThrow();
      expect(() =>
        publisher.toJob('018f0000-0000-7000-8000-000000000000', 'x', {}),
      ).not.toThrow();
    });
  });
});
