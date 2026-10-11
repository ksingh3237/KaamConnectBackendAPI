import { expect } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { api, freshIp, type TestApp } from './app.js';

export interface LoggedIn {
  phone: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  isNewUser: boolean;
}

/** Moves the newest challenge's creation time back so the resend cooldown no longer applies. */
export async function expireCooldown(
  prisma: PrismaService,
  phone: string,
): Promise<void> {
  await prisma.otpChallenge.updateMany({
    where: { phone },
    data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) },
  });
}

/** Full real login: request a code, read it from the recording sender, verify it. */
export async function loginAs(t: TestApp, phone: string): Promise<LoggedIn> {
  const http = api(t.app);
  const ip = freshIp();
  await expireCooldown(t.prisma, phone); // allow repeat logins of the same phone within one test
  await http.post('/api/v1/auth/otp/request', { phone }, { ip }).expect(202);
  const res = await http
    .post(
      '/api/v1/auth/otp/verify',
      { phone, code: t.sender.lastCode(phone) },
      { ip },
    )
    .expect(200);
  expect(res.body.accessToken).toBeTruthy();
  return {
    phone,
    userId: res.body.user.id,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    isNewUser: res.body.isNewUser,
  };
}
