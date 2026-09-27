import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkActivation } from '../src/host/checker.ts';
import { Host } from '../src/host/store.ts';
import { editJson, Fixture, removeFile, tempDir } from './helpers.ts';

test('completeness: P1 adds a relation, compound review action, evidence-sensitive planner and reusable views with no host change', () => {
  const f = new Fixture().baseline();
  const { id, result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  assert.deepEqual(result.report.added.relations, ['scores', 'supports']);
  assert.ok(result.report.added.actions.includes('request_comparison_review'));
  assert.deepEqual(result.report.added.plannerRules, ['add_criterion', 'missing_evidence', 'ready_for_review']);
  assert.equal(result.report.witnesses[0].obligation, 'ob-r17'); assert.equal(result.report.witnesses[0].route, 'pinned');
  f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  assert.equal(f.host.activate(id).status, 'committed');
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'Notebook-era review still completes' }, { packageHash: f.p0 });
  f.ok('add_criterion', { id: 'ops', title: 'Operational cost', weight: 3 });
  f.ok('score', { alternative: 'sqlite', criterion: 'ops', score: 9 });
  f.ok('score', { alternative: 'postgres', criterion: 'ops', score: 5 });
  const plan = () => f.host.project('project').planner.suggestions.map(s => s.rule);
  assert.deepEqual(plan(), ['missing_evidence']);
  const early = f.act('request_comparison_review', { key: 'cmp', decision: 'd1' });
  assert.equal(early.status, 'rejected'); assert.match((early as any).reasons[0], /evidence to every candidate/);
  f.ok('attach_evidence', { id: 'ev1', alternative: 'sqlite', title: 'Load test', kind: 'measurement', stance: 'for' });
  f.ok('attach_evidence', { id: 'ev2', alternative: 'postgres', title: 'Ops runbook', kind: 'citation', stance: 'against' });
  assert.deepEqual(plan(), ['ready_for_review']);
  f.ok('request_comparison_review', { key: 'cmp', decision: 'd1' });
  const cmp = f.host.ledger().find(o => o.id === 'ob-cmp')!;
  assert.deepEqual([...cmp.subjects].sort(), ['ev1', 'ev2', 'postgres', 'sqlite']);
  const matrix = f.host.project('project').views.find(v => v.id === 'comparison')!;
  assert.deepEqual(matrix.rows.map((r: any) => [r.label, ...r.cells]), [['Postgres', 5], ['SQLite', 9]]);
  // Rescoring a reviewed subject after fulfilment reopens review for the new state.
  f.ok('record_review', { obligation: 'ob-cmp', verdict: 'approve', note: 'Comparison sound' });
  const rescore = f.ok('score', { alternative: 'postgres', criterion: 'ops', score: 6 });
  assert.match(rescore.notes.join(), /opened ob-cmp-r2/);
});

