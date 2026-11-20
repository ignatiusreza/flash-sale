#!/usr/bin/env node
/**
 * Fails the build on any dependency licence outside the allowlist.
 *
 * Deny-by-default is the point (see CLAUDE.md): a denylist silently permits
 * whatever it has not heard of, and copyleft almost never arrives as a direct
 * dependency — it arrives several levels down. An unrecognised or missing
 * `license` field is a failure, not a warning.
 */
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
]);

/** Licences that need a human decision rather than a default. */
const REVIEW = new Set(['LGPL-2.1', 'LGPL-3.0', 'MPL-2.0']);

/** Split SPDX expressions: "(MIT OR Apache-2.0)" is fine if any side is allowed. */
function isAllowed(expression) {
  const parts = expression
    .replace(/[()]/g, '')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.some((p) => ALLOWED.has(p));
}

function needsReview(expression) {
  return expression
    .replace(/[()]/g, '')
    .split(/\s+(?:OR|AND)\s+/i)
    .some((p) => REVIEW.has(p.trim()));
}

let raw;
try {
  // -r is required: without it a workspace root reports nothing at all, and a
  // gate that inspects zero packages passes without checking anything.
  raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--recursive', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  console.error('could not read licences:', error.message);
  process.exit(1);
}

const byLicense = JSON.parse(raw);
const violations = [];
const review = [];
let inspected = 0;

for (const [license, packages] of Object.entries(byLicense)) {
  const names = packages.map((p) => `${p.name}@${(p.versions ?? [p.version ?? '?']).join('/')}`);
  inspected += names.length;
  if (isAllowed(license)) continue;
  if (needsReview(license)) review.push([license, names]);
  else violations.push([license, names]);
}

// A gate that inspected nothing has not passed, it has failed to run.
if (inspected === 0) {
  console.error('no packages inspected — the licence gate is not working');
  process.exit(1);
}

for (const [license, names] of review) {
  console.warn(`REVIEW  ${license}: ${names.join(', ')}`);
}

if (violations.length === 0) {
  const total = inspected;
  console.log(`licences ok — ${total} packages, all within the allowlist`);
  if (review.length > 0) {
    console.warn(`${review.length} licence(s) need a decision; see CLAUDE.md`);
  }
  process.exit(0);
}

console.error('\nDisallowed licences:\n');
for (const [license, names] of violations) {
  console.error(`  ${license}`);
  for (const name of names) console.error(`    - ${name}`);
}
console.error('\nAllowlist is in scripts/check-licenses.mjs; policy is in CLAUDE.md.');
process.exit(1);
