import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { POLICY_ID, Host } from '../src/host/store.ts';
import { readPackageDir, withManifest } from '../src/host/package-dir.ts';
import { runQueued, simulatedReviewer } from '../src/host/runner.ts';
import { Fixture, P2_DIR, tempDir } from './helpers.ts';

// P0 → P1 (with P1-era work and a still-open P0 review) → P2.
function throughP1(dir?: string) {
  const f = new Fixture(dir).baseline();
  f.evolve(f.p1Files());
  f.ok('add_criterion', { id: 'ops', title: 'Operational cost', weight: 3 });
  f.ok('score', { alternative: 'sqlite', criterion: 'ops', score: 9 });
  f.ok('score', { alternative: 'postgres', criterion: 'ops', score: 5 });
  f.ok('attach_evidence', { id: 'ev1', alternative: 'sqlite', title: 'Ingest load test', kind: 'measurement', stance: 'for' });
  f.ok('attach_evidence', { id: 'ev2', alternative: 'postgres', title: 'Vendor claims', kind: 'citation', stance: 'for' });
  return f;
}
const p2Files = (f: Fixture) => withManifest(readPackageDir(P2_DIR), { parent: f.host.world('project').packageHash });
function toParallelReviews(f: Fixture) {
  f.evolve(p2Files(f));
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'Notebook-era review' }, { packageHash: f.p0 });
  f.ok('add_alternative', { id: 'duckdb', title: 'DuckDB' });
  f.ok('score', { alternative: 'duckdb', criterion: 'ops', score: 8 });
  f.ok('attach_evidence', { id: 'ev3', alternative: 'postgres', title: 'Replica benchmark', kind: 'measurement', stance: 'against', basis: 'measured' });
  f.ok('attach_evidence', { id: 'ev4', alternative: 'duckdb', title: 'Analytical benchmark', kind: 'measurement', stance: 'for', basis: 'measured' });
  f.ok('request_parallel_reviews', { key: 'p2', decision: 'd1' });
  f.host.grantAllowance('root-p2', 4);
}

test('P2 successor: measured vs assumed backfill, new assumption relation, third option, changed planner; P1/P0 work retained', () => {
  const f = throughP1();
  const policy = POLICY_ID;
  const { id, result } = f.propose(p2Files(f));
  assert.equal(result.status, 'previewable');
  assert.deepEqual(result.report.added.types, ['assumption']); assert.deepEqual(result.report.added.relations, ['assumes']);
  assert.ok(result.report.added.fields.includes('evidence.basis'));
  assert.ok(result.report.added.plannerRules.includes('ready_for_parallel_review'));
  f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  assert.equal(f.host.activate(id).status, 'committed');
  const s = f.host.state('project');
  assert.equal(s.records.get('ev1')!.data.basis, 'measured'); assert.equal(s.records.get('ev2')!.data.basis, 'assumed');
  assert.equal(s.relations.get('scores:sqlite:ops')!.data.score, 9, 'P1-era relations retained');
  assert.equal(f.host.pendingWork().map(o => o.id).join(), 'ob-r17', 'P0-era review survives two upgrades');
  const rules = () => f.host.project('project').planner.suggestions.map(x => x.rule);
  assert.deepEqual(rules(), ['third_option', 'needs_measurement']);
  // P30: an unseen third option and a new type relation, with no host change.
  f.ok('add_alternative', { id: 'duckdb', title: 'DuckDB' });
  f.ok('add_assumption', { id: 'as1', alternative: 'postgres', statement: 'Ops team can run replication', confidence: 2 });
  assert.equal(POLICY_ID, policy);
  const views = f.host.project('project').views;
  assert.match(JSON.stringify(views.find(v => v.id === 'assumptions')), /Ops team can run replication — Postgres \(confidence 2\/5\)/);
  assert.match(JSON.stringify(views.find(v => v.id === 'assumptions')), /Vendor claims — Postgres \(unmeasured evidence\)/);
  assert.match(JSON.stringify(views.find(v => v.id === 'measured')), /Ingest load test/);
  const early = f.act('request_parallel_reviews', { key: 'p2', decision: 'd1' });
  assert.equal(early.status, 'rejected'); assert.match((early as any).reasons[0], /measured result/);
});

