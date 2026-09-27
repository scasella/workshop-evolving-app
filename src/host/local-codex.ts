import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBounded, hash, validateEdits, type AuthorJournal, type FileEdit } from '../authoring.ts';
import profile from '../codex-profile.json' with { type: 'json' };
import { fail, need } from './canonical.ts';
import { applyEdits, authorJournal, authorPrompt, type Target } from './evolve.ts';
import type { ReviewBundle, Reviewer } from './runner.ts';
import type { Host } from './store.ts';

// Owner-authorized live model calls through the installed `codex exec` on this machine.
// The CLI uses its own sign-in (CODEX_HOME=~/.codex). The host reads ~/.codex/auth.json only to check
// that an access token is present; it never copies, logs, stores or transmits it.
// Each call ignores user config and rules, is ephemeral, read-only sandboxed, has every
// optional feature disabled, never asks for approval, and runs in an empty temporary
// directory. Any tool activity in the event stream rejects the call's output.
export const LOCAL_CODEX = '/opt/homebrew/bin/codex';

type Call = { stdout: string; stderr: string; code: number | null; classification: string };
export type CallReceipt = { mode: 'live-local-codex'; model: string; start: string; end: string; seconds: number; binaryHash: string; cliVersion: string;
  inputHash: string; configurationHash: string; exit: number | null; classification: string; usage: unknown; outcome: string; stderrTail: string };

export async function runLocalCodex(opts: { prompt: string; schema: object; model: string; effort?: string; timeoutMs?: number; signal?: AbortSignal }) {
  need(/^[a-zA-Z0-9_.-]{1,100}$/.test(opts.model), 'type_error', 'explicit model required');
  need(hash(readFileSync(LOCAL_CODEX)) === profile.sha256, 'codex_binary', `the installed Codex CLI differs from the inspected ${profile.version} profile`);
  const root = mkdtempSync(join(tmpdir(), 'workshop-codex-'));
  const work = join(root, 'empty'); const schemaPath = join(root, 'output-schema.json');
  writeFileSync(schemaPath, JSON.stringify(opts.schema));
  mkdirSync(work);
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json',
    '--sandbox', 'read-only', '--model', opts.model, '--output-schema', schemaPath,
    ...profile.disabledFeatures.flatMap((f: string) => ['--disable', f]),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'check_for_update_on_startup=false', '-c', `model_reasoning_effort="${opts.effort ?? 'medium'}"`, '-C', work, '-'];
  const env = { PATH: '/usr/bin:/bin', HOME: homedir(), CODEX_HOME: join(homedir(), '.codex'), TMPDIR: root };
  const start = new Date();
  try {
    const result: Call = await executeBounded(LOCAL_CODEX, args, env, opts.prompt, opts.signal, opts.timeoutMs ?? 20 * 60_000, 4 * 1024 * 1024);
    return { result, start, end: new Date(), args };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// The single structured final message, or an error. Tool activity of any kind is refused.
export function finalMessage(result: Call): { text: string; usage: unknown } {
  need(result.classification === 'exited', 'codex_call', `Codex CLI ${result.classification}`);
  const events = result.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { type: 'unparseable' }; } });
  // Messages are built only on failure (an eager template once threw on valid output).
  const failed = events.find(e => e.type === 'turn.failed' || e.type === 'error');
  if (failed) fail('codex_call', `Codex reported failure: ${String(JSON.stringify(failed.error ?? failed.message ?? failed) ?? '').slice(0, 400)}`);
  if (result.code !== 0) fail('codex_call', `Codex exited ${result.code}: ${String(result.stderr ?? '').slice(-400)}`);
  const completed = events.filter(e => e.type === 'item.completed');
  const tool = completed.find(e => !['agent_message', 'reasoning', 'error'].includes(e.item?.type));
  if (tool) fail('codex_tool', `tool activity in the author/reviewer stream is forbidden (${String(tool.item?.type)})`);
  const messages = completed.filter(e => e.item?.type === 'agent_message');
  if (messages.length !== 1) fail('codex_call', `expected one final message, got ${messages.length}`);
  const done = events.find(e => e.type === 'turn.completed');
  if (!done) fail('codex_call', 'missing completed turn');
  return { text: String(messages[0].item.text), usage: done.usage ?? null };
}

