import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createExport, verifyExport } from '../src/host/export.ts';
import { authorJournal } from '../src/host/evolve.ts';
import { codexReviewer, localAuthorAndPropose, type CallReceipt } from '../src/host/local-codex.ts';
import { readPackageDir } from '../src/host/package-dir.ts';
import { recoveryReport } from '../src/host/recovery.ts';
import { runQueued } from '../src/host/runner.ts';
import { Host } from '../src/host/store.ts';

// P29, LIVE: the demonstration story (docs/DESIGN.md) with real Codex calls through the local `codex exec`
// (owner-authorized). Authored packages are whatever the model returns; nothing is
// substituted. Every call is charged to one finite allowance and receipted.
// PAID: makes real Codex calls billed to the signed-in account. Requires an explicit opt-in.
if (process.env.WORKSHOP_ALLOW_PAID_CALLS !== '1') {
  console.error('This script makes live, paid Codex calls (up to WORKSHOP_CALL_CAP, default 10). Re-run with WORKSHOP_ALLOW_PAID_CALLS=1 to proceed.');
  process.exit(2);
}
const MODEL = process.env.WORKSHOP_MODEL ?? 'gpt-6-astra';
const CAP = Number(process.env.WORKSHOP_CALL_CAP ?? 10);
const root = resolve(new URL('..', import.meta.url).pathname);
// Never overwrite an existing live project: it holds real authored packages and paid-for reviews.
const dir = process.env.WORKSHOP_LIVE_DIR ?? join(root, '.workshop', 'live-host');
if (existsSync(dir)) { console.error(`${dir} already exists (a previous live project). Set WORKSHOP_LIVE_DIR to a new directory.`); process.exit(2); }
const out = join(root, 'evidence', 'live');
mkdirSync(out, { recursive: true });
const log: { at: string; step: string; data?: unknown }[] = [];
const receipts: CallReceipt[] = [];
const save = (status: string, extra: Record<string, unknown> = {}) => writeFileSync(join(root, 'evidence', 'live-demo.json'), JSON.stringify({
  kind: 'LIVE demonstration: real Codex calls via local codex exec (owner-authorized); authored packages are model output', model: MODEL, status,
  allowance: host.allowance('live-demo'), hostDir: dir.replace(root, '<workspace>'), steps: log, reviewReceipts: receipts,
  authorAttempts: authorJournal(host).db.prepare('SELECT id,state,receipt,candidate_hash FROM author_attempts ORDER BY rowid').all().map((r: any) => ({ ...r, receipt: r.receipt ? JSON.parse(r.receipt) : null })), ...extra }, null, 2) + '\n');
const step = (s: string, data?: unknown) => { log.push({ at: new Date().toISOString(), step: s, data }); console.log(`• ${s}${data ? ' ' + JSON.stringify(data).slice(0, 300) : ''}`); save('running'); };
const stop = (why: string, extra: Record<string, unknown> = {}) => { step(`STOPPED: ${why}`, extra); save('stopped', { reason: why }); process.exit(1); };

let host = new Host(dir);
let n = 0;
const act = (actionId: string, input: Record<string, any>, packageHash?: string, world = 'project') => {
  const w = host.world(world);
  return host.run({ operationId: `live-${++n}`, worldId: world, expectedRevision: w.revision, packageHash: packageHash ?? w.packageHash, capabilityRef: `cap-owner-project`, actionId, input });
};
const must = (actionId: string, input: Record<string, any>, packageHash?: string, world?: string) => {
  const o = act(actionId, input, packageHash, world);
  if (o.status !== 'committed') stop(`${actionId} rejected`, { input, reasons: o.reasons });
  return o;
};
const requireInterface = (pkgHash: string, spec: Record<string, string[]>) => {
  const pkg = host.pkg(pkgHash)!;
  const missing = Object.entries(spec).flatMap(([a, inputs]) => !pkg.actions.has(a) ? [`action ${a}`] : inputs.filter(i => !(i in pkg.actions.get(a)!.inputs)).map(i => `${a}.${i}`));
  if (missing.length) stop('the authored package lacks the requested interface', { missing });
};
const savePackage = (name: string, hash: string) => { const d = join(out, name); rmSync(d, { recursive: true, force: true });
  for (const [p, c] of Object.entries(host.pkg(hash)!.files)) { mkdirSync(join(d, p.split('/').slice(0, -1).join('/')), { recursive: true }); writeFileSync(join(d, p), c); } };