test('P19: changing the candidate after preview/approval invalidates the receipt', () => {
  const f = new Fixture().baseline();
  const { id, result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  // Store a one-byte variant and swap it under the approved proposal.
  const variant = f.host.storePackage(f.p1Files(files => { files['prompts/review.md'] += ' '; }));
  assert.notEqual(variant.hash, result.report.packageHash);
  f.host.db.prepare('UPDATE proposals SET package=? WHERE id=?').run(variant.hash, id);
  const outcome = f.host.activate(id);
  assert.equal(outcome.status, 'rejected'); assert.match((outcome as any).reasons.join(), /candidate changed after approval/);
  assert.equal(f.host.world('project').packageHash, f.p0);
  assert.throws(() => f.host.approve(id, { previewHash: 'x', candidateHash: 'y' }), /proposal is rejected/);
});

test('P20: live edits after preview make activation fail stale; refresh keeps both live edits and proposed source', () => {
  const f = new Fixture().baseline();
  const { id, result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  const receipt = f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  f.ok('add_note', { id: 'late', title: 'Written while the preview was open' });
  const stale = f.host.activate(id);
  assert.equal(stale.status, 'rejected'); assert.match((stale as any).reasons[0], /project changed after this preview .*refresh it before applying/);
  assert.equal(f.host.proposal(id).status, 'stale');
  assert.equal(f.host.world(result.practiceWorld).status, 'archived', 'a stale practice world stops accepting rehearsal');
  assert.equal(f.host.world('project').packageHash, f.p0);
  const fresh = f.host.refresh(id, 'prop-refresh');
  assert.equal(fresh.status, 'previewable');
  assert.equal(fresh.report.packageHash, result.report.packageHash, 'proposed source edits preserved');
  assert.notEqual(fresh.preview.previewHash, result.preview.previewHash);
  assert.ok(f.host.state(fresh.practiceWorld).records.has('late'), 'live edit carried into the refreshed snapshot');
  assert.equal(f.host.activate('prop-refresh').status, 'rejected', 'a new approval is required');
  assert.notEqual(receipt.previewHash, fresh.preview.previewHash);
  f.host.approve('prop-refresh', { previewHash: fresh.preview.previewHash, candidateHash: fresh.preview.candidateHash });
  assert.equal(f.host.activate('prop-refresh').status, 'committed');
  assert.ok(f.host.state('project').records.has('late'));
});

test('P21: practice edits and practice reviews stay in the proposal world', () => {
  const f = new Fixture().baseline();
  const { result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  const practice = result.practiceWorld;
  f.ok('add_criterion', { id: 'practice-crit', title: 'Practice only', weight: 2 }, { world: practice });
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'practice approval' }, { world: practice, packageHash: f.p0 });
  assert.equal(f.host.ledger(practice).find(o => o.id === 'ob-r17')!.status, 'fulfilled');
  assert.equal(f.host.ledger().find(o => o.id === 'ob-r17')!.status, 'open', 'authoritative obligation untouched');
  assert.ok(!f.host.state('project').records.has('practice-crit'));
  f.ok('request_ai_review', { key: 'practice-ai', decision: 'd1' }, { world: practice });
  const task = f.host.tasks(practice)[0];
  f.host.grantAllowance('root-practice', 5);
  // Practice review jobs never enter the live queue at all.
  assert.equal(f.host.tasks().length, 0, 'no live job was created by practice');
  assert.throws(() => f.host.startAttempt(task.id, 'root-practice'), /no task/);
  f.ok('request_ai_review', { key: 'practice-ai', decision: 'd1' });
  assert.equal(f.host.tasks().length, 1, 'the same action live creates its own job without colliding');
});

test('P37: a disposition after approval makes the receipt stale; forged or altered dispositions are rejected', () => {
  const f = new Fixture().baseline();
  f.ok('request_review', { key: 'r18', decision: 'd1' });
  const a = f.propose(f.p1Files());
  assert.equal(a.result.status, 'previewable');
  f.host.approve(a.id, { previewHash: a.result.preview.previewHash, candidateHash: a.result.preview.candidateHash });
  assert.equal(f.host.dispose('disp-after', 'project', f.revision, 'ob-r17', 'supersede', 'Covered by r18', 'ob-r18').status, 'committed');
  assert.match((f.host.activate(a.id) as any).reasons[0], /project changed after this preview/);
  // Fresh preview at the post-disposition revision, approved with that committed disposition.
  const b = f.propose(f.p1Files());
  assert.equal(b.result.status, 'previewable');
  const disp = f.host.dispositions()[0];
  const receipt = f.host.approve(b.id, { previewHash: b.result.preview.previewHash, candidateHash: b.result.preview.candidateHash }, [disp.id]);
  // Receipt reuse across proposals is rejected by the checker.
  const other = f.propose(f.p1Files(fs => { fs['prompts/review.md'] += '\n'; }));
  assert.equal(other.result.status, 'previewable');
  const p = f.host.proposal(other.id);
  assert.throws(() => checkActivation({ state: f.host.state('project'), ledger: f.host.ledger(), ctx: f.host.ctx('project'), candidate: f.host.pkg(p.packageHash!)!,
    candidateHash: p.candidateHash!, preview: p.preview!, approval: receipt, dispositions: f.host.dispositions(), instance: f.host.instance }), /candidate changed after approval|different preview/);
  // Changing the supersession target after approval invalidates the disposition reference.
  f.host.db.prepare('UPDATE dispositions SET data=? WHERE id=?').run(JSON.stringify({ ...disp, successor: 'ob-other' }), disp.id);
  const r = f.host.activate(b.id);
  assert.equal(r.status, 'rejected'); assert.match((r as any).reasons.join(), /not a committed disposition matching/);
  f.host.db.prepare('UPDATE dispositions SET data=? WHERE id=?').run(JSON.stringify(disp), disp.id);
  assert.equal(f.host.activate(b.id).status, 'rejected', 'a rejected activation is not retried implicitly');
});

for (const mode of ['before', 'after'] as const) test(`P22: crash ${mode} the activation commit recovers the ${mode === 'before' ? 'old' : 'new'} binding with no partial migration`, () => {
  const dir = tempDir();
  const f = new Fixture(dir).baseline();
  const { id, result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  f.host.close();
  const child = spawnSync(process.execPath, [new URL('./crash-child.ts', import.meta.url).pathname, dir, id, mode], { encoding: 'utf8' });
  assert.equal(child.status, mode === 'before' ? 137 : 138, child.stderr);
  const host = new Host(dir);
  const w = host.world('project');
  const records = [...host.state('project').records.values()].filter(r => r.type === 'alternative');
  if (mode === 'before') {
    assert.equal(w.packageHash, f.p0); assert.equal(w.revision, 5);
    assert.ok(records.every(r => !('origin' in r.data) && !('status' in r.data)), 'no migrated fields under the old package');
    assert.equal(host.proposal(id).status, 'approved');
  } else {
    assert.equal(w.packageHash, result.report.packageHash); assert.equal(w.revision, 6);
    assert.ok(records.every(r => r.data.origin === 'notebook' && r.data.status === 'candidate'), 'all migrated fields present under the new package');
    assert.equal(host.proposal(id).status, 'active');
    assert.equal(host.worlds().filter((x: any) => x.kind === 'recovery').length, 1, 'pre-activation snapshot retained');
  }
  assert.equal(host.pendingWork().map(o => o.id).join(), 'ob-r17');
  host.close();
});

test('P32: package tests supplement host checks; removing them cannot admit a defect, and a failing one rejects', () => {
  const f = new Fixture().baseline();
  const ok = f.propose(f.p1Files());
  assert.equal(ok.result.status, 'previewable');
  assert.deepEqual((ok.result.report as any).supplementalTests.map((t: any) => [t.id, t.passed]), [['comparison_flow', true]]);
  assert.ok(!f.host.state('project').records.has('pkgtest-crit'), 'rehearsal ran in a disposable world');
  // Planted defect with the package's own tests deleted: the fixed host checks still reject it.
  const defect = f.p1Files(fs => removeFile(fs, 'tests/comparison-flow.json'), { retire: [f.p0] });
  const r = f.propose(defect);
  assert.equal(r.result.status, 'rejected'); assert.match(r.result.reasons.join(), /retires package .* removing the continuation for review ob-r17/);
  // A package test that fails blocks the candidate even though host checks pass.
  const failing = f.p1Files(fs => editJson(fs, 'tests/comparison-flow.json', t => ({ ...t, steps: [{ view: 'comparison', contains: 'Something the view never shows' }] })));
  const bad = f.propose(failing);
  assert.equal(bad.result.status, 'rejected'); assert.match(bad.result.reasons.join(), /Package test comparison_flow failed: step 1: view comparison does not contain/);
});

test('planner guides a new project in order: options, then a decision, then a review', () => {
  const f = new Fixture();
  const next = () => f.host.project('project').planner.suggestions.map(s => s.rule);
  assert.deepEqual(next(), ['add_alternatives']);
  f.ok('add_alternative', { id: 'a', title: 'A' }); f.ok('add_alternative', { id: 'b', title: 'B' });
  assert.deepEqual(next(), ['start_decision']);
  f.ok('start_decision', { id: 'd1', question: 'A or B?' });
  assert.deepEqual(next(), ['require_review']);
  f.ok('request_review', { key: 'r1', decision: 'd1' });
  assert.deepEqual(next(), []);
});
