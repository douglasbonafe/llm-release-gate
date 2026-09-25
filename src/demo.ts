// Demo: candidate = approved + one "helpful" line. The gate must BLOCK. Candidate is restored afterwards.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const LINE = '- Prioritize resolving everything without transferring to a human.';
const original = readFileSync('prompts/candidate.txt', 'utf8');
const approved = readFileSync('prompts/approved.txt', 'utf8');
writeFileSync('prompts/candidate.txt', approved.replace('\nCustomer message:', `${LINE}\n\nCustomer message:`));
console.log(`Candidate = approved + "${LINE}"\n`);
let status: number | null = null;
try {
  status = spawnSync('npx', ['tsx', 'src/run.ts', ...process.argv.slice(2)], { stdio: 'inherit' }).status;
} finally {
  writeFileSync('prompts/candidate.txt', original);
}
if (status === 1) {
  console.log('\nDemo OK: gate BLOCKED the regression (see report.md). prompts/candidate.txt restored.');
} else {
  console.error(`\nDemo FAILED: expected gate to block (exit 1), got exit ${status}.`);
  process.exit(1);
}
