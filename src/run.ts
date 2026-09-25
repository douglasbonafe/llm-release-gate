// Runs the Promptfoo eval (approved vs candidate), applies the gate, writes report.md.
// Usage: tsx src/run.ts [--repeat N] [--real]   Exit code 1 = BLOCK.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import cases from '../data/cases.ts';
import { gate, passRate, type Row } from './gate.ts';

const argv = process.argv.slice(2);
const repeat = Number(argv[argv.indexOf('--repeat') + 1] || 0) || 3;
const real = argv.includes('--real');
const OUT = 'out/results.json';
const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

mkdirSync('out', { recursive: true });
rmSync(OUT, { force: true }); // a stale file must never count as results
const provider = real ? ['-r', 'anthropic:messages:claude-sonnet-5'] : [];
const t0 = Date.now();
spawnSync('npx', ['promptfoo', 'eval', '-c', 'promptfooconfig.yaml', '--repeat', String(repeat), '-o', OUT,
  '--no-cache', '--no-write', '--no-table', '--no-progress-bar', ...provider],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' } });
const evalSeconds = ((Date.now() - t0) / 1000).toFixed(1);

// Promptfoo exits non-zero when assertions fail; that's expected. Missing/garbled output -> zero results -> BLOCK.
let raw: any[] = [];
try {
  raw = JSON.parse(readFileSync(OUT, 'utf8')).results.results;
} catch (e) {
  console.error(`could not read ${OUT}: ${(e as Error).message}`);
}

const seen = new Map<string, number>();
const rows: Row[] = raw.map((r) => {
  const md = r.testCase?.metadata ?? {};
  const prompt = String(r.prompt?.label).startsWith('approved') ? 'approved' : 'candidate';
  const k = `${prompt}:${md.id}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
  const comps: any[] = r.gradingResult?.componentResults ?? [];
  const failed = comps.filter((c) => !c.pass).map((c) => c.assertion?.metric ?? 'assert');
  return {
    id: md.id, category: md.category, split: md.split, critical: !!md.critical, prompt, rep: seen.get(k)!,
    pass: !!r.success, error: r.failureReason === 2 ? String(r.error ?? 'provider error') : undefined, // 2 = ResultFailureReason.ERROR
    unauthorized: failed.includes('business_rule'), failed,
    reason: comps.filter((c) => !c.pass).map((c) => c.reason).join('; ') || r.error || '',
    latencyMs: r.response?.metadata?.simulatedLatencyMs ?? r.latencyMs ?? 0,
    cost: r.cost ?? 0,
  };
});

const expected = cases.length * 2 * repeat;
const { pass, checks } = gate(rows, expected);

// ---- comparison ----
const by = (p: string, f: (r: Row) => boolean = () => true) => rows.filter((r) => r.prompt === p && f(r));
const cats = [...new Set(cases.map((c) => c.metadata.category))];
const caseRate = (p: string, id: string) => passRate(by(p, (r) => r.id === id));
const changed = cases.map((c) => c.metadata).map((m) => ({ ...m, b: caseRate('approved', m.id), c: caseRate('candidate', m.id) }));
const regressed = changed.filter((x) => x.c < x.b).sort((a, b) => Number(b.critical) - Number(a.critical));
const improved = changed.filter((x) => x.c > x.b);
const repRates = (p: string) => Array.from({ length: repeat }, (_, i) => passRate(by(p, (r) => r.rep === i + 1)));
const std = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };
const flaky = (p: string) => changed.filter((m) => { const r = caseRate(p, m.id); return r > 0 && r < 1; }).length;
const firstFail = (id: string) => by('candidate', (r) => r.id === id && !r.pass)[0];

const noise = Number(process.env.SIM_NOISE ?? 0);
const promptfooVersion = JSON.parse(readFileSync('node_modules/promptfoo/package.json', 'utf8')).version;
const lines = [
  `## LLM Release Gate: ${pass ? 'PASS ✅' : 'BLOCK ❌'}`,
  '',
  real ? '> Model: `anthropic:messages:claude-sonnet-5` (real API).' : `> **Model: SIMULATED support agent** (\`src/sim.ts\`, deterministic rule engine driven by the prompt text${noise ? `, seeded noise ${noise}` : ''}). Latency, tokens and cost are simulated values, not measurements.`,
  '',
  '### Gate criteria',
  '| Check | Value | Limit | Result |', '|---|---|---|---|',
  ...checks.map((c) => `| ${c.name} | ${c.value} | ${c.limit} | ${c.ok ? '✅' : '❌ BLOCK'} |`),
  '',
  '### Pass rate by category (approved → candidate)',
  '| Category | Cases | Approved | Candidate | Δ |', '|---|---|---|---|---|',
  ...[...cats, 'split:dev', 'split:holdout', 'ALL'].map((cat) => {
    const f = (r: Row) => cat === 'ALL' || r.category === cat || `split:${r.split}` === cat;
    const b = passRate(by('approved', f)), c = passRate(by('candidate', f));
    const n = by('approved', f).length / repeat;
    return `| ${cat} | ${n} | ${pct(b)} | ${pct(c)} | ${c === b ? '0' : `${c > b ? '+' : ''}${((c - b) * 100).toFixed(1)}pp`} |`;
  }),
  '',
  `### Regressed cases (${regressed.length})`,
  ...(regressed.length ? ['| Case | Category | Critical | Split | Pass (approved → candidate) | Failed checks | Reason |', '|---|---|---|---|---|---|---|',
    ...regressed.map((x) => { const f = firstFail(x.id); return `| ${x.id} | ${x.category} | ${x.critical ? '**yes**' : 'no'} | ${x.split} | ${pct(x.b)} → ${pct(x.c)} | ${f?.failed.join(', ')} | ${f?.reason.replace(/\|/g, '/')} |`; })] : ['None.']),
  '',
  `### Improved cases (${improved.length})`,
  improved.length ? improved.map((x) => `- ${x.id} (${x.category}): ${pct(x.b)} → ${pct(x.c)}`).join('\n') : 'None.',
  '',
  `### Repetitions (--repeat ${repeat})`,
  '| Prompt | Pass rate per repetition | Mean | Std dev | Flaky cases |', '|---|---|---|---|---|',
  ...(['approved', 'candidate'] as const).map((p) => { const rr = repRates(p); return `| ${p} | ${rr.map(pct).join(' / ')} | ${pct(passRate(by(p)))} | ${(std(rr) * 100).toFixed(2)}pp | ${flaky(p)} |`; }),
  '',
  '### Versioned baseline',
  '| Artifact | Version |', '|---|---|',
  `| prompts/approved.txt | sha256:${hash('prompts/approved.txt')} |`,
  `| prompts/candidate.txt | sha256:${hash('prompts/candidate.txt')} |`,
  `| data/cases.ts (${cases.length} cases, ${cases.filter((c) => c.metadata.split === 'holdout').length} holdout, ${cases.filter((c) => c.metadata.critical).length} critical) | sha256:${hash('data/cases.ts')} |`,
  `| evaluator (src/checks.ts + src/gate.ts) | sha256:${createHash('sha256').update(readFileSync('src/checks.ts')).update(readFileSync('src/gate.ts')).digest('hex').slice(0, 12)} |`,
  `| promptfoo | ${promptfooVersion} |`,
  `| results | ${rows.length}/${expected} in ${evalSeconds}s wall clock |`,
];
writeFileSync('report.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(pass ? 0 : 1);
