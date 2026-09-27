import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, removeFile } from './helpers.ts';

// Baseline → snapshot (via activation) → newer edits and a newer obligation → restore.
function restored() {
  const f = new Fixture().baseline();
  f.evolve(f.p1Files());
  const snap = (f.host.worlds() as any[]).find(w => w.kind === 'recovery')!.id as string;
  f.ok('add_criterion', { id: 'ops', title: 'Operational cost', weight: 3 });
  f.ok('edit_alternative', { id: 'sqlite', summary: 'Edited after the snapshot' });
  f.ok('request_review', { key: 'late', decision: 'd1' });
  // A no-migration successor of the active P1, approved but not yet applied when the restore happens.
  const pending = f.propose(f.p1Files(fs => { fs['prompts/review.md'] += '\n'; removeFile(fs, 'migrations/001-comparison.json'); }, { migration: null }));
  assert.equal(pending.result.status, 'previewable');
  f.host.approve(pending.id, { previewHash: pending.result.preview.previewHash, candidateHash: pending.result.preview.candidateHash });
  const journalBefore = (f.host.db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n;
  const r = f.host.restore('restore-1', snap);
  assert.equal(r.status, 'committed', JSON.stringify(r));
  return { f, snap, branch: r.branch!, excluded: r.excluded!, journalBefore, pendingProposal: pending.id };
}

test('P24: restoring a snapshot creates a new branch, retains the newer one, discloses exclusions, keeps the journal', () => {
  const { f, branch, excluded, journalBefore, pendingProposal } = restored();
  assert.equal(f.host.world(branch).status, 'active'); assert.equal(f.host.world('project').status, 'retained');
  assert.equal(f.host.world(branch).packageHash, f.p0, 'branch returns to the snapshot package');
  assert.ok(excluded.includes('record ops (added after the snapshot)'));
  assert.ok(excluded.includes('record sqlite (edited after the snapshot)'));
  assert.ok(excluded.some(e => e.startsWith('application package')));
  assert.equal(f.host.state(branch).records.get('sqlite')!.data.summary, '');
  assert.equal(f.host.state('project').records.get('sqlite')!.data.summary, 'Edited after the snapshot', 'newer branch retained intact');
  assert.ok((f.host.db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n > journalBefore, 'journal only grows');
  assert.ok(f.host.db.prepare("SELECT 1 FROM commands WHERE id='restore-1'").get());
  // An approval prepared against the now-retained branch cannot activate there.
  assert.equal(f.host.proposal(pendingProposal).status, 'approved');
  const late = f.host.activate(pendingProposal);
  assert.equal(late.status, 'rejected'); assert.match((late as any).reasons[0], /no longer the active branch/);
  // The retained branch no longer accepts ordinary edits.
  const edit = f.act('add_note', { id: 'nope', title: 'x' }, { world: 'project' });
  assert.equal(edit.status, 'rejected');
  f.ok('add_note', { id: 'after-restore', title: 'Work continues in the branch' }, { world: branch });
});

test('P33: an obligation newer than the snapshot stays pending, bound once, completable through its retained continuation', () => {
  const { f, branch } = restored();
  const pending = f.host.pendingWork();
  assert.deepEqual(pending.map(o => [o.id, o.world]).sort(), [['ob-late', 'project'], ['ob-r17', 'project']]);
  assert.equal(f.host.ledger(branch).filter(o => o.world === branch).length, 0, 'no duplicate authority in the restored branch');
  // Restoring cannot drop a review gate: the copied decision is still gated by the retained branch's obligations.
  const blocked = f.host.finalize('fin-1', branch, f.host.world(branch).revision, 'd1', 'sqlite');
  assert.equal(blocked.status, 'rejected'); assert.match((blocked as any).reasons.join(), /ob-late .* in retained branch project/);
  // Complete one in its retained world through the pinned continuation, using the owner's current capability.
  const w = f.host.world('project');
  const late = f.host.ledger().find(o => o.id === 'ob-late')!;
  assert.notEqual(late.continuation.packageHash, f.p0, 'created under P1, so pinned to P1');
  const done = f.host.run({ operationId: 'cont-late', worldId: 'project', expectedRevision: w.revision, packageHash: late.continuation.packageHash, capabilityRef: `cap-owner-${branch}`,
    actionId: 'record_review', input: { obligation: 'ob-late', verdict: 'approve', note: 'Completed in retained branch' } });
  assert.equal(done.status, 'committed', JSON.stringify(done));
  // Transfer the other one explicitly; it then belongs to the branch only.
  const t = f.host.transfer('xfer-1', 'ob-r17', branch, f.host.world(branch).revision);
  assert.equal(t.status, 'committed', JSON.stringify(t));
  assert.equal(f.host.ledger().find(o => o.id === 'ob-r17')!.world, branch);
  assert.equal(f.host.transfer('xfer-2', 'ob-r17', branch, f.host.world(branch).revision).status, 'rejected', 'cannot transfer twice');
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'Reviewed in branch' }, { world: branch, packageHash: f.p0 });
  // ob-late reviewed the retained branch's newer subject, which differs from this branch's older subject.
  const stale = f.host.finalize('fin-2', branch, f.host.world(branch).revision, 'd1', 'sqlite');
  assert.equal(stale.status, 'rejected'); assert.match((stale as any).reasons.join(), /ob-late reviewed an earlier subject revision/);
});
