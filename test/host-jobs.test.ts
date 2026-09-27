import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host/store.ts';
import { Fixture, tempDir } from './helpers.ts';
import { join } from 'node:path';
import { AuthorJournal } from '../src/authoring.ts';
import { runQueued, type ReviewBundle, type Reviewer } from '../src/host/runner.ts';

const aiReview = (f: Fixture, key: string) => { f.ok('request_ai_review', { key, decision: 'd1' }); return f.host.tasks().find(t => t.obligation === `ob-${key}`)!; };
const approve = { verdict: 'approve', note: 'Independent review: acceptable', report: '# Review\nApproved.' };

test('P09: a replaced attempt generation or an old controller epoch cannot commit its result', () => {
  const dir = tempDir();
  const f = new Fixture(dir).baseline();
  const task = aiReview(f, 'ai1');
  f.host.grantAllowance('root-1', 5);
  const first = f.host.startAttempt(task.id, 'root-1');
  const second = f.host.startAttempt(task.id, 'root-1');
  const stale = f.host.completeReview(first, approve);
  assert.equal(stale.status, 'rejected'); assert.match((stale as any).reasons.join(), /capability reference|replaced/);
  f.host.close();
  const restarted = new Host(dir);
  assert.equal(restarted.epoch, f.host.epoch + 1);
  const oldEpoch = restarted.completeReview(second, approve);
  assert.equal(oldEpoch.status, 'rejected'); assert.match((oldEpoch as any).reasons.join(), /controller epoch/);
  // Reconciliation starts a new fenced attempt; only that one commits.
  const third = restarted.startAttempt(task.id, 'root-1');
  assert.equal(restarted.completeReview(third, approve).status, 'committed');
  assert.equal(restarted.ledger().find(o => o.id === 'ob-ai1')!.status, 'fulfilled');
  assert.equal(restarted.allowance('root-1')!.used, 3);
});

test('P10: after cancellation neither new dispatch nor a late result is accepted', () => {
  const f = new Fixture().baseline();
  const task = aiReview(f, 'ai1');
  f.host.grantAllowance('root-1', 5);
  const attempt = f.host.startAttempt(task.id, 'root-1');
  f.host.cancelTask(task.id);
  const late = f.host.completeReview(attempt, approve);
  assert.equal(late.status, 'rejected');
  assert.throws(() => f.host.startAttempt(task.id, 'root-1'), /is cancelled/);
  assert.equal(f.host.ledger().find(o => o.id === 'ob-ai1')!.status, 'open');
  assert.ok(f.host.db.prepare("SELECT 1 FROM events WHERE kind='task_cancelled'").get(), 'cancellation and pending cleanup are recorded');
});

test('P36: all dispatches share one finite root allowance; only an owner action replenishes it', () => {
  const f = new Fixture().baseline();
  const a = aiReview(f, 'ai1'); const b = aiReview(f, 'ai2');
  f.host.grantAllowance('root-1', 2);
  f.host.startAttempt(a.id, 'root-1');
  f.host.startAttempt(a.id, 'root-1'); // a retry consumes the same allowance
  assert.throws(() => f.host.startAttempt(b.id, 'root-1'), /allowance root-1 is exhausted/);
  f.host.grantAllowance('root-1', 1);
  assert.ok(f.host.startAttempt(b.id, 'root-1'));
});

test('job authority is attenuated to its own obligation; independent reviews need distinct jobs', () => {
  const f = new Fixture().baseline();
  const a = aiReview(f, 'ai1'); aiReview(f, 'ai2');
  f.host.grantAllowance('root-1', 5);
  const fence = f.host.startAttempt(a.id, 'root-1');
  const w = f.host.world('project');
  const cross = f.host.run({ operationId: 'cross', worldId: 'project', expectedRevision: w.revision, packageHash: f.p0, capabilityRef: fence.capabilityRef,
    actionId: 'record_review', input: { obligation: 'ob-ai2', verdict: 'approve', note: 'not mine' }, attemptFence: fence }, `job:${a.id}`);
  assert.equal(cross.status, 'rejected'); assert.match((cross as any).reasons[0], /must be discharged by its own running review job/);
  const write = f.host.run({ operationId: 'write', worldId: 'project', expectedRevision: w.revision, packageHash: f.p0, capabilityRef: fence.capabilityRef,
    actionId: 'add_note', input: { id: 'job-note', title: 'jobs cannot write records' }, attemptFence: fence }, `job:${a.id}`);
  assert.equal(write.status, 'rejected'); assert.match((write as any).reasons[0], /lacks records.write/);
  assert.equal(f.host.completeReview(fence, approve).status, 'committed');
  const owner = f.act('record_review', { obligation: 'ob-ai2', verdict: 'approve', note: 'owner is not a job' });
  assert.equal(owner.status, 'rejected'); assert.match((owner as any).reasons[0], /own running review job/);
});