// Owner reviews go through whatever continuation the obligation is bound to now (pinned or adapted).
const continueOb = (id: string, verdict: string, note: string) => {
  const o = host.ledger().find(x => x.id === id)!;
  return must(o.continuation.action, host.continuationInput(o, verdict, note, null), o.continuation.packageHash);
};
const closeOwnerReviews = (note: string) => {
  for (const o of host.pendingWork().filter(o => o.world === 'project' && o.policy.discharge === 'owner'))
    must(o.continuation.action, host.continuationInput(o, 'approve', note, null), o.continuation.packageHash);
};

// ---- P0: notebook, explicit review, one bounded live review job, restart ----
host.grantAllowance('live-demo', CAP);
const p0 = host.createProject('project', readPackageDir(join(root, 'packages', 'p0-notebook')));
must('add_note', { id: 'n1', title: 'Pick a storage engine for the ingest service', body: 'Throughput matters; ops headcount is small. Needs an independent review before we commit.' });
must('add_alternative', { id: 'sqlite', title: 'SQLite', summary: 'Embedded, zero-ops, single writer' });
must('add_alternative', { id: 'postgres', title: 'Postgres', summary: 'Server, replication, needs an operator' });
must('start_decision', { id: 'd1', question: 'Which storage engine should the ingest service use?' });
must('request_review', { key: 'r17', decision: 'd1' });
must('request_ai_review', { key: 'ai-early', decision: 'd1' });
const early = await runQueued(host, codexReviewer(MODEL, receipts), { root: 'live-demo' });
step('P0: live Codex review job (bounded, charged)', early);
host.close(); host = new Host(dir);
step('Host restarted; committed review not rerun', { rerun: (await runQueued(host, codexReviewer(MODEL, receipts), { root: 'live-demo' })).results.length, pending: host.pendingWork().map(o => o.id) });

// ---- P1 authored live through Change this ----
const P1_REQUEST = `Turn this project into a comparison workspace. Let me compare candidates against explicit criteria, attach evidence, record a decision, and keep every unresolved review requirement.
Interface I will use (keep these exact action names and input names):
- add_criterion: inputs id (string), title (string), weight (int, 1..5). Creates a criterion record.
- score: inputs alternative (string), criterion (string), score (int, 0..10). Records the score as a relation from the alternative to the criterion (re-scoring replaces it).
- attach_evidence: inputs id (string), alternative (string), title (string), kind (enum: measurement, citation, observation), stance (enum: for, against). Creates an evidence record and relates it to the alternative.
- request_comparison_review: inputs key (string), decision (string). Only when every alternative is scored on every criterion and has at least one piece of evidence: opens an owner-discharged review obligation (verdict approve) gated on that decision, over the alternatives and their evidence, whose continuation is record_review.
- A matrix view with id "comparison" (alternatives × criteria showing scores), plus a view listing evidence.
- A planner rule that suggests request_comparison_review once evidence covers every alternative.
Keep every existing action working, especially record_review. Existing alternatives must keep their data.`;
const p1 = await localAuthorAndPropose(host, { world: 'project', request: P1_REQUEST, proposalId: 'p1', model: MODEL, root: 'live-demo',
  onAttempt: (k, info) => step(`P1 author attempt ${k}`, info) });
step('P1 authoring finished', p1.attempts.map(a => ({ id: a.id, outcome: a.outcome, reasons: a.reasons.slice(0, 6) })));
if (!p1.proposal || p1.proposal.status !== 'previewable') stop('Codex did not produce an admissible P1 within the attempt bound');
const p1Id = p1.proposalId!;
const p1Pkg = host.proposal(p1Id).packageHash!;
savePackage('p1-authored', p1Pkg);
requireInterface(p1Pkg, { add_criterion: ['id', 'title', 'weight'], score: ['alternative', 'criterion', 'score'], attach_evidence: ['id', 'alternative', 'title', 'kind', 'stance'], request_comparison_review: ['key', 'decision'], record_review: ['obligation', 'verdict', 'note'] });

// Deliberate fault (demo-injected, not model-authored): the same package retiring the package r17 continues through.
const faultyFiles = { ...host.pkg(p1Pkg)!.files };
faultyFiles['package.json'] = JSON.stringify({ ...JSON.parse(faultyFiles['package.json']), retire: [p0] }, null, 2);
const faulty = host.propose('p1-faulty', 'project', 'Demo-injected fault: live P1 plus retiring the P0 package', faultyFiles);
assert.equal(faulty.status, 'rejected');
step('Deliberately faulty variant (demo-injected retire) rejected', faulty.status === 'rejected' ? faulty.reasons : null);

