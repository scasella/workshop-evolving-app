import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, parseCanonicalJson } from '../src/host/canonical.ts';
import { Budget, evaluate, evaluateAction, parsePackage } from '../src/host/lang.ts';
import { readPackageDir } from '../src/host/package-dir.ts';
import { addFile, editJson, Fixture, P0_DIR } from './helpers.ts';

const p0 = () => readPackageDir(P0_DIR);
const rejects = (files: Record<string, string>, pattern: RegExp) => assert.throws(() => parsePackage(files), pattern);

test('P04: raw code, SQL, dependency hooks and HTML views are rejected before any execution', () => {
  rejects({ ...p0(), 'hooks/postinstall.sh': 'curl x | sh' }, /rejected path/);
  const withScripts = p0(); editJson(withScripts, 'package.json', m => ({ ...m, scripts: { postinstall: 'node x.js' } }));
  rejects(withScripts, /unsupported key "scripts"/);
  const withDeps = p0(); editJson(withDeps, 'package.json', m => ({ ...m, dependencies: { leftpad: '*' } }));
  rejects(withDeps, /unsupported key "dependencies"/);
  const sql = p0(); editJson(sql, 'actions/add_note.json', a => ({ ...a, effects: [{ sql: 'DELETE FROM obligations' }] }));
  rejects(sql, /unsupported effect "sql"/);
  const js = p0(); editJson(js, 'actions/add_note.json', a => ({ ...a, requires: [{ when: { js: 'process.exit()' }, reason: 'x' }] }));
  rejects(js, /unsupported operator "js"/);
  const html = p0(); editJson(html, 'views/notes.json', v => ({ ...v, kind: 'html', html: '<script>alert(1)</script>' }));
  rejects(html, /unsupported view kind "html"/);
  const scriptFile = p0(); addFile(scriptFile, 'actions/evil.js', 'module.exports = 1');
  rejects(scriptFile, /rejected path/);
});

test('P28: traversal, nested, undeclared, oversized and duplicate-key package files are rejected', () => {
  rejects({ ...p0(), '../host/store.ts': 'x' }, /rejected path/);
  rejects({ ...p0(), 'actions/../../escape.json': '{}' }, /rejected path/);
  rejects({ ...p0(), 'actions/nested/x.json': '{}' }, /rejected path/);
  rejects({ ...p0(), 'actions/undeclared.json': '{}' }, /manifest file list/);
  const big = p0(); addFile(big, 'prompts/big.md', 'x'.repeat(70 * 1024)); rejects(big, /exceeds/);
  const dup = p0(); dup['actions/add_note.json'] = dup['actions/add_note.json'].replace('"id": "add_note",', '"id": "add_note", "id": "record_review",');
  rejects(dup, /duplicate key/);
  const missing = p0(); delete missing['views/notes.json']; rejects(missing, /manifest file list/);
});

test('P05: a candidate cannot carry host code, approval files, or approval effects', () => {
  rejects({ ...p0(), 'approved.json': '{"approved":true}' }, /rejected path/);
  rejects({ ...p0(), 'checker.ts': 'export const ok = true' }, /rejected path/);
  const approve = p0(); editJson(approve, 'actions/add_note.json', a => ({ ...a, effects: [{ approve: { proposal: 'x' } }] }));
  rejects(approve, /unsupported effect "approve"/);
  const finalize = p0(); editJson(finalize, 'actions/add_note.json', a => ({ ...a, effects: [{ finalize: { decision: 'd1' } }] }));
  rejects(finalize, /unsupported effect "finalize"/);
  const grant = p0(); editJson(grant, 'package.json', m => ({ ...m, capabilities: [...m.capabilities, 'network.fetch'] }));
  rejects(grant, /unknown capability network.fetch/);
  const undeclared = p0(); editJson(undeclared, 'package.json', m => ({ ...m, capabilities: m.capabilities.filter((c: string) => c !== 'obligations.open') }));
  rejects(undeclared, /requires undeclared capability obligations.open/);
});

test('package language: bounded AST depth, integer-only numbers, typed errors instead of coercion', () => {
  let deep: any = { lit: 1 };
  for (let i = 0; i < 30; i++) deep = { not: deep };
  const d = p0(); editJson(d, 'actions/add_note.json', a => ({ ...a, requires: [{ when: deep, reason: 'x' }] }));
  rejects(d, /AST depth/);
  assert.throws(() => parseCanonicalJson('{"x": 1.5}'), /safe integers/);
  assert.throws(() => canonical({ x: undefined }), /undefined/);
  const world = { records: new Map(), relations: new Map(), obligations: [], decisions: new Map(), subjectDigest: () => '' };
  const env = { world, inputs: {}, vars: new Map(), budget: new Budget() };
  assert.throws(() => evaluate({ add: [{ lit: 1 }, { lit: 'a' }] }, env), /expected integer/);
  assert.throws(() => evaluate({ div: [{ lit: 1 }, { lit: 0 }] }, env), /division by zero/);
  assert.throws(() => evaluate({ mul: [{ lit: Number.MAX_SAFE_INTEGER }, { lit: 2 }] }, env), /overflow/);
  assert.throws(() => evaluate({ eq: [{ lit: 1 }, { lit: '1' }] }, env), /types differ/);
});

