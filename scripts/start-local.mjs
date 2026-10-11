// Starts the BUILT API (dist/main.js) with LOCAL-DEVELOPMENT defaults for full-stack testing against the Expo app.
//
//   npm run build && npm run dev:local
//
// What it turns on (a value set in your SHELL always wins; the three development-only switches below also override .env,
// the others only fill gaps in .env):
//   OTP_DEV_BYPASS=true      the fixed development code 123456 for every number; no SMS is sent. The application
//                            refuses this setting when NODE_ENV=production, and this script refuses to run then too.
//   CORS_ORIGINS / REALTIME_CORS_ORIGINS   the Expo web dev server ports, so a browser may call the API.
//   PUBLIC_BASE_URL          where the local file store's signed upload URLs point.
//   SOS_WEBHOOK_URL          the local mock SOS receiver (npm run mock:sos).
// It never reads or prints secrets, and it does not edit .env.
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// What the SHELL set, before .env is read: a value given on the command line always wins over this profile.
const shellEnv = { ...process.env };
dotenv.config();

const fail = (message) => {
  console.error(`\nstart-local: ${message}\n`);
  process.exit(1);
};

if ((process.env.NODE_ENV ?? 'development') === 'production')
  fail(
    'refusing to run with NODE_ENV=production: this profile enables development-only switches.',
  );
if (!process.env.DATABASE_URL)
  fail('DATABASE_URL is not set (see .env.example).');
let host;
try {
  host = new URL(process.env.DATABASE_URL).hostname;
} catch {
  fail('DATABASE_URL is not a valid URL.');
}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host))
  fail(
    `refusing to enable development switches against a non-local database host ("${host}").`,
  );
if (!existsSync('dist/main.js'))
  fail('dist/main.js not found. Run "npm run build" first.');

const port = process.env.PORT ?? '3000';
const webOrigins = [
  'http://localhost:8081',
  'http://localhost:8088',
  'http://127.0.0.1:8081',
  'http://127.0.0.1:8088',
  'http://localhost:19006',
].join(',');
// Development-only switches the profile turns on even when .env has them off; the rest only fill gaps.
const FORCED = new Set(['OTP_DEV_BYPASS', 'SMS_PROVIDER', 'STORAGE_PROVIDER']);
const defaults = {
  NODE_ENV: 'development',
  OTP_DEV_BYPASS: 'true',
  SMS_PROVIDER: 'console',
  CORS_ORIGINS: webOrigins,
  REALTIME_CORS_ORIGINS: webOrigins,
  PUBLIC_BASE_URL: `http://localhost:${port}`,
  SOS_WEBHOOK_URL: 'http://localhost:4010/sos',
  STORAGE_PROVIDER: 'local',
  // Local development convenience: a worker with both documents is approved on save (refused in production).
  WORKER_VERIFICATION_MODE: process.env.WORKER_VERIFICATION_MODE ?? 'auto',
};
// This profile is the explicit "local development" switch, so for the keys below it OVERRIDES what .env says
// (a .env that says OTP_DEV_BYPASS=false would otherwise silently defeat the point of running it). A value set in
// the SHELL still wins, so "OTP_DEV_BYPASS=false npm run dev:local" gives real codes.
for (const [key, value] of Object.entries(defaults)) {
  const fromShell = shellEnv[key];
  if (fromShell !== undefined && fromShell !== '') process.env[key] = fromShell;
  else if (FORCED.has(key) || !process.env[key]) process.env[key] = value;
}

console.log(`
============================================================
 KaamConnect API: LOCAL DEVELOPMENT PROFILE
 http://localhost:${port}/api/v1   (database host: ${host})
 DEV OTP: any 10-digit number, code ${process.env.OTP_DEV_BYPASS === 'true' ? '123456' : '(bypass is off: read the code in this log)'}
 Not for production: the app refuses these settings there.
============================================================
`);

const child = spawn(process.execPath, ['dist/main.js'], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