test('P2: both independent reviews run in parallel and both remain prerequisites for finalizing', async () => {
  const f = throughP1();
  toParallelReviews(f);
  // Adding a third option redrafted the decision, so the owner's earlier two-option review reopens too.
  const obs = f.host.pendingWork().map(o => o.id).sort();
  assert.deepEqual(obs, ['ob-p2-method', 'ob-p2-risk', 'ob-r17-r2']);
  f.ok('record_review', { obligation: 'ob-r17-r2', verdict: 'approve', note: 'Three options reviewed' }, { packageHash: f.p0 });
  assert.match((f.host.finalize('fin-0', 'project', f.revision, 'd1', 'sqlite') as any).reasons.join(), /Methodology review.*open.*Risk review.*open/s);
  // First run: methodology succeeds, risk reviewer fails. One review is not enough.
  const first = await runQueued(f.host, { kind: 'simulated', async review(b, sig) {
    if (b.obligation.id.endsWith('-risk')) throw new Error('reviewer unavailable');
    return simulatedReviewer.review(b, sig);
  } }, { root: 'root-p2', concurrency: 2 });
  assert.equal(first.peakConcurrency, 2, 'both reviews were in flight at once');
  assert.deepEqual(first.results.map(r => r.outcome).sort(), ['committed', 'failed']);
  const blocked = f.host.finalize('fin-1', 'project', f.revision, 'd1', 'sqlite');
  assert.equal(blocked.status, 'rejected'); assert.match((blocked as any).reasons.join(), /Risk review/);
  // Owner authorizes a retry; the shared allowance is charged again.
  const risk = f.host.tasks().find(t => t.obligation === 'ob-p2-risk')!;
  f.host.retryTask(risk.id);
  const second = await runQueued(f.host, simulatedReviewer, { root: 'root-p2' });
  assert.deepEqual(second.results.map(r => r.outcome), ['committed']);
  assert.equal(f.host.allowance('root-p2')!.used, 3);
  const [m, r] = ['ob-p2-method', 'ob-p2-risk'].map(id => f.host.ledger().find(o => o.id === id)!);
  assert.notEqual(m.fulfillment!.principal, r.fulfillment!.principal, 'independent reviewers');
  assert.match(m.fulfillment!.note, /^SIMULATED/, 'simulated results are labelled');
  const fin = f.host.finalize('fin-2', 'project', f.revision, 'd1', 'duckdb');
  assert.equal(fin.status, 'committed', JSON.stringify(fin));
});

test('P11/P12: a crash mid-review keeps committed review evidence, never reruns it, and reports the uncertain call', () => {
  const dir = tempDir();
  const f = throughP1(dir);
  toParallelReviews(f);
  f.host.close();
  const child = spawnSync(process.execPath, [new URL('./runner-child.ts', import.meta.url).pathname, dir], { encoding: 'utf8' });
  assert.equal(child.status, 137, child.stderr);
  const host = new Host(dir);
  const uncertain = host.reconcileAttempts();
  assert.equal(uncertain.length, 1); assert.match(uncertain[0], /ob-p2-risk/);
  const method = host.ledger().find(o => o.id === 'ob-p2-method')!;
  assert.equal(method.status, 'fulfilled', 'the committed review survived the crash');
  const risk = host.tasks().find(t => t.obligation === 'ob-p2-risk')!;
  assert.equal(risk.status, 'reconcile');
  assert.equal(host.attempts(risk.id).at(-1).status, 'uncertain');
  assert.equal(host.allowance('root-p2')!.used, 2, 'the uncertain call keeps its reservation');
  assert.ok(host.db.prepare("SELECT 1 FROM events WHERE kind='attempt_uncertain' AND data LIKE '%may have run and incurred cost%'").get());
  return runQueued(host, simulatedReviewer, { root: 'root-p2' }).then(r => {
    assert.equal(r.results.length, 0, 'nothing is rerun automatically: committed stages are done, uncertain ones wait for the owner');
    assert.equal(host.tasks().find(t => t.obligation === 'ob-p2-method')!.status, 'succeeded');
  });
});

test('renewed job-discharged reviews get their own queued jobs, so a rescore never strands them', async () => {
  const f = throughP1();
  toParallelReviews(f);
  await runQueued(f.host, simulatedReviewer, { root: 'root-p2' });
  f.ok('record_review', { obligation: 'ob-r17-r2', verdict: 'approve', note: 'Three options reviewed' }, { packageHash: f.p0 });
  assert.equal(f.host.pendingWork().length, 0);
  const rescore = f.ok('score', { alternative: 'duckdb', criterion: 'ops', score: 6 });
  assert.match(rescore.notes.join(), /opened ob-p2-method-r2.*opened ob-p2-risk-r2/s);
  assert.deepEqual(f.host.tasks().filter(t => t.status === 'queued').map(t => t.obligation).sort(), ['ob-p2-method-r2', 'ob-p2-risk-r2']);
  assert.equal(f.host.finalize('fin-a', 'project', f.revision, 'd1', 'duckdb').status, 'rejected');
  f.host.grantAllowance('root-p2', 2);
  const r = await runQueued(f.host, simulatedReviewer, { root: 'root-p2' });
  assert.deepEqual(r.results.map(x => x.outcome), ['committed', 'committed']);
  assert.equal(f.host.finalize('fin-b', 'project', f.revision, 'd1', 'duckdb').status, 'committed');
});
