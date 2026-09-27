import { test } from 'node:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { authorizeAction, continuationWitnesses } from '../src/host/checker.ts';
import { readPackageDir, withManifest } from '../src/host/package-dir.ts';
import { addFile, editJson, Fixture, P0_DIR, removeFile } from './helpers.ts';

const rejectedWith = (f: Fixture, files: Record<string, string>, pattern: RegExp) => {
  const { result } = f.propose(files);
  assert.equal(result.status, 'rejected');
  assert.match(result.reasons.join('\n'), pattern);
  assert.equal(f.host.world('project').packageHash, f.p0, 'active package unchanged');
};

test('P13: a migration cannot delete an open obligation, nor remove the type its subjects use', () => {
  const f = new Fixture().baseline();
  rejectedWith(f, f.p1Files(files => editJson(files, 'migrations/001-comparison.json', m => ({ steps: [...m.steps, { delete_obligation: { id: 'ob-r17' } }] }))),
    /only additive backfill steps/);
  // A statically valid candidate that simply drops the subjects' type and everything using it.
  const dropped = withManifest(readPackageDir(P0_DIR), { parent: f.p0 });
  editJson(dropped, 'schemas/notebook.json', s => ({ types: s.types.filter((t: any) => t.id !== 'alternative') }));
  for (const path of ['actions/add_alternative.json', 'actions/edit_alternative.json', 'actions/start_decision.json', 'views/alternatives.json', 'planner.json']) removeFile(dropped, path);
  editJson(dropped, 'package.json', m => ({ ...m, views: ['notes', 'reviews'], capabilities: m.capabilities.filter((c: string) => c !== 'decisions.draft') }));
  rejectedWith(f, dropped, /removes type alternative[\s\S]*continuation for review ob-r17 .*can no longer read or write its records/);
  assert.equal(f.host.pendingWork().map(o => o.id).join(), 'ob-r17');
});

test('P14: keeping the obligation row but removing its handler or package is rejected; a blocked label is no escape', () => {
  const f = new Fixture().baseline();
  rejectedWith(f, f.p1Files(undefined, { retire: [f.p0] }), /retires package .* removing the continuation for review ob-r17/);
  rejectedWith(f, f.p1Files(undefined, { continuations: { [`${f.p0}:record_review`]: 'no_such_action' } }),
    /maps the continuation for review ob-r17 .* to no_such_action, which does not exist/);
  // Artifact removal: a live obligation whose referenced artifact disappears has no witness.
  const state = f.host.state('project'); const ledger = f.host.ledger();
  const withArtifact = ledger.map(o => o.id === 'ob-r17' ? { ...o, artifacts: ['a'.repeat(64)] } : o);
  const blocked = withArtifact.map(o => ({ ...o, status: 'blocked' as const }));
  const candidate = f.host.pkg(f.p0)!;
  for (const l of [withArtifact, blocked]) {
    const w = continuationWitnesses(state, l, f.host.ctx('project'), candidate, candidate.manifest.capabilities);
    assert.equal(w[0].ok, false); assert.match(w[0].problems.join(), /Artifact aaaaaaaaaaaa referenced by review ob-r17 .* is missing/);
  }
});

test('P15: a migration cannot retarget evidence, reinterpret a field, or rebind the discharge rule', () => {
  const f = new Fixture().baseline();
  rejectedWith(f, f.p1Files(files => editJson(files, 'migrations/001-comparison.json', () => ({ steps: [{ backfill: { type: 'alternative', field: 'title', value: { lit: 'Generated' } } }] }))),
    /writes existing field alternative.title/);
  rejectedWith(f, f.p1Files(files => editJson(files, 'migrations/001-comparison.json', () => ({ steps: [{ rebind: { obligation: 'ob-r17', verdicts: ['generated'] } }] }))),
    /only additive backfill steps/);
  rejectedWith(f, f.p1Files(files => editJson(files, 'schemas/notebook.json', s => {
    s.types[1].fields.summary = { type: 'string', max: 2000, default: '', semantic: 'alternative/generated-summary' }; return s;
  })), /changes the meaning, units or type of alternative.summary/);
  rejectedWith(f, f.p1Files(files => editJson(files, 'schemas/notebook.json', s => {
    s.types[1].fields.cost = { type: 'int', default: 0, semantic: 'alternative/summary' }; return s;
  })), /reuses semantic ID alternative\/summary/);
  const ob = f.host.ledger().find(o => o.id === 'ob-r17')!;
  assert.deepEqual(ob.policy.verdicts, ['approve']); assert.equal(ob.policy.discharge, 'owner');
});