test('P03: an action that exhausts its evaluation budget commits nothing and the host stays responsive', () => {
  const f = new Fixture();
  for (let i = 0; i < 30; i++) f.ok('add_note', { id: `n${i}`, title: `note ${i}` });
  const pkg = f.host.pkg(f.p0)!;
  const state = f.host.state('project');
  const view = { records: state.records, relations: state.relations, obligations: [], decisions: state.decisions, subjectDigest: () => '' };
  // Nested traversal over 30 records, evaluated with a deliberately small budget.
  const heavy = { count: { list: { records: 'note' }, as: 'a', where: { all: { list: { records: 'note' }, as: 'b', where: { ne: [{ get: [{ var: 'a' }, 'id'] }, { lit: '' }] } } } } };
  assert.throws(() => evaluate(heavy, { world: view, inputs: {}, vars: new Map(), budget: new Budget(500) }), /exceeded 500 steps/);
  const before = f.revision;
  const r = evaluateAction(pkg, 'add_note', { id: 'x', title: 'y' }, view, new Budget(2));
  assert.equal(r.ok, false); assert.match((r as any).reason, /steps/);
  assert.equal(f.revision, before);
  f.ok('add_note', { id: 'after', title: 'host still responsive' });
});

test('P08: duplicate command returns the recorded outcome; reuse with a different payload is rejected', () => {
  const f = new Fixture();
  const env = { operationId: 'dup-1', worldId: 'project', expectedRevision: 0, packageHash: f.p0, capabilityRef: 'cap-owner-project', actionId: 'add_note', input: { id: 'n1', title: 'once' } };
  const first = f.host.run(env);
  assert.equal(first.status, 'committed');
  assert.deepEqual(f.host.run(env), first);
  assert.equal(f.revision, 1);
  const mismatch = f.host.run({ ...env, input: { id: 'n1', title: 'different' } });
  assert.equal(mismatch.status, 'rejected'); assert.equal((mismatch as any).code, 'operation_mismatch');
  assert.equal(f.host.state('project').records.get('n1')!.data.title, 'once');
});

test('C5: the principal is attached by the host; forged capability references and package hashes are refused', () => {
  const f = new Fixture().baseline();
  const base = { worldId: 'project', packageHash: f.p0, actionId: 'record_review', input: { obligation: 'ob-r17', verdict: 'approve', note: 'self-approved' } };
  // A job principal cannot use the owner's root capability.
  const forged = f.host.run({ ...base, operationId: 'forge-1', expectedRevision: f.revision, capabilityRef: 'cap-owner-project' }, 'job:fake');
  assert.equal(forged.status, 'rejected'); assert.match((forged as any).reasons[0], /capability reference/);
  const unknown = f.host.run({ ...base, operationId: 'forge-2', expectedRevision: f.revision, capabilityRef: 'cap-root-everything' });
  assert.equal(unknown.status, 'rejected');
  const otherPkg = f.host.run({ ...base, operationId: 'forge-3', expectedRevision: f.revision, capabilityRef: 'cap-owner-project', packageHash: 'f'.repeat(64) });
  assert.equal(otherPkg.status, 'rejected'); assert.match((otherPkg as any).reasons[0], /neither active nor a pinned continuation/);
  assert.equal(f.host.ledger().find(o => o.id === 'ob-r17')!.status, 'open');
});

test('P06 (package route): no expression can name another world, a file, the environment or the network', () => {
  const probe = (when: unknown) => { const d = p0(); editJson(d, 'actions/add_note.json', a => ({ ...a, requires: [{ when, reason: 'x' }] })); return d; };
  rejects(probe({ records: { type: 'note', world: 'other' } }), /invalid identifier/);
  rejects(probe({ related: { relation: 'x', world: 'other' } }), /unsupported key "world"|unknown relation/);
  for (const op of ['env', 'file', 'fetch', 'now', 'random', 'import', 'eval'])
    rejects(probe({ [op]: 'x' }), new RegExp(`unsupported operator "${op}"`));
  // Two practice worlds cannot see each other's rehearsal data.
  const f = new Fixture().baseline();
  const a = f.propose(f.p1Files()); const b = f.propose(f.p1Files());
  assert.equal(a.result.status, 'previewable'); assert.equal(b.result.status, 'previewable');
  f.ok('add_note', { id: 'only-in-a', title: 'practice A' }, { world: a.result.practiceWorld });
  assert.ok(!f.host.state(b.result.practiceWorld).records.has('only-in-a'));
  assert.ok(!JSON.stringify(f.host.project(b.result.practiceWorld).views).includes('practice A'));
  const cross = f.act('edit_alternative', { id: 'only-in-a', summary: 'x' }, { world: b.result.practiceWorld });
  assert.equal(cross.status, 'rejected');
});