const prev = (p1.proposal as any).preview; const practice = (p1.proposal as any).practiceWorld;
const pr = act('add_criterion', { id: 'practice-only', title: 'Practice criterion', weight: 1 }, undefined, practice);
host.approve(p1Id, { previewHash: prev.previewHash, candidateHash: prev.candidateHash });
const a1 = host.activate(p1Id);
if (a1.status !== 'committed') stop('P1 activation rejected', a1);
continueOb('ob-r17', 'changes_requested', 'Need measured results first');
step('P1 applied after practice; r17 continued through its pinned P0 route', { practiceAction: pr.status, practiceLeak: host.state('project').records.has('practice-only'),
  supplementalTests: (p1.proposal as any).report.supplementalTests, views: host.project('project').views.map(v => v.id), r17: host.ledger().find(o => o.id === 'ob-r17')!.status });

must('add_criterion', { id: 'ops', title: 'Operational cost', weight: 3 });
must('add_criterion', { id: 'throughput', title: 'Write throughput', weight: 2 });
for (const [a, c, s] of [['sqlite', 'ops', 9], ['sqlite', 'throughput', 5], ['postgres', 'ops', 5], ['postgres', 'throughput', 8]] as const) must('score', { alternative: a, criterion: c, score: s });
must('attach_evidence', { id: 'ev1', alternative: 'sqlite', title: 'Ingest load test: 40k rows/s on one node', kind: 'measurement', stance: 'for' });
must('attach_evidence', { id: 'ev2', alternative: 'postgres', title: 'Vendor replication claims', kind: 'citation', stance: 'for' });
const cmp = act('request_comparison_review', { key: 'cmp', decision: 'd1' });
step('P1 domain work through the authored actions', { requestComparisonReview: cmp, planner: host.project('project').planner, pending: host.pendingWork().map(o => o.id) });

// ---- P2 authored live from within P1 ----
const P2_REQUEST = `Add a third option. Separate measured results from assumptions, and run the independent reviews in parallel without letting me finalize before both are complete.
Interface I will use (keep these exact names):
- attach_evidence gains an input basis (enum: measured, assumed; default assumed) stored on the evidence. Existing evidence must be migrated: kind measurement → measured, anything else → assumed (backfill a newly added field).
- add_assumption: inputs id (string), alternative (string), statement (string), confidence (int, 1..5). Records an assumption related to the alternative.
- request_parallel_reviews: inputs key (string), decision (string). First redraft the decision (same id and question) so its subjects are all current alternatives; then open two independent, job-discharged review obligations with keys "<key>-method" and "<key>-risk", gated on the decision, verdict approve, continuation record_review, each followed by a review task (prompts review_methodology and review_risk, which you must add). Require every alternative to have at least one measured result.
- Views that show measured results separately from assumptions and unmeasured evidence.
- Planner rules: suggest adding another option while there are fewer than three alternatives; suggest request_parallel_reviews once measured results cover every alternative and nothing is open.
Keep all existing actions and their inputs working.`;
const p2 = await localAuthorAndPropose(host, { world: 'project', request: P2_REQUEST, proposalId: 'p2', model: MODEL, root: 'live-demo',
  onAttempt: (k, info) => step(`P2 author attempt ${k}`, info) });
step('P2 authoring finished', p2.attempts.map(a => ({ id: a.id, outcome: a.outcome, reasons: a.reasons.slice(0, 6) })));
if (!p2.proposal || p2.proposal.status !== 'previewable') stop('Codex did not produce an admissible P2 within the attempt bound');
const p2Pkg = host.proposal(p2.proposalId!).packageHash!;
savePackage('p2-authored', p2Pkg);
requireInterface(p2Pkg, { attach_evidence: ['basis'], add_assumption: ['id', 'alternative', 'statement', 'confidence'], request_parallel_reviews: ['key', 'decision'], add_alternative: ['id', 'title'] });
const p2prev = (p2.proposal as any).preview;
host.approve(p2.proposalId!, { previewHash: p2prev.previewHash, candidateHash: p2prev.candidateHash });
continueOb('ob-r17', 'approve', 'The load test is convincing');
const stale = host.activate(p2.proposalId!);
if (stale.status !== 'rejected') stop('expected a stale activation after the live review change', stale);
const fresh = host.refresh(p2.proposalId!, 'p2-refresh');
if (fresh.status !== 'previewable') stop('refreshed P2 preview rejected', fresh);
host.approve('p2-refresh', { previewHash: (fresh as any).preview.previewHash, candidateHash: (fresh as any).preview.candidateHash });
const a2 = host.activate('p2-refresh');
if (a2.status !== 'committed') stop('P2 activation rejected', a2);
const ev = host.state('project').records;
step('P2 applied: live review change during preview → stale → refreshed → applied', { stale: (stale as any).reasons, basis: { ev1: ev.get('ev1')?.data.basis, ev2: ev.get('ev2')?.data.basis } });