test('P34: an attempt running across activation keeps one valid result route under its pinned package', () => {
  const f = new Fixture().baseline();
  const task = aiReview(f, 'ai1');
  f.host.grantAllowance('root-1', 5);
  const fence = f.host.startAttempt(task.id, 'root-1');
  f.evolve(f.p1Files());
  assert.notEqual(f.host.world('project').packageHash, f.p0);
  assert.equal(f.host.tasks()[0].status, 'running', 'activation neither cancels nor duplicates the running attempt');
  assert.equal(f.host.allowance('root-1')!.used, 1);
  assert.equal(f.host.completeReview(fence, approve).status, 'committed');
  const ob = f.host.ledger().find(o => o.id === 'ob-ai1')!;
  assert.equal(ob.status, 'fulfilled'); assert.equal(ob.continuation.packageHash, f.p0);
  assert.equal(ob.artifacts.length, 1); assert.ok(f.host.hasArtifact(ob.artifacts[0]));
  const again = f.host.completeReview(fence, approve);
  assert.equal(again.status, 'rejected', 'a duplicate callback cannot commit twice');
});

test('a job review binds the subject it was dispatched with; an edit during review voids that result', () => {
  const f = new Fixture().baseline();
  const task = aiReview(f, 'ai1');
  f.host.grantAllowance('root-1', 5);
  const fence = f.host.startAttempt(task.id, 'root-1');
  f.ok('edit_alternative', { id: 'sqlite', summary: 'Changed while the reviewer was working' });
  const r = f.host.completeReview(fence, approve);
  assert.equal(r.status, 'rejected'); assert.match((r as any).reasons[0], /changed after the review was dispatched/);
  assert.equal(f.host.ledger().find(o => o.id === 'ob-ai1')!.status, 'open');
  assert.equal(f.host.allowance('root-1')!.used, 1, 'the spent call stays charged');
  assert.equal(f.host.tasks().find(t => t.id === task.id)!.status, 'failed');
  f.host.retryTask(task.id);
  assert.equal(f.host.completeReview(f.host.startAttempt(task.id, 'root-1'), approve).status, 'committed');
});

test('P23: migrating one selected paused job moves only that job; completed evidence and unselected jobs stay pinned', () => {
  const f = new Fixture().baseline();
  const done = aiReview(f, 'ai0'); const selected = aiReview(f, 'ai1'); const other = aiReview(f, 'ai2');
  f.host.grantAllowance('root-1', 5);
  assert.equal(f.host.completeReview(f.host.startAttempt(done.id, 'root-1'), approve).status, 'committed');
  const running = f.host.startAttempt(other.id, 'root-1');
  // A running job cannot be selected.
  const bad = f.host.propose('prop-bad', 'project', 'migrate a running job', f.p1Files(), null, [other.id]);
  assert.equal(bad.status, 'rejected'); assert.match(bad.reasons.join(), /is running; only paused or reconciled jobs can be migrated/);
  const good = f.host.propose('prop-good', 'project', 'migrate one paused job', f.p1Files(), null, [selected.id]);
  assert.equal(good.status, 'previewable');
  // The selection is part of the approved identity.
  const without = f.host.candidateHash(f.host.pkg(good.report.packageHash)!, 'project', good.preview.baseRevision, good.report.capabilities.after, []);
  assert.notEqual(without, good.preview.candidateHash);
  f.host.approve('prop-good', { previewHash: good.preview.previewHash, candidateHash: good.preview.candidateHash });
  assert.equal(f.host.activate('prop-good').status, 'committed');
  const tasks = new Map(f.host.tasks().map(t => [t.id, t]));
  assert.equal(tasks.get(selected.id)!.packageHash, good.report.packageHash, 'selected job now dispatches from the new package');
  assert.equal(tasks.get(other.id)!.packageHash, f.p0, 'unselected running job stays pinned');
  assert.equal(tasks.get(done.id)!.packageHash, f.p0);
  const ob0 = f.host.ledger().find(o => o.id === 'ob-ai0')!;
  assert.equal(ob0.status, 'fulfilled'); assert.ok(f.host.hasArtifact(ob0.artifacts[0]), 'completed evidence survives');
  assert.equal(f.host.completeReview(running, approve).status, 'committed', 'the unselected running attempt keeps its result route');
  assert.equal(f.host.completeReview(f.host.startAttempt(selected.id, 'root-1'), approve).status, 'committed');
});

