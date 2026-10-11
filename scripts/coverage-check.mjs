// Merges the unit and e2e coverage reports and enforces the documented thresholds
// (docs/05-security-testing.md "Coverage target"): at least 85 % of lines in auth, jobs, offers and reviews,
// and at least 70 % overall, plus at least 70 % of BRANCHES overall. Run through `npm run test:cov` (unit with coverage, e2e with coverage, then this
// check), or on its own once both reports exist (`npm run test:cov:unit`, `npm run test:cov:e2e`).
// Exits 1 when a threshold is missed, so CI fails.
import fs from 'node:fs';
import path from 'node:path';
import libCoverage from 'istanbul-lib-coverage';

const ROOT = process.cwd();
const REPORTS = [
  'coverage/unit/coverage-final.json',
  'coverage/e2e/coverage-final.json',
];

/** Line thresholds in percent. `overall` covers every counted file. */
export const THRESHOLDS = [
  { name: 'overall', prefix: 'src/', min: 70 },
  { name: 'auth', prefix: 'src/modules/auth/', min: 85 },
  { name: 'jobs', prefix: 'src/modules/jobs/', min: 85 },
  { name: 'offers', prefix: 'src/modules/offers/', min: 85 },
  { name: 'reviews', prefix: 'src/modules/reviews/', min: 85 },
];

/** Branch threshold in percent, over every counted file (added in Phase 7, Milestone A). */
export const BRANCH_THRESHOLDS = [{ name: 'overall', prefix: 'src/', min: 70 }];

const map = libCoverage.createCoverageMap({});
for (const report of REPORTS) {
  const file = path.join(ROOT, report);
  if (!fs.existsSync(file)) {
    console.error(
      `Missing ${report}. Run the unit and e2e suites with coverage first (see this file's header).`,
    );
    process.exit(2);
  }
  map.merge(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const files = map.files().map((absolute) => {
  const summary = map.fileCoverageFor(absolute).toSummary();
  return {
    path: path.relative(ROOT, absolute).split(path.sep).join('/'),
    lines: summary.lines,
    branches: summary.branches,
  };
});

const pct = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);
let failed = false;
console.log('Coverage (unit + e2e merged), lines');
console.log('area       lines covered/total   percent   required');
for (const rule of THRESHOLDS) {
  const inArea = files.filter((f) => f.path.startsWith(rule.prefix));
  const covered = inArea.reduce((n, f) => n + f.lines.covered, 0);
  const total = inArea.reduce((n, f) => n + f.lines.total, 0);
  const value = pct(covered, total);
  const ok = value >= rule.min;
  if (!ok) failed = true;
  console.log(
    `${rule.name.padEnd(10)} ${`${covered}/${total}`.padEnd(21)} ${value.toFixed(1).padStart(6)}%   >= ${rule.min}%  ${ok ? 'ok' : 'BELOW THRESHOLD'}`,
  );
  if (!ok) {
    const worst = inArea
      .filter((f) => f.lines.total > 0)
      .sort((a, b) => a.lines.pct - b.lines.pct)
      .slice(0, 8);
    for (const f of worst)
      console.log(
        `    ${String(f.lines.pct).padStart(5)}%  ${f.lines.covered}/${f.lines.total}  ${f.path}`,
      );
  }
}
console.log('');
console.log('Coverage (unit + e2e merged), branches');
console.log('area       branches covered/total   percent   required');
for (const rule of BRANCH_THRESHOLDS) {
  const inArea = files.filter((f) => f.path.startsWith(rule.prefix));
  const covered = inArea.reduce((n, f) => n + f.branches.covered, 0);
  const total = inArea.reduce((n, f) => n + f.branches.total, 0);
  const value = pct(covered, total);
  const ok = value >= rule.min;
  if (!ok) failed = true;
  console.log(
    `${rule.name.padEnd(10)} ${`${covered}/${total}`.padEnd(24)} ${value.toFixed(1).padStart(6)}%   >= ${rule.min}%  ${ok ? 'ok' : 'BELOW THRESHOLD'}`,
  );
  if (!ok) {
    const worst = inArea
      .filter((f) => f.branches.total > 0)
      .sort((a, b) => a.branches.pct - b.branches.pct)
      .slice(0, 8);
    for (const f of worst)
      console.log(
        `    ${String(f.branches.pct).padStart(5)}%  ${f.branches.covered}/${f.branches.total}  ${f.path}`,
      );
  }
}
process.exit(failed ? 1 : 0);