must('add_alternative', { id: 'duckdb', title: 'DuckDB', summary: 'Embedded columnar engine' });
for (const [a, c, s] of [['duckdb', 'ops', 8], ['duckdb', 'throughput', 7]] as const) must('score', { alternative: a, criterion: c, score: s });
must('attach_evidence', { id: 'ev3', alternative: 'postgres', title: 'Replica benchmark: 25k rows/s with sync replication', kind: 'measurement', stance: 'against', basis: 'measured' });
must('attach_evidence', { id: 'ev4', alternative: 'duckdb', title: 'Columnar ingest test: 55k rows/s', kind: 'measurement', stance: 'for', basis: 'measured' });
must('add_assumption', { id: 'as1', alternative: 'postgres', statement: 'The ops team can run streaming replication', confidence: 2 });
closeOwnerReviews('Owner re-review after the evidence update');
must('request_parallel_reviews', { key: 'final', decision: 'd1' });
const blocked = host.finalize('fin-early', 'project', host.world('project').revision, 'd1', 'sqlite');
if (blocked.status !== 'rejected') stop('finalize should be blocked while the parallel reviews are open');
const reviews = await runQueued(host, codexReviewer(MODEL, receipts), { root: 'live-demo', concurrency: 2 });
step('Two independent live Codex reviews in parallel', { peakConcurrency: reviews.peakConcurrency, results: reviews.results,
  verdicts: host.ledger().filter(o => o.id.startsWith('ob-final')).map(o => ({ id: o.id, status: o.status, fulfillment: o.fulfillment?.note })) });
const open = host.pendingWork().filter(o => o.world === 'project');
if (open.some(o => o.policy.discharge === 'job')) {
  step('A live reviewer requested changes or failed; the decision stays blocked (reported as-is, not overridden)', open.map(o => ({ id: o.id, status: o.status })));
} else {
  closeOwnerReviews('Owner confirmation after independent reviews');
  const state = host.state('project');
  const weights = new Map([...state.records.values()].filter(r => r.type === 'criterion').map(r => [r.id, Number(r.data.weight ?? 1)]));
  const totals = (state.decisions.get('d1')!.subjects).map(id => [id, [...state.relations.values()].filter(r => r.from === id && weights.has(r.to))
    .reduce((t, r) => t + Number(Object.values(r.data).find(v => typeof v === 'number') ?? 0) * weights.get(r.to)!, 0)] as const).sort((a, b) => b[1] - a[1]);
  const final = host.finalize('fin', 'project', host.world('project').revision, 'd1', totals[0][0]);
  step('Decision finalized after both reviews', { blockedFirst: (blocked as any).reasons, totals, final, decision: host.state('project').decisions.get('d1') });
}

// ---- Break, recover, repair, export ----
const active = host.world('project').packageHash;
const good = { ...host.pkg(active)!.files };
host.db.prepare("UPDATE packages SET files=replace(files, 'attach_evidence', 'attach_evidencX') WHERE hash=?").run(active);
host.close(); host = new Host(dir);
const broken = { available: !!host.pkg(active), broken: recoveryReport(host).broken, pending: recoveryReport(host).pending.map(p => p.id) };
host.repairPackage(good);
const bundle = join(dir, '..', 'live-export'); rmSync(bundle, { recursive: true, force: true });
const manifest = await createExport(host, bundle);
step('Broken package → recovery listed it → repaired from hash-verified source → exported and verified', { broken, repaired: !!host.pkg(active), verify: verifyExport(bundle), closure: manifest.closure });
save('completed');
console.log(`Live demonstration completed. Allowance used: ${JSON.stringify(host.allowance('live-demo'))}. Evidence: evidence/live-demo.json`);
