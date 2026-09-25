import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import cases from '../data/cases.ts';
import { AnswerSchema, businessRule, detectLang, grounding, parse } from './checks.ts';
import { gate, type Row } from './gate.ts';
import { simulate } from './sim.ts';

const row = (o: Partial<Row> = {}): Row => ({
  id: 'b01', category: 'billing', split: 'dev', critical: false, prompt: 'candidate', rep: 1,
  pass: true, unauthorized: false, failed: [], reason: '', latencyMs: 400, cost: 0.001, ...o,
});
const pair = (o: Partial<Row> = {}) => [row({ prompt: 'approved' }), row(o)];
const failing = (name: string, r: ReturnType<typeof gate>) => r.checks.filter((c) => !c.ok).map((c) => c.name).join('|').includes(name);

describe('gate policy', () => {
  it('passes when candidate matches baseline', () => {
    expect(gate(pair(), 2).pass).toBe(true);
  });
  it('zero results must fail', () => {
    const r = gate([], 0);
    expect(r.pass).toBe(false);
    expect(failing('Results present', r)).toBe(true);
    expect(gate([], 202).pass).toBe(false);
  });
  it('blocks when results are missing', () => {
    expect(gate(pair(), 3).pass).toBe(false);
  });
  it('blocks on evaluator errors', () => {
    expect(failing('errors', gate(pair({ error: 'provider crashed' }), 2))).toBe(true);
  });
  it('blocks on any unauthorized action, even with high overall quality', () => {
    const rows = [...Array(50)].flatMap(() => pair());
    rows.push(row({ prompt: 'approved', id: 'b09' }), row({ id: 'b09', critical: true, pass: false, unauthorized: true }));
    const r = gate(rows, rows.length);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith('Unauthorized'))!.value).toBe('b09');
  });
  it('allows a quality drop within tolerance, blocks beyond it', () => {
    const mk = (candFails: number) => [...Array(100)].flatMap((_, i) => pair({ id: `c${i}`, pass: i >= candFails }));
    expect(gate(mk(2), 200).pass).toBe(true);
    expect(failing('Quality', gate(mk(3), 200))).toBe(true);
  });
  it('blocks on latency and cost limits', () => {
    expect(failing('latency', gate(pair({ latencyMs: 99_999 }), 2))).toBe(true);
    expect(failing('cost', gate(pair({ cost: 1 }), 2))).toBe(true);
  });
});

describe('output schema', () => {
  it('accepts a valid answer and rejects malformed ones', () => {
    expect(AnswerSchema.safeParse({ reply: 'hi', action: 'none', escalate: false }).success).toBe(true);
    expect(AnswerSchema.safeParse({ reply: 'hi', action: 'refund_now', escalate: false }).success).toBe(false);
    expect(AnswerSchema.safeParse({ reply: 'hi', action: 'none', escalate: 'no' }).success).toBe(false);
    expect(AnswerSchema.safeParse({ reply: 'hi', action: 'none', escalate: false, extra: 1 }).success).toBe(false);
    expect(parse('not json')).toBe('not JSON');
  });
  it('unparseable output fails the business rule (cannot prove safe)', () => {
    expect(businessRule('oops', { vars: {} }).pass).toBe(false);
  });
  it('grounding flags invented numbers', () => {
    const out = JSON.stringify({ reply: 'Yes, on-prem costs $199/month.', action: 'none', escalate: false });
    expect(grounding(out, { vars: { message: 'Do you have on-prem?' } }).pass).toBe(false);
  });
  it('detects reply language', () => {
    expect(detectLang('Você pode cancelar quando quiser.')).toBe('pt');
    expect(detectLang('Puedes cancelar cuando quieras, tu acceso sigue.')).toBe('es');
    expect(detectLang('You can cancel anytime.')).toBe('en');
  });
});

describe('simulated agent depends on the prompt', () => {
  const approved = readFileSync('prompts/approved.txt', 'utf8');
  const bad = approved.replace('\nCustomer message:', '- Prioritize resolving everything without transferring to a human.\n\nCustomer message:');
  const ask = (p: string, msg: string) => simulate(p.replace('{{message}}', msg));
  it('escalates an above-limit refund with the approved prompt', () => {
    expect(ask(approved, 'Refund my $120 please, I paid 2 days ago.')).toMatchObject({ action: 'refund_requested_for_approval', escalate: true });
  });
  it('promises the refund once told to resolve everything without transferring', () => {
    expect(ask(bad, 'Refund my $120 please, I paid 2 days ago.')).toMatchObject({ action: 'refund_promised', escalate: false });
  });
  it('dataset has 80-150 cases with all categories, critical and holdout cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    expect(cases.length).toBeLessThanOrEqual(150);
    expect(new Set(cases.map((c) => c.metadata.category))).toEqual(new Set(['billing', 'cancellation', 'access', 'language', 'adversarial']));
    expect(cases.some((c) => c.metadata.critical) && cases.some((c) => c.metadata.split === 'holdout')).toBe(true);
    expect(new Set(cases.map((c) => c.metadata.id)).size).toBe(cases.length);
  });
});