test('P14 (store path): a deleted or corrupted artifact is reported unavailable, never silently served', () => {
  const f = new Fixture();
  const hash = f.host.putArtifact(Buffer.from('review report'), 'text/markdown');
  assert.equal(f.host.readArtifact(hash).bytes.toString(), 'review report');
  writeFileSync(join(f.host.dir, 'artifacts', hash), 'tampered bytes');
  assert.throws(() => f.host.readArtifact(hash), /missing|failed verification/);
  unlinkSync(join(f.host.dir, 'artifacts', hash));
  assert.equal(f.host.hasArtifact(hash), false);
  assert.throws(() => f.host.readArtifact(hash), /missing/);
});

test('P35: old code bytes present but capability or interpreter support removed is rejected', () => {
  const f = new Fixture().baseline();
  rejectedWith(f, f.p1Files(files => {
    for (const a of ['record_review', 'request_review', 'request_ai_review', 'request_comparison_review']) removeFile(files, `actions/${a}.json`);
    editJson(files, 'planner.json', p => ({ rules: p.rules.filter((r: any) => !r.suggest.action.startsWith('request_')) }));
  }, { capabilities: ['records.write', 'relations.write', 'decisions.draft'] }),
    /removes capability evidence.submit, which the continuation for review ob-r17/);
  const candidate = f.host.pkg(f.p0)!;
  const w = continuationWitnesses(f.host.state('project'), f.host.ledger(), f.host.ctx('project'), candidate, candidate.manifest.capabilities, ['workshop-lang/2']);
  assert.match(w[0].problems.join(), /No supported interpreter remains/);
});

test('P16: an owner cancellation is a separate audited disposition for exactly one obligation', () => {
  const f = new Fixture().baseline();
  f.ok('request_review', { key: 'r18', decision: 'd1' });
  const bad = f.host.dispose('d-job', 'project', f.revision, 'ob-r17', 'cancel', 'no longer needed', null, 'job:x');
  assert.equal(bad.status, 'rejected');
  const noReason = f.host.dispose('d-empty', 'project', f.revision, 'ob-r17', 'cancel', '');
  assert.equal(noReason.status, 'rejected');
  const ok = f.host.dispose('d-1', 'project', f.revision, 'ob-r17', 'cancel', 'Scope reduced by owner');
  assert.equal(ok.status, 'committed');
  const ledger = f.host.ledger();
  assert.equal(ledger.find(o => o.id === 'ob-r17')!.status, 'cancelled_by_owner');
  assert.equal(ledger.find(o => o.id === 'ob-r18')!.status, 'open');
  assert.equal(f.host.dispositions().length, 1);
  assert.equal(f.host.dispositions()[0].obligation, 'ob-r17');
  // No blanket waiver: new obligations remain binding.
  f.ok('request_review', { key: 'r19', decision: 'd1' });
  assert.equal(f.host.finalize('fin-1', 'project', f.revision, 'd1', 'sqlite').status, 'rejected');
});