function receipt(model: string, prompt: string, run: Awaited<ReturnType<typeof runLocalCodex>>, usage: unknown, outcome: string): CallReceipt {
  return { mode: 'live-local-codex', model, start: run.start.toISOString(), end: run.end.toISOString(), seconds: Math.round((+run.end - +run.start) / 1000),
    binaryHash: profile.sha256, cliVersion: profile.version, inputHash: hash(prompt), configurationHash: hash(JSON.stringify(run.args.filter(a => !a.includes('/')))),
    exit: run.result.code, classification: run.result.classification, usage, outcome, stderrTail: run.result.stderr.slice(-600) };
}

const editSchema = {
  type: 'object', additionalProperties: false, required: ['files'], properties: {
    files: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } } } } }
};

// Live authoring with bounded repair: each attempt is one charged call and one candidate identity.
export async function localAuthorAndPropose(host: Host, opts: { world: string; request: string; proposalId: string; model: string; root: string;
  target?: Target | null; maxAttempts?: number; journal?: AuthorJournal; onAttempt?: (n: number, info: unknown) => void }) {
  const journal = opts.journal ?? authorJournal(host);
  const attempts: { id: string; receipt: CallReceipt | null; outcome: string; reasons: string[] }[] = [];
  let feedback = '';
  for (let n = 1; n <= (opts.maxAttempts ?? 3); n++) {
    const id = `${opts.proposalId}-a${n}`;
    const { prompt: base, parent } = authorPrompt(host, opts.world, opts.request, opts.target ?? null);
    const prompt = base + feedback;
    need(Buffer.byteLength(prompt) <= 96 * 1024, 'author_budget', 'assembled author context exceeds 96 KiB');
    if (!journal.reserve({ operationId: id, rootId: opts.root, prompt, model: opts.model }, () => host.reserveUnit(opts.root, `author ${id}`)))
      throw new Error(`attempt ${id} already exists`);
    let run: Awaited<ReturnType<typeof runLocalCodex>>;
    try { run = await runLocalCodex({ prompt, schema: editSchema, model: opts.model }); }
    catch (e: any) {
      journal.db.prepare("UPDATE author_attempts SET state='uncertain',receipt=? WHERE id=?").run(JSON.stringify({ error: String(e?.message ?? e) }), id);
      attempts.push({ id, receipt: null, outcome: 'uncertain', reasons: [String(e?.message ?? e)] }); break;
    }
    let edits: FileEdit[] | undefined; let usage: unknown = null; let reasons: string[] = [];
    try { const m = finalMessage(run.result); usage = m.usage; edits = validateEdits(m.text); }
    catch (e: any) { reasons = [String(e?.message ?? e)]; }
    const r = receipt(opts.model, prompt, run, usage, edits ? 'edits' : 'rejected-output');
    journal.finish(id, r, edits);
    opts.onAttempt?.(n, { id, seconds: r.seconds, usage, output: edits ? `${edits.length} file edit(s)` : reasons });
    if (!edits) {
      attempts.push({ id, receipt: r, outcome: 'invalid output', reasons });
      feedback = `\n\nYour previous response was rejected before admission: ${reasons.join('; ')}. Return the corrected JSON object.`;
      continue;
    }
    let files: Record<string, string>;
    try { files = applyEdits(host.pkg(parent)!.files, edits, parent); }
    catch (e: any) { reasons = [String(e?.message ?? e)]; attempts.push({ id, receipt: r, outcome: 'invalid edits', reasons }); feedback = `\n\nYour previous edits could not be applied: ${reasons.join('; ')}.`; continue; }
    const proposal = host.propose(id, opts.world, `${opts.request} [authored live by Codex ${opts.model} via local codex exec; attempt ${n}]`, files);
    if (proposal.status === 'previewable') { attempts.push({ id, receipt: r, outcome: 'previewable', reasons: [] }); return { proposalId: id, proposal, attempts, edits }; }
    reasons = proposal.reasons;
    attempts.push({ id, receipt: r, outcome: 'rejected by admission', reasons });
    feedback = `\n\nThe Workshop host rejected your previous package. Fix every problem and return the complete corrected set of changed files (full contents):\n${reasons.map(x => `- ${x}`).join('\n')}\n\nYour previous files were:\n${edits.map(e => `=== ${e.path} ===\n${e.content}`).join('\n')}`;
  }
  return { proposalId: null, proposal: null, attempts, edits: null };
}

