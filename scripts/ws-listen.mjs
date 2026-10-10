// Used by scripts/smoke.sh: connects to /realtime with an access token and writes every event it
// receives to a file as JSON lines, for `waitMs` milliseconds. Usage:
//   node scripts/ws-listen.mjs <baseUrl> <accessToken> <outFile> <waitMs>
import { appendFileSync, writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const [, , baseUrl, token, outFile, waitMs] = process.argv;
writeFileSync(outFile, '');

const socket = io(`${baseUrl}/realtime`, { auth: { token }, transports: ['websocket'], reconnection: false });
socket.on('connect', () => appendFileSync(outFile, JSON.stringify({ event: '__connected' }) + '\n'));
socket.on('connect_error', (error) => appendFileSync(outFile, JSON.stringify({ event: '__error', message: error.message }) + '\n'));
socket.onAny((event, payload) => appendFileSync(outFile, JSON.stringify({ event, payload }) + '\n'));

setTimeout(() => {
  socket.close();
  process.exit(0);
}, Number(waitMs));
