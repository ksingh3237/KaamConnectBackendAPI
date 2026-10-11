import type {
  Prisma,
  PrismaClient,
} from '../../src/generated/prisma/client.js';

let phoneCounter = 0;
/** Unique, valid-looking Indian mobile numbers (E.164). */
export function nextPhone(): string {
  phoneCounter += 1;
  return `+91900000${String(phoneCounter).padStart(4, '0')}`;
}

export async function makeUser(prisma: PrismaClient) {
  return prisma.user.create({ data: { phone: nextPhone() } });
}

export async function anyArea(prisma: PrismaClient) {
  return prisma.area.findFirstOrThrow({ orderBy: { id: 'asc' } });
}

export async function makeCustomer(prisma: PrismaClient) {
  const user = await makeUser(prisma);
  return prisma.customerProfile.create({
    data: { userId: user.id, fullName: 'Test Customer' },
  });
}

export async function makeWorker(
  prisma: PrismaClient,
  overrides: { radiusKm?: number; experienceYears?: number } = {},
) {
  const user = await makeUser(prisma);
  const area = await anyArea(prisma);
  return prisma.workerProfile.create({
    data: {
      userId: user.id,
      fullName: 'Test Worker',
      baseAreaId: area.id,
      radiusKm: overrides.radiusKm ?? 6,
      experienceYears: overrides.experienceYears ?? 8,
      languages: ['hi'],
      skills: ['Wiring'],
      termsAcceptedAt: new Date(),
    },
  });
}

const MINUTE_MS = 60_000;
/** Statuses in which a job must already carry its confirmed booking window (database CHECK). */
const BOOKED_STATUSES = [
  'ASSIGNED',
  'ARRIVED',
  'IN_PROGRESS',
  'WORK_COMPLETED',
  'COMPLETED',
];

/** A confirmed-booking window starting `startOffsetMin` from now. */
export function bookingWindow(startOffsetMin = 0, durationMin = 90) {
  const start = new Date(Date.now() + startOffsetMin * MINUTE_MS);
  return {
    bookedStartAt: start,
    bookedEndAt: new Date(start.getTime() + durationMin * MINUTE_MS),
    bookingConfirmedAt: new Date(),
  };
}

export async function makeJob(
  prisma: PrismaClient,
  customerId: string,
  data: Partial<Prisma.JobUncheckedCreateInput> = {},
) {
  const area = await anyArea(prisma);
  // A job that skips straight to an assigned status needs a booking window, as in real life.
  const booking =
    data.status &&
    BOOKED_STATUSES.includes(data.status) &&
    data.bookedStartAt === undefined
      ? bookingWindow()
      : {};
  return prisma.job.create({
    data: {
      customerId,
      categoryId: 'plumber',
      title: 'Kitchen sink pipe burst',
      timing: 'IMMEDIATE',
      areaId: area.id,
      addressLine: 'House 1402, Sector 22',
      ...booking,
      ...data,
    },
  });
}
