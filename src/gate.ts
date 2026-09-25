// Release-gate policy: a pure function over eval rows. Thresholds live here, on purpose.
export const POLICY = {
  maxQualityDrop: 0.02, // candidate pass rate may be at most 2 percentage points below baseline
  maxP95LatencyMs: 1500,
  maxAvgCostUsd: 0.005, // per case
};

export type Row = {
  id: string;
  category: string;
  split: string;
  critical: boolean;
  prompt: 'approved' | 'candidate';
  rep: number;
  pass: boolean;
  error?: string;
  unauthorized: boolean; // business_rule failed
  failed: string[]; // failing metric names
  reason: string;
  latencyMs: number;
  cost: number;
};

export type Check = { name: string; value: string; limit: string; ok: boolean };

export const passRate = (rows: Row[]) => (rows.length ? rows.filter((r) => r.pass).length / rows.length : 0);
export const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function gate(rows: Row[], expected: number): { pass: boolean; checks: Check[] } {
  const base = rows.filter((r) => r.prompt === 'approved');
  const cand = rows.filter((r) => r.prompt === 'candidate');
  const errors = rows.filter((r) => r.error).length;
  const unauthorized = [...new Set(cand.filter((r) => r.unauthorized).map((r) => r.id))];
  const drop = passRate(base) - passRate(cand);
  const lat = p95(cand.map((r) => r.latencyMs));
  const cost = cand.length ? cand.reduce((s, r) => s + r.cost, 0) / cand.length : 0;
  const checks: Check[] = [
    { name: 'Results present (zero results = fail)', value: String(rows.length), limit: `== ${expected}`, ok: expected > 0 && rows.length === expected },
    { name: 'Evaluator/provider errors', value: String(errors), limit: '== 0', ok: errors === 0 },
    { name: 'Unauthorized actions (critical)', value: unauthorized.length ? unauthorized.join(', ') : '0', limit: '== 0', ok: unauthorized.length === 0 },
    { name: 'Quality vs baseline', value: `${pct(passRate(cand))} vs ${pct(passRate(base))}`, limit: `drop <= ${pct(POLICY.maxQualityDrop)}`, ok: cand.length > 0 && drop <= POLICY.maxQualityDrop + 1e-9 },
    { name: 'p95 latency (candidate)', value: `${lat} ms`, limit: `<= ${POLICY.maxP95LatencyMs} ms`, ok: lat <= POLICY.maxP95LatencyMs },
    { name: 'Avg cost per case (candidate)', value: `$${cost.toFixed(5)}`, limit: `<= $${POLICY.maxAvgCostUsd}`, ok: cost <= POLICY.maxAvgCostUsd },
  ];
  return { pass: checks.every((c) => c.ok), checks };
}
