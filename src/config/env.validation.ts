import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum SmsProvider {
  Console = 'console',
  Msg91 = 'msg91',
}

export enum StorageProvider {
  Local = 'local',
  S3 = 's3',
}

export enum WorkerVerificationMode {
  Auto = 'auto',
  Manual = 'manual',
}

const toBoolean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() === 'true' : value;

// Empty strings in .env (e.g. `REDIS_URL=`) mean "not set".
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const toNumber = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

const POSTGRES_URL = /^postgres(ql)?:\/\/.+/;

/** Every environment variable the app reads. Defaults are the safe choice. */
export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @Matches(POSTGRES_URL, {
    message: 'DATABASE_URL must be a postgresql:// URL',
  })
  DATABASE_URL!: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @Matches(POSTGRES_URL, {
    message: 'TEST_DATABASE_URL must be a postgresql:// URL',
  })
  TEST_DATABASE_URL?: string;

  // --- Dev-only switches (D-2, D-4): boot is refused in production ---
  @Transform(toBoolean)
  @IsBoolean()
  OTP_DEV_BYPASS: boolean = false;

  @IsEnum(SmsProvider)
  SMS_PROVIDER: SmsProvider = SmsProvider.Console;

  @IsEnum(WorkerVerificationMode)
  WORKER_VERIFICATION_MODE: WorkerVerificationMode =
    WorkerVerificationMode.Manual;

  // --- Network ---
  // Number of reverse proxies in front of the app (AWS ALB = 1). 0 = connect directly.
  // Needed so rate limits key on the real client IP rather than the load balancer's.
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY: number = 0;

  // --- Authentication (Phase 2) ---
  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters',
  })
  JWT_ACCESS_SECRET!: string;

  @Transform(toNumber)
  @IsInt()
  @Min(60)
  @Max(3600)
  JWT_ACCESS_TTL_SEC: number = 900;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  REFRESH_TTL_DAYS: number = 30;

  // HMAC key for OTP hashes. Must differ from the JWT secret.
  @IsString()
  @MinLength(32, { message: 'OTP_PEPPER must be at least 32 characters' })
  OTP_PEPPER!: string;

  @Transform(toNumber)
  @IsInt()
  @Min(60)
  @Max(900)
  OTP_TTL_SEC: number = 300;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(600)
  OTP_RESEND_SEC: number = 30;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(10)
  OTP_MAX_ATTEMPTS: number = 5;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  OTP_MAX_REQUESTS_PER_HOUR: number = 5;

  // --- File storage (Phase 3) ---
  // local: signed uploads to a folder on this machine (development only; refused in production).
  // s3: real S3-compatible storage. Aadhaar images always go to the private bucket.
  @IsEnum(StorageProvider)
  STORAGE_PROVIDER: StorageProvider = StorageProvider.Local;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_LOCAL_DIR?: string;

  // Absolute origin clients use to reach this API (used for local-storage upload URLs).
  @Transform(emptyToUndefined)
  @IsOptional()
  @Matches(/^https?:\/\/[^/\s]+$/, {
    message: 'PUBLIC_BASE_URL must look like https://host[:port] with no path',
  })
  PUBLIC_BASE_URL?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_REGION?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_BUCKET?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_BUCKET_PRIVATE?: string;

  // Only for S3-compatible services (MinIO, LocalStack). Leave empty for AWS.
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_ENDPOINT?: string;

  // Leave both empty on AWS to use the instance/task IAM role (preferred over static keys).
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_ACCESS_KEY?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  STORAGE_SECRET_KEY?: string;

  // --- Real-time (Socket.IO) ---
  // Comma-separated browser origins allowed to open a WebSocket (e.g. the Expo web dev server).
  // Native mobile apps send no Origin and need nothing here. Empty = no browser origin allowed.
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  REALTIME_CORS_ORIGINS?: string;

  // Comma-separated browser origins allowed to call the HTTP API (for example the Expo web dev server at
  // http://localhost:8081). Native mobile apps send no Origin and need nothing here. Empty = no browser origin
  // allowed, which is the safe default and what production uses until a web client exists. Exact origins only.
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // File the account-deletion ledger is appended to (one JSON line per deletion: user id and time, nothing else).
  // The ledger must live OUTSIDE the database and be kept with the backups, so a restore can re-apply deletions
  // (docs/08 section 1.5). Unset = deletions are only written to the application log (fine for local development).
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  DELETION_LEDGER_FILE?: string;

  // --- Business configuration ---
  // Minutes after the assigned worker's promised arrival (quoted ETA, or the booked start) before an assigned job that
  // the worker has not arrived at is released automatically as a no-show (docs/15-no-show.md).
  @Transform(toNumber)
  @IsInt()
  @Min(5)
  NO_SHOW_GRACE_MIN: number = 30;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  JOB_OPEN_TTL_HOURS: number = 24;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  DIRECT_ACCEPT_TTL_MIN: number = 10;

  /** A request for "now" (IMMEDIATE) stops taking quotes after this many minutes: by then the need has passed. */
  @Transform(toNumber)
  @IsInt()
  @Min(15)
  IMMEDIATE_JOB_OPEN_TTL_MIN: number = 120;

  @Transform(toNumber)
  @IsNumber()
  @Min(1)
  AVG_SPEED_KMH: number = 20;

  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(1)
  COMMISSION_BENCHMARK_RATE: number = 0.2;

  // --- Rate limiting ---
  // Requests one signed-in user may make per minute across ALL routes, on top of the per-IP limits, which are
  // unchanged. Generous for a person (4 a second, sustained) and a hard stop for a script. 30 is the floor so a
  // typo cannot lock everyone out.
  @Transform(toNumber)
  @IsInt()
  @Min(30)
  @Max(100000)
  USER_RATE_LIMIT_PER_MIN: number = 240;

  // --- Safety (decision Q-10) ---
  // Where SOS alerts are POSTed as JSON. Required in production so an alert can never go nowhere;
  // without it (development) alerts are only written to the log.
  @Transform(emptyToUndefined)
  @IsOptional()
  @Matches(/^https?:\/\/\S+$/, {
    message: 'SOS_WEBHOOK_URL must be an http(s) URL',
  })
  SOS_WEBHOOK_URL?: string;

  // --- MSG91 OTP widget sign-in (docs/msg91-otp-integration.md) ---
  // Off by default: POST /auth/msg91/verify answers 404 until it is switched on.
  @Transform(toBoolean)
  @IsBoolean()
  MSG91_WIDGET_ENABLED: boolean = false;

  // Account-level Authkey. A real secret: server only, never in the mobile app.
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  MSG91_AUTHKEY?: string;

  // --- Push notifications (Firebase Cloud Messaging) ---
  // Firebase service-account key: the JSON file's contents, or that JSON base64-encoded. A real secret: server only.
  // Unset = push is skipped (the in-app notification inbox still works).
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  FIREBASE_SERVICE_ACCOUNT?: string;

  // --- Scheduling and availability (docs/01-requirements.md BR-13 to BR-22) ---
  // Length of a booking window when the customer does not say (A-13).
  @Transform(toNumber)
  @IsInt()
  @Min(15)
  @Max(480)
  BOOKING_DEFAULT_DURATION_MIN: number = 90;

  // Smallest gap between two bookings of one worker, however close the places are.
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(240)
  BOOKING_BUFFER_MIN: number = 15;

  // Gap assumed when either place has no coordinates yet (Q-18).
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(240)
  BOOKING_DEFAULT_TRAVEL_MIN: number = 30;

  // A requested appointment must be at least this far ahead, and at most SCHEDULE_MAX_DAYS ahead.
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(1440)
  SCHEDULE_MIN_LEAD_MIN: number = 30;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(365)
  SCHEDULE_MAX_DAYS: number = 30;

  // How long a scheduled request keeps collecting quotes (never past its own appointment time).
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(720)
  SCHEDULED_JOB_OPEN_TTL_HOURS: number = 72;

  // --- Optional ---
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  REDIS_URL?: string;
}

