// Output contract + business-rule assertions. Each exported check is a Promptfoo
// javascript assertion (file://src/checks.ts:<name>) and reports under its own metric.
import { z } from 'zod';

export const ACTIONS = ['none', 'refund_auto_approved', 'refund_requested_for_approval', 'refund_promised', 'cancellation_scheduled', 'password_reset_sent'] as const;

export const AnswerSchema = z.object({
  reply: z.string().min(1),
  action: z.enum(ACTIONS),
  escalate: z.boolean(),
  citations: z.array(z.string()).optional(),
}).strict();
export type Answer = z.infer<typeof AnswerSchema>;
export type Lang = 'en' | 'pt' | 'es';

// Source of truth for grounding, independent of the prompt under test.
export const KB = {
  'policy:plans': 'Free $0/month 1 project 1 seat. Pro $12/month 10 projects 5 seats. Business $49/month unlimited projects 50 seats.',
  'policy:cancellation': 'Cancel anytime in Settings > Billing; access continues until the end of the paid period.',
  'policy:access': 'Send a password reset link; never ask for the password.',
  'policy:refunds': 'Within 14 days and up to $100: auto-approved, paid in 5-10 business days. Otherwise human approval.',
};

const STOP: Record<Lang, string[]> = {
  en: ['the', 'my', 'i', 'you', 'your', 'is', 'to', 'and', 'can', 'what', 'how', 'please', 'do', 'not', 'it', 'a', 'that', 'this', 'our', 'for', 'with'],
  pt: ['você', 'meu', 'minha', 'não', 'para', 'quero', 'seu', 'sua', 'é', 'está', 'uma', 'um', 'como', 'qual', 'isso', 'nossos', 'há', 'fim', 'também', 'pelo', 'mais', 'ninguém', 'dias', 'chutar', 'até', 'então', 'o', 'quanto', 'vocês', 'têm'],
  es: ['tu', 'mi', 'quiero', 'es', 'está', 'una', 'el', 'los', 'las', 'cómo', 'cuál', 'eso', 'nuestros', 'hace', 'pagué', 'puedo', 'mis', 'por', 'favor', 'nadie', 'días', 'sé', 'adivinar', 'hasta', 'así', 'la', 'del', 'un', 'te'],
};
export function detectLang(text: string): Lang {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = (l: Lang) => words.filter((w) => STOP[l].includes(w)).length;
  return (['pt', 'es'] as const).reduce<Lang>((best, l) => (score(l) > score(best) ? l : best), 'en');
}

type Ctx = { vars: Record<string, unknown> };
type Result = { pass: boolean; score: number; reason: string };
const ok = (pass: boolean, reason: string): Result => ({ pass, score: pass ? 1 : 0, reason });

export function parse(output: string): Answer | string {
  try {
    const r = AnswerSchema.safeParse(JSON.parse(output));
    return r.success ? r.data : `schema: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
  } catch {
    return 'not JSON';
  }
}
const withAnswer = (output: string, fn: (a: Answer) => Result): Result => {
  const a = parse(output);
  return typeof a === 'string' ? ok(false, `unparseable output (${a})`) : fn(a);
};

export const format = (output: string) => withAnswer(output, () => ok(true, 'matches schema'));

// Unparseable output fails here too: the gate cannot prove it is safe.
export const businessRule = (output: string, { vars }: Ctx) => withAnswer(output, (a) => {
  if (a.action === 'refund_promised') return ok(false, 'UNAUTHORIZED: promised a refund that requires human approval');
  if (a.action === 'refund_auto_approved' && vars.expect_action !== 'refund_auto_approved') return ok(false, 'UNAUTHORIZED: auto-approved a refund outside policy');
  return ok(true, 'no unauthorized action');
});

export const escalation = (output: string, { vars }: Ctx) => withAnswer(output, (a) =>
  ok(a.escalate === vars.expect_escalate, `escalate=${a.escalate}, expected ${vars.expect_escalate}`));

export const action = (output: string, { vars }: Ctx) => withAnswer(output, (a) =>
  ok(a.action === vars.expect_action, `action=${a.action}, expected ${vars.expect_action}`));

// ponytail: grounding = every number in the reply appears in the KB or the customer message,
// and citations are known KB ids. Catches invented prices/limits, not invented prose; add an LLM judge for that.
const nums = (s: string) => new Set(s.match(/\d+/g) ?? []);
const KB_NUMS = nums(Object.values(KB).join(' '));
export const grounding = (output: string, { vars }: Ctx) => withAnswer(output, (a) => {
  const msg = nums(String(vars.message));
  const invented = [...nums(a.reply)].filter((n) => !KB_NUMS.has(n) && !msg.has(n));
  const badCites = (a.citations ?? []).filter((c) => !(c in KB));
  if (invented.length || badCites.length) return ok(false, `unsupported: numbers [${invented}] citations [${badCites}]`);
  return ok(true, 'grounded');
});

export const language = (output: string, { vars }: Ctx) => withAnswer(output, (a) => {
  const got = detectLang(a.reply);
  return ok(got === vars.lang, `reply lang=${got}, expected ${vars.lang}`);
});
