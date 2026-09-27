import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExport, verifyExport } from '../src/host/export.ts';
import { Host } from '../src/host/store.ts';
import { Fixture, tempDir } from './helpers.ts';

const approve = { verdict: 'approve', note: 'Independent review', report: '# Review\nApproved.' };
function withReviewArtifact() {
  const f = new Fixture().baseline();
  f.ok('request_ai_review', { key: 'ai1', decision: 'd1' });
  f.host.grantAllowance('root-1', 3);
  const task = f.host.tasks()[0];
  assert.equal(f.host.completeReview(f.host.startAttempt(task.id, 'root-1'), approve).status, 'committed');
  return f;
}

test('P26: export refuses an incomplete closure and names the exact missing objects', async () => {
  const f = withReviewArtifact();
  const artifact = f.host.ledger().find(o => o.id === 'ob-ai1')!.artifacts[0];
  unlinkSync(join(f.host.dir, 'artifacts', artifact));
  await assert.rejects(createExport(f.host, join(tempDir(), 'out')), (e: any) => {
    assert.ok(e.reasons.some((r: string) => r.startsWith(`artifact ${artifact} (referenced by obligation ob-ai1`) && r.endsWith('is missing or fails verification')), e.reasons.join('\n'));
    return true;
  });
  const g = new Fixture().baseline();
  g.host.db.prepare("UPDATE packages SET files=replace(files, 'Record a review', 'Record a rewiew') WHERE hash=?").run(g.p0);
  const restarted = new Host(g.host.dir);
  await assert.rejects(createExport(restarted, join(tempDir(), 'out')), (e: any) => {
    assert.ok(e.reasons.some((r: string) => r.startsWith(`package ${g.p0} (needed by world project, continuation of ob-r17)`)), e.reasons.join('\n'));
    assert.ok(e.reasons.some((r: string) => r.includes('continuation of ob-r17')));
    return true;
  });
});

test('export bundle: manifest covers every file; tampering, extra files and a changed checker are detected', async () => {
  const f = withReviewArtifact();
  const out = join(tempDir(), 'bundle');
  const m = await createExport(f.host, out);
  assert.equal(m.closure.packages.length, 1); assert.equal(m.closure.artifacts.length, 1);
  assert.ok(m.files['state/host.sqlite'] && m.files[`state/artifacts/${m.closure.artifacts[0]}`] && m.files['app/src/host/checker.ts']);
  assert.ok(m.files['app/node_modules/fastify/package.json'] && !Object.keys(m.files).some(p => p.includes('node_modules/typescript')), 'production dependencies only');
  assert.ok(m.licenses.some(l => l.name === 'fastify' && l.license === 'MIT'));
  assert.ok(m.omitted.some(o => o.includes('authentication')));
  assert.deepEqual(verifyExport(out), { ok: true, problems: [] });
  appendFileSync(join(out, 'app', 'packages', 'p0-notebook', 'prompts', 'review.md'), 'tampered');
  writeFileSync(join(out, 'app', 'extra.js'), 'x');
  appendFileSync(join(out, 'app', 'src', 'host', 'checker.ts'), '\n// changed');
  const r = verifyExport(out);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('modified file app/packages/p0-notebook/prompts/review.md'));
  assert.ok(r.problems.includes('unexpected file app/extra.js'));
  assert.ok(r.problems.some(p => p.startsWith('bundled checker source does not match policy')));
});

test('P27: an imported copy gets a fresh identity; approvals, leases, job authority and allowance cannot be replayed', async () => {
  const f = new Fixture().baseline();
  f.ok('request_ai_review', { key: 'ai1', decision: 'd1' });
  f.host.grantAllowance('root-1', 5);
  const fence = f.host.startAttempt(f.host.tasks()[0].id, 'root-1');
  const { id, result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  const out = join(tempDir(), 'bundle');
  await createExport(f.host, out);
  // First launch of the copy through the real CLI entry point (no runtime bundled; uses this Node).
  const cli = spawnSync(process.execPath, [join(out, 'app', 'src', 'host', 'cli.ts'), 'pending', join(out, 'state')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /Imported copy: new instance .*1 agent job\(s\) paused, 1 approval\(s\) require a fresh preview/);
  assert.match(cli.stdout, /ob-r17/); assert.match(cli.stdout, /ob-ai1/);
  const copy = new Host(join(out, 'state'));
  assert.equal(copy.imported, null, 'adoption happened once, on the first open');
  assert.notEqual(copy.instance, f.host.instance);
  assert.equal(copy.proposal(id).status, 'stale');
  assert.match((copy.activate(id) as any).reasons[0], /proposal is stale/);
  const replay = copy.completeReview(fence, approve);
  assert.equal(replay.status, 'rejected', 'the exported lease cannot deliver a result');
  assert.equal(copy.tasks()[0].status, 'reconcile');
  assert.throws(() => copy.startAttempt(copy.tasks()[0].id, 'root-1'), /task_closed|is reconcile/);
  copy.retryTask(copy.tasks()[0].id);
  assert.throws(() => copy.startAttempt(copy.tasks()[0].id, 'root-1'), /allowance root-1 is exhausted/, 'dispatch allowance does not travel with the copy');
  // A receipt carried over from the source instance is refused by the checker even if re-attached.
  copy.db.prepare("UPDATE proposals SET status='approved' WHERE id=?").run(id);
  assert.match((copy.activate(id) as any).reasons.join(), /issued by another Workshop instance/);
  // The source instance is unaffected.
  assert.equal(f.host.proposal(id).status, 'approved');
  rmSync(out, { recursive: true, force: true });
  // A programmatic open (not the CLI) of a fresh export adopts too.
  const out2 = join(tempDir(), 'bundle2');
  await createExport(f.host, out2);
  const direct = new Host(join(out2, 'state'));
  assert.ok(direct.imported); assert.notEqual(direct.instance, f.host.instance);
  assert.equal(direct.proposal(id).status, 'stale');
});