/** Database name from a postgres URL ("KaamConnect_test"), or undefined if unparsable. */
export function databaseNameOf(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rules that span several variables. Returns human-readable problems; empty = fine.
 * Kept separate from the decorators so each rule is unit-testable.
 */
export function crossFieldProblems(env: EnvVars): string[] {
  const problems: string[] = [];

  if (env.NODE_ENV === NodeEnv.Production) {
    if (env.OTP_DEV_BYPASS) {
      problems.push('OTP_DEV_BYPASS must be false in production');
    }
    if (env.SMS_PROVIDER === SmsProvider.Console) {
      problems.push(
        'SMS_PROVIDER=console (logs OTPs) is not allowed in production',
      );
    }
    if (env.WORKER_VERIFICATION_MODE === WorkerVerificationMode.Auto) {
      problems.push(
        'WORKER_VERIFICATION_MODE=auto (simulated approval) is not allowed in production; use manual',
      );
    }
    if (!env.SOS_WEBHOOK_URL) {
      problems.push(
        'SOS_WEBHOOK_URL is required in production: an SOS must reach a person, not just the log',
      );
    } else if (!env.SOS_WEBHOOK_URL.startsWith('https://')) {
      problems.push('SOS_WEBHOOK_URL must be https:// in production');
    }
    if (env.STORAGE_PROVIDER === StorageProvider.Local) {
      problems.push(
        'STORAGE_PROVIDER=local (files on the server disk) is not allowed in production; use s3',
      );
    }
  }

  if (env.MSG91_WIDGET_ENABLED && !env.MSG91_AUTHKEY) {
    problems.push('MSG91_AUTHKEY is required when MSG91_WIDGET_ENABLED=true');
  }

  if (env.STORAGE_PROVIDER === StorageProvider.S3) {
    for (const key of [
      'STORAGE_REGION',
      'STORAGE_BUCKET',
      'STORAGE_BUCKET_PRIVATE',
    ] as const) {
      if (!env[key])
        problems.push(`${key} is required when STORAGE_PROVIDER=s3`);
    }
    if (
      env.STORAGE_BUCKET &&
      env.STORAGE_BUCKET === env.STORAGE_BUCKET_PRIVATE
    ) {
      problems.push(
        'STORAGE_BUCKET and STORAGE_BUCKET_PRIVATE must be different buckets (Aadhaar images are kept separately)',
      );
    }
    if (Boolean(env.STORAGE_ACCESS_KEY) !== Boolean(env.STORAGE_SECRET_KEY)) {
      problems.push(
        'STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be set together (or both empty to use an IAM role)',
      );
    }
  }

  for (const origin of (env.REALTIME_CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)) {
    if (!/^https?:\/\/[^/\s*]+$/.test(origin)) {
      problems.push(
        `REALTIME_CORS_ORIGINS entry "${origin}" must look like https://host[:port] (no path, no wildcard)`,
      );
    }
  }

  for (const origin of (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)) {
    if (!/^https?:\/\/[^/\s*]+$/.test(origin)) {
      problems.push(
        `CORS_ORIGINS entry "${origin}" must look like https://host[:port] (no path, no wildcard)`,
      );
    }
  }

  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.OTP_PEPPER) {
    problems.push('JWT_ACCESS_SECRET and OTP_PEPPER must be different keys');
  }

  if (env.TEST_DATABASE_URL) {
    const testDb = databaseNameOf(env.TEST_DATABASE_URL);
    if (!testDb || !testDb.toLowerCase().endsWith('_test')) {
      problems.push(
        'TEST_DATABASE_URL must point to a database whose name ends in _test',
      );
    }
    // Under NODE_ENV=test the harness deliberately points DATABASE_URL at the test database.
    if (
      env.NODE_ENV !== NodeEnv.Test &&
      env.DATABASE_URL &&
      env.DATABASE_URL === env.TEST_DATABASE_URL
    ) {
      problems.push('TEST_DATABASE_URL must differ from DATABASE_URL');
    }
  }

  return problems;
}

/** Passed to ConfigModule.forRoot({ validate }). Throws one error listing every problem. */
export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const env = plainToInstance(EnvVars, raw, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(env, { skipMissingProperties: false });

  const problems = errors.flatMap((e) =>
    Object.values(e.constraints ?? {}).map(
      (message) => `${e.property}: ${message}`,
    ),
  );
  if (problems.length === 0) {
    problems.push(...crossFieldProblems(env));
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return env;
}