test('one allowance: author attempts and review jobs draw from one finite root allowance', () => {
  const f = new Fixture().baseline();
  const task = aiReview(f, 'ai1');
  f.host.grantAllowance('change-1', 2);
  const journal = new AuthorJournal(join(f.host.dir, 'author-journal.sqlite'));
  const req = (id: string) => ({ operationId: id, rootId: 'change-1', prompt: 'p', model: 'm' });
  assert.equal(journal.reserve(req('author-1'), () => f.host.reserveUnit('change-1', 'author author-1')), true);
  f.host.startAttempt(task.id, 'change-1');
  assert.throws(() => journal.reserve(req('author-2'), () => f.host.reserveUnit('change-1', 'author author-2')), /allowance change-1 is exhausted/);
  assert.equal(journal.inspect('author-2'), undefined, 'no attempt recorded without a unit');
  const task2 = aiReview(f, 'ai2');
  assert.throws(() => f.host.startAttempt(task2.id, 'change-1'), /allowance change-1 is exhausted/);
  assert.equal(journal.reserve(req('author-1'), () => { throw new Error('must not charge a replay'); }), false, 'a replayed author operation is not charged again');
  const charges = f.host.db.prepare("SELECT data FROM events WHERE kind='allowance_charged'").all().map((r: any) => JSON.parse(r.data).purpose);
  assert.deepEqual(charges, ['author author-1', `review ${task.id}`]);
});

test('after changes are requested, the owner can queue another review; reviewers see related evidence and the decision', async () => {
  const f = new Fixture().baseline();
  f.evolve(f.p1Files());
  f.ok('add_criterion', { id: 'ops', title: 'Operational cost', weight: 3 });
  f.ok('score', { alternative: 'sqlite', criterion: 'ops', score: 9 });
  f.ok('attach_evidence', { id: 'ev1', alternative: 'sqlite', title: 'Load test 40k rows/s', kind: 'measurement', stance: 'for' });
  f.ok('request_ai_review', { key: 'ai1', decision: 'd1' }, { packageHash: f.host.world('project').packageHash });
  const bundles: ReviewBundle[] = [];
  const reviewer = (verdict: string): Reviewer => ({ kind: 'simulated', async review(b) { bundles.push(b); return { verdict, note: 'n', report: 'r' }; } });
  f.host.grantAllowance('root-1', 3);
  await runQueued(f.host, reviewer('changes_requested'), { root: 'root-1' });
  assert.deepEqual(bundles[0].related.map(r => r.id).sort(), ['ev1', 'ops']);
  assert.equal(bundles[0].decision?.question, 'Which storage engine?');
  assert.equal(f.host.ledger().find(o => o.id === 'ob-ai1')!.status, 'open');
  assert.equal(f.host.tasks().filter(t => t.status === 'queued').length, 0, 'nothing left to discharge it');
  const again = f.host.requestAnotherReview('ob-ai1');
  assert.throws(() => f.host.requestAnotherReview('ob-ai1'), /already has a review job waiting/);
  assert.throws(() => f.host.requestAnotherReview('ob-r17'), /not an open job-discharged review/);
  const r = await runQueued(f.host, reviewer('approve'), { root: 'root-1' });
  assert.deepEqual(r.results.map(x => [x.task, x.outcome]), [[again, 'committed']]);
  assert.equal(f.host.ledger().find(o => o.id === 'ob-ai1')!.status, 'fulfilled');
});
