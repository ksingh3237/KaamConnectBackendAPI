// LOCAL STAND-IN for the safety desk. Receives the SOS webhook the API sends (SOS_WEBHOOK_URL=http://localhost:4010/sos,
// the default of `npm run dev:local`), prints each alert and answers 200 so the API marks it delivered.
//
// This is NOT a real receiver. Real receiver details (a Slack/Teams bridge, PagerDuty, a call-centre system) are still
// to be provided; until then production must not rely on this.
//
//   npm run mock:sos                  answer 200 to every alert
//   npm run mock:sos -- --fail 2      answer 503 to the first 2 alerts, to watch the API retry (30 s, then 60 s)
//   npm run mock:sos -- --port 4011   listen elsewhere
//
// Open http://localhost:4010/ to see what it has received (JSON). Nothing is stored on disk.
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const port = Number(flag('port', process.env.MOCK_SOS_PORT ?? '4010'));
let failures = Number(flag('fail', process.env.MOCK_SOS_FAIL_FIRST ?? '0'));

const received = [];

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mock: true, failuresLeft: failures, received }, null, 2));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/sos') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 100_000) req.destroy();
  });
  req.on('end', () => {
    let alert;
    try {
      alert = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const stamp = new Date().toISOString();
    if (failures > 0) {
      failures -= 1;
      console.log(`[${stamp}] SOS ${alert.alertId} -> answering 503 on purpose (${failures} more to refuse)`);
      res.writeHead(503).end();
      return;
    }
    received.push({ at: stamp, alert });
    console.log(
      `[${stamp}] SOS RECEIVED ${alert.alertId} on ${alert.jobReference} ` +
        `raised by the ${String(alert.raisedBy?.role).toLowerCase()}; ` +
        `location ${alert.location ? `${alert.location.lat},${alert.location.lng} (${alert.location.source})` : 'unknown'}`,
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock SOS receiver on http://127.0.0.1:${port}/sos (local development only)`);
  if (failures > 0) console.log(`The first ${failures} alert(s) will be refused with 503 to exercise the retry.`);
});
