// K-5: an account that is disabled in the database (users.is_active = false) must be refused on EVERY protected
// route at once, even though the access token it holds is still valid for up to 15 minutes. The error is
// `403 ACCOUNT_DISABLED`, except on admin routes, which keep answering 404 so the admin API is never advertised.
//
// Instead of picking routes by hand, this enumerates every route the application registers, so a route added
// later is covered automatically.

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { ADMIN_ONLY_KEY } from '../src/common/decorators/require-profile.decorator.js';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1, bothProfiles } from './helpers/fulfilment.js';

interface RouteInfo {
  verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  template: string;
  url: string;
  isPublic: boolean;
  adminOnly: boolean;
}

const SOME_ID = '0197a0c0-0000-7000-8000-000000000000';

describe('K-5: a disabled account is refused on every protected route (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let routes: RouteInfo[];
  let person: { accessToken: string; refreshToken: string; userId: string }; // customer AND worker, disabled below
  let admin: { accessToken: string; userId: string }; // admin, disabled below
  let active: { accessToken: string; userId: string }; // control: never disabled

  const call = (route: RouteInfo, token: string | null) => {
    const opts = token ? { token } : {};
    switch (route.verb) {
      case 'GET':
        return http.get(route.url, opts);
      case 'DELETE':
        return http.delete(route.url, opts);
      case 'POST':
        return http.post(route.url, {}, opts);
      case 'PUT':
        return http.put(route.url, {}, opts);
      case 'PATCH':
        return http.patch(route.url, {}, opts);
    }
  };

  function discoverRoutes(): RouteInfo[] {
    const found: RouteInfo[] = [];
    const verbs: Record<number, RouteInfo['verb'] | undefined> = {
      [RequestMethod.GET]: 'GET',
      [RequestMethod.POST]: 'POST',
      [RequestMethod.PUT]: 'PUT',
      [RequestMethod.PATCH]: 'PATCH',
      [RequestMethod.DELETE]: 'DELETE',
    };
    for (const module of t.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as
          (new (...args: never[]) => object) | null;
        if (!controller) continue;
        const base = String(
          Reflect.getMetadata(PATH_METADATA, controller) ?? '',
        );
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[
            name
          ];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as
            number | undefined;
          const verb = method === undefined ? undefined : verbs[method];
          if (!verb) continue;
          const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
          const path = ('/' + base + '/' + sub)
            .replace(/\/+/g, '/')
            .replace(/\/$/, '');
          const flag = (key: string) =>
            Boolean(
              Reflect.getMetadata(key, handler) ??
              Reflect.getMetadata(key, controller),
            );
          const isPublic = flag(IS_PUBLIC_KEY);
          const url = (
            isPublic && path.startsWith('/health') ? path : V1 + path
          )
            .replace(/:type/g, 'AADHAAR_FRONT')
            .replace(/:[A-Za-z]+/g, SOME_ID)
            .replace(/\*\w+/g, 'k');
          found.push({
            verb,
            template: `${verb} ${path}`,
            url,
            isPublic,
            adminOnly: flag(ADMIN_ONLY_KEY),
          });
        }
      }
    }
    return found;
  }

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    routes = discoverRoutes();

    person = await bothProfiles(t);
    active = await bothProfiles(t);
    const a = await loginAs(t, nextPhone());
    await t.prisma.user.update({
      where: { id: a.userId },
      data: { isAdmin: true },
    });
    admin = a;

    // The tokens above were issued while the accounts were active, and stay valid. Now disable two of them.
    await t.prisma.user.updateMany({
      where: { id: { in: [person.userId, admin.userId] } },
      data: { isActive: false },
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('finds the routes it is meant to probe (so the test cannot pass by finding nothing)', () => {
    const protectedRoutes = routes.filter((r) => !r.isPublic);
    expect(routes.length).toBe(64);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(50);
    expect(
      protectedRoutes
        .filter((r) => r.adminOnly)
        .map((r) => r.template)
        .sort(),
    ).toEqual([
      'GET /admin/workers',
      'PATCH /admin/service-categories/:id/duration',
      'POST /admin/workers/:id/reject',
      'POST /admin/workers/:id/verify',
    ]);
    // Public routes (login, refresh, health) are deliberately left alone.
    expect(
      routes
        .filter((r) => r.isPublic)
        .map((r) => r.template)
        .sort(),
    ).toEqual(
      [
        'GET /health',
        'GET /health/ready',
        'POST /auth/otp/request',
        'POST /auth/otp/verify',
        'POST /auth/refresh',
        // The development stand-in for S3: authorised by a signed URL, not by a login.
        'GET /dev-storage/:bucket/*key',
        'PUT /dev-storage/:bucket/*key',
      ].sort(),
    );
  });

  it('every protected route answers 403 ACCOUNT_DISABLED to a disabled user holding a valid token', async () => {
    const wrong: string[] = [];
    for (const route of routes.filter((r) => !r.isPublic && !r.adminOnly)) {
      const res = await call(route, person.accessToken);
      if (res.status !== 403 || res.body.code !== 'ACCOUNT_DISABLED')
        wrong.push(`${route.template} -> ${res.status} ${res.body.code}`);
    }
    expect(wrong).toEqual([]);
  });

  it('admin routes keep answering 404 to a disabled admin: the admin API is never advertised', async () => {
    const wrong: string[] = [];
    for (const route of routes.filter((r) => r.adminOnly)) {
      const res = await call(route, admin.accessToken);
      if (res.status !== 404 || res.body.code !== 'NOT_FOUND')
        wrong.push(`${route.template} -> ${res.status} ${res.body.code}`);
    }
    expect(wrong).toEqual([]);
  });

  it('control: the same probes with an ACTIVE user never produce ACCOUNT_DISABLED', async () => {
    const wrong: string[] = [];
    for (const route of routes.filter((r) => !r.isPublic && !r.adminOnly)) {
      // Skip the route that would end this user's session.
      if (route.template === 'POST /auth/logout') continue;
      const res = await call(route, active.accessToken);
      if (res.body?.code === 'ACCOUNT_DISABLED') wrong.push(route.template);
    }
    expect(wrong).toEqual([]);
  });

  it('nothing is written on behalf of a disabled user: no job is created, nothing is changed', async () => {
    const before = await t.prisma.job.count();
    const post = routes.find((r) => r.template === 'POST /jobs')!;
    const res = await http.post(
      post.url,
      { categoryId: 'plumber', title: 'Leaking tap', timing: 'IMMEDIATE' },
      { token: person.accessToken },
    );
    expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
    expect(await t.prisma.job.count()).toBe(before);
  });

  it('the decision is read from the database each time: re-enabling works on the very next request, with the same token', async () => {
    const list = routes.find((r) => r.template === 'GET /customers/me/jobs')!;
    expect((await call(list, person.accessToken)).status).toBe(403);
    await t.prisma.user.update({
      where: { id: person.userId },
      data: { isActive: true },
    });
    expect((await call(list, person.accessToken)).status).toBe(200);
    await t.prisma.user.update({
      where: { id: person.userId },
      data: { isActive: false },
    });
    const again = await call(list, person.accessToken);
    expect([again.status, again.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
  });

  it('GET /me, which used to answer 401 for a disabled account, now says why (403 ACCOUNT_DISABLED)', async () => {
    const res = await http.get(`${V1}/me`, { token: person.accessToken });
    expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
  });

  it('a disabled account cannot get a new token either: refresh answers the same code, and the family is revoked', async () => {
    const res = await http.post(`${V1}/auth/refresh`, {
      refreshToken: person.refreshToken,
    });
    expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
    // Revoked for good: even after re-enabling the account, that refresh token is dead.
    await t.prisma.user.update({
      where: { id: person.userId },
      data: { isActive: true },
    });
    expect(
      (
        await http.post(`${V1}/auth/refresh`, {
          refreshToken: person.refreshToken,
        })
      ).status,
    ).toBe(401);
    await t.prisma.user.update({
      where: { id: person.userId },
      data: { isActive: false },
    });
  });
});