test('P17: finalization with an outstanding protected review is rejected through every entry point', () => {
  const f = new Fixture().baseline();
  const owner = f.host.finalize('fin-a', 'project', f.revision, 'd1', 'sqlite');
  assert.equal(owner.status, 'rejected'); assert.match((owner as any).reasons[0], /ob-r17 .* is open/);
  const job = f.host.finalize('fin-b', 'project', f.revision, 'd1', 'sqlite', 'job:task-x');
  assert.equal(job.status, 'rejected'); assert.match((job as any).reasons[0], /only the owner/);
  // No action envelope can reach finalization: it is not a package primitive.
  const envelope = f.act('finalize_decision', { decision: 'd1' });
  assert.equal(envelope.status, 'rejected'); assert.match((envelope as any).reasons[0], /no action finalize_decision/);
  // A package action cannot discharge an owner review by submitting evidence as another action.
  const self = f.act('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'x' }, { packageHash: f.p0 });
  assert.equal(self.status, 'committed', 'owner may discharge through the bound continuation');
  assert.equal(f.host.state('project').decisions.get('d1')!.status, 'draft');
});

test('P18: a valid decision with current bound evidence finalizes through the protected command', () => {
  const f = new Fixture().baseline();
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'changes_requested', note: 'Need benchmarks' });
  assert.equal(f.host.ledger()[0].status, 'open', 'a non-fulfilling verdict is recorded but does not discharge');
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'Benchmarks attached' });
  const done = f.host.finalize('fin', 'project', f.revision, 'd1', 'sqlite');
  assert.equal(done.status, 'committed');
  const d = f.host.state('project').decisions.get('d1')!;
  assert.equal(d.status, 'final'); assert.equal(d.choice, 'sqlite');
  assert.equal(f.host.finalize('fin-again', 'project', f.revision, 'd1', 'postgres').status, 'rejected');
});

test('evidence must arrive through the bound continuation and cannot change its own subject in the same step', () => {
  const f = new Fixture().baseline();
  const files = f.p1Files(fs => addFile(fs, 'actions/edit_and_approve.json', JSON.stringify({ id: 'edit_and_approve', title: 'Edit and approve',
    inputs: { obligation: { type: 'string' } },
    effects: [{ update: { type: 'alternative', id: { lit: 'sqlite' }, fields: { summary: { lit: 'quietly changed' } } } },
      { evidence: { obligation: { input: 'obligation' }, verdict: { lit: 'approve' }, note: { lit: 'looks good' } } }] })));
  f.evolve(files);
  const r = f.act('edit_and_approve', { obligation: 'ob-r17' });
  assert.equal(r.status, 'rejected'); assert.match((r as any).reasons[0], /continuation record_review/);
  // Even through the bound continuation route, a same-step subject edit is refused.
  const executing = f.host.pkg(f.p0)!;
  assert.throws(() => authorizeAction({ state: f.host.state('project'), ledger: f.host.ledger(), ctx: f.host.ctx('project'), executing, actionId: 'record_review',
    authority: { principal: 'owner', capabilities: new Set(executing.manifest.capabilities) }, operationId: 'unit',
    primitives: [{ op: 'update_record', type: 'alternative', id: 'sqlite', data: { summary: 'edited' } },
      { op: 'submit_evidence', obligation: 'ob-r17', verdict: 'approve', note: 'ok', artifact: null }] }), /same step that changes its subject/);
});

test('P38: fulfil a review, change its subject, upgrade, then finalize: the linked renewal blocks until covered', () => {
  const f = new Fixture().baseline();
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'Reviewed v1' });
  const renewal = f.ok('edit_alternative', { id: 'sqlite', summary: 'Now with WAL mode' });
  assert.match(renewal.notes.join(), /opened ob-r17-r2/);
  f.evolve(f.p1Files());
  // Additive migration does not invalidate the projection the reviewer saw.
  assert.equal(f.host.ledger().filter(o => o.status === 'open').map(o => o.id).join(), 'ob-r17-r2');
  const blocked = f.host.finalize('fin-1', 'project', f.revision, 'd1', 'sqlite');
  assert.equal(blocked.status, 'rejected'); assert.match((blocked as any).reasons[0], /ob-r17-r2/);
  // The renewal continues through the original package's pinned continuation.
  f.ok('record_review', { obligation: 'ob-r17-r2', verdict: 'approve', note: 'Reviewed v2' }, { packageHash: f.p0 });
  assert.equal(f.host.finalize('fin-2', 'project', f.revision, 'd1', 'sqlite').status, 'committed');
  const history = f.host.ledger().find(o => o.id === 'ob-r17')!;
  assert.equal(history.status, 'fulfilled'); assert.equal(history.fulfillment!.note, 'Reviewed v1');
});