const reviewSchema = {
  type: 'object', additionalProperties: false, required: ['verdict', 'note', 'report'],
  properties: { verdict: { type: 'string', enum: ['approve', 'changes_requested'] }, note: { type: 'string' }, report: { type: 'string' } }
};
// A live reviewer for the host runner. The bundle is the obligation's projected subjects only.
export function codexReviewer(model: string, receipts: CallReceipt[] = []): Reviewer {
  return {
    kind: 'codex',
    async review(bundle: ReviewBundle, signal: AbortSignal) {
      const prompt = `You are an independent reviewer inside a local decision workspace. Review only the material below; you have no tools.
Obligation: ${bundle.obligation.title} (${bundle.obligation.id}). Accepting verdicts: ${bundle.obligation.verdicts.join(', ')}.

Review instructions from the application:
${bundle.prompt}

${bundle.decision ? `Decision this review gates: "${bundle.decision.question}" (options: ${bundle.decision.options.join(', ')})\n\n` : ''}Subjects (records under review):
${JSON.stringify(bundle.subjects, null, 2)}

Relations touching them:
${JSON.stringify(bundle.relations, null, 2)}

Records at the other end of those relations (evidence, criteria, assumptions):
${JSON.stringify(bundle.related, null, 2)}

Return JSON: verdict ("approve" or "changes_requested"), note (one or two sentences, max 400 characters), report (markdown, max 3000 characters).`;
      const run = await runLocalCodex({ prompt, schema: reviewSchema, model, timeoutMs: 10 * 60_000, signal });
      let parsed: any; let usage: unknown = null;
      try { const m = finalMessage(run.result); usage = m.usage; parsed = JSON.parse(m.text); }
      finally { receipts.push(receipt(model, prompt, run, usage, parsed ? `verdict ${parsed.verdict}` : 'rejected-output')); }
      need(['approve', 'changes_requested'].includes(parsed.verdict), 'review_output', 'invalid verdict');
      need(typeof parsed.note === 'string' && typeof parsed.report === 'string', 'review_output', 'invalid review');
      return { verdict: parsed.verdict, note: `Codex ${model}: ${parsed.note.slice(0, 400)}`, report: parsed.report.slice(0, 8000) };
    }
  };
}

// What live local calls need, as specific missing conditions.
export function localAuthoringProblems(host: Host, root: string | null): string[] {
  const problems: string[] = [];
  if (!host.authorModel()) problems.push('no model chosen for live authoring (Authoring settings)');
  const a = root ? host.allowance(root) : undefined;
  if (!root || !a) problems.push('no call allowance granted (Authoring settings)');
  else if (a.used >= a.total) problems.push(`allowance ${root} is used up (${a.used}/${a.total})`);
  try { if (hash(readFileSync(LOCAL_CODEX)) !== profile.sha256) problems.push(`the installed Codex CLI differs from the inspected ${profile.version}`); }
  catch { problems.push(`Codex CLI not found at ${LOCAL_CODEX}`); }
  try { const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8')); if (typeof auth?.tokens?.access_token !== 'string') problems.push('Codex is not signed in (run codex login)'); }
  catch { problems.push('Codex is not signed in (run codex login)'); }
  return problems;
}
