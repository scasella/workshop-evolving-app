import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { canonical } from '../src/host/canonical.ts';
import { activationCore, checkActivation, Rejection, stateDigest, type ApprovalReceipt, type Obligation } from '../src/host/checker.ts';
import { CHECKER_BINARY, checkerIdentity, rInput, roundTrip, runRChecker } from '../src/host/rcheck.ts';
import { editJson, Fixture, removeFile, tempDir } from './helpers.ts';

const ready = checkerIdentity().problems;
const skip = ready.length ? `R checker not built (${ready.join('; ')}); run npm run r:build` : false;

// A host-shaped activation input for a candidate, without going through propose (so rejected
// candidates can be compared too). Record migration is out of R's scope and is not varied here.
function scenario(f: Fixture, files: Record<string, string>, opts: { approval?: Partial<ApprovalReceipt>; ledger?: (l: Obligation[]) => Obligation[]; hostInterpreters?: string[]; dispositions?: string[] } = {}) {
  const candidate = f.host.storePackage(files);
  const state = f.host.state(f.activeLive); const ledger = f.host.ledger(); const ctx = f.host.ctx(state.id);
  const grant = [...candidate.manifest.capabilities];
  const core = activationCore(state, ledger, ctx, candidate, grant);
  const candidateHash = f.host.candidateHash(candidate, state.id, state.revision, grant);
  const preview = { candidateHash, world: state.id, baseRevision: state.revision, baseDigest: stateDigest(state, ledger), resultDigest: core.resultDigest, witnessDigest: '', previewHash: 'preview-fixture' };
  const approval: ApprovalReceipt = { id: 'appr', owner: 'owner', candidateHash, previewHash: 'preview-fixture', expectedRevision: state.revision, grant,
    dispositions: opts.dispositions ?? [], issuedBy: 'host', instance: f.host.instance, ...opts.approval };
  return () => {
    const now = f.host.state(state.id);
    return { state: now, ledger: opts.ledger ? opts.ledger(f.host.ledger()) : f.host.ledger(), ctx: f.host.ctx(state.id), candidate, candidateHash, preview,
      approval, dispositions: f.host.dispositions(), instance: f.host.instance, hostInterpreters: opts.hostInterpreters };
  };
}
function both(args: ReturnType<ReturnType<typeof scenario>>) {
  let ts: { accept: boolean; rebinds: string[]; reasons?: string[] };
  try {
    const { plan } = checkActivation(args);
    ts = { accept: true, rebinds: plan.ops.filter(o => o.op === 'put_obligation').map(o => { const ob = (o as any).obligation; return `${ob.id}|${ob.continuation.packageHash}|${ob.continuation.action}`; }).sort() };
  } catch (e) { if (!(e instanceof Rejection) && !(e as any).code) throw e; ts = { accept: false, rebinds: [], reasons: (e as any).reasons ?? [(e as Error).message] }; }
  const input = rInput(args);
  const v = runRChecker(input);
  const lean = { accept: v.accept, rebinds: v.accept ? v.rebinds.map(r => `${r.obligation}|${r.packageHash}|${r.action}`).sort() : [] };
  // The serialization boundary: Lean parses and re-emits the same input (absent optionals as null).
  const strip = (x: any): any => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null).map(([k, v]) => [k, strip(v)])) : x;
  assert.equal(canonical(strip(roundTrip(input))), canonical(strip(input)), 'Lean round trip changed the input');
  return { ts, lean };
}

test('R: TypeScript and Lean checkers agree on shared activation fixtures (verdict and exact rebinds)', { skip }, () => {
  const cases: [string, boolean, (f: Fixture) => ReturnType<typeof scenario>][] = [
    ['valid P1, r17 stays pinned', true, f => scenario(f, f.p1Files())],
    ['adapter maps r17 to the candidate', true, f => scenario(f, f.p1Files(undefined, { continuations: { [`${f.p0}:record_review`]: 'record_review' } }))],
    ['adapter to a missing action', false, f => scenario(f, f.p1Files(undefined, { continuations: { [`${f.p0}:record_review`]: 'nope' } }))],
    ['retires the package r17 needs (P14)', false, f => scenario(f, f.p1Files(undefined, { retire: [f.p0] }))],
    ['drops evidence.submit (P35)', false, f => scenario(f, f.p1Files(fs => {
      for (const a of ['record_review', 'request_review', 'request_ai_review', 'request_comparison_review']) removeFile(fs, `actions/${a}.json`);
      editJson(fs, 'planner.json', p => ({ rules: p.rules.filter((r: any) => !r.suggest.action.startsWith('request_')) }));
      removeFile(fs, 'tests/comparison-flow.json');
    }, { capabilities: ['records.write', 'relations.write', 'decisions.draft'] }))],
    ['interpreter no longer supported', false, f => scenario(f, f.p1Files(), { hostInterpreters: ['workshop-lang/2'] })],
    ['referenced artifact missing (P14)', false, f => scenario(f, f.p1Files(), { ledger: l => l.map(o => o.id === 'ob-r17' ? { ...o, artifacts: ['a'.repeat(64)] } : o) })],
    ['approval from another instance (P27)', false, f => scenario(f, f.p1Files(), { approval: { instance: 'someone-else' } })],
    ['approval not issued by the host (P05)', false, f => scenario(f, f.p1Files(), { approval: { issuedBy: 'candidate' as any } })],
    ['approval names another candidate (P19)', false, f => scenario(f, f.p1Files(), { approval: { candidateHash: 'f'.repeat(64) } })],
    ['approval references an uncommitted disposition (P37)', false, f => scenario(f, f.p1Files(), { dispositions: ['disp-nope'] })],
  ];
  for (const [name, expected, make] of cases) {
    const f = new Fixture().baseline();
    const { ts, lean } = both(make(f)());
    assert.equal(ts.accept, expected, `${name}: TS ${JSON.stringify(ts.reasons)}`);
    assert.deepEqual(lean, { accept: ts.accept, rebinds: ts.rebinds }, name);
  }
  // Stale base (P20): the live world changes after the preview.
  const f = new Fixture().baseline();
  const later = scenario(f, f.p1Files());
  f.ok('add_note', { id: 'late', title: 'after preview' });
  const stale = both(later());
  assert.deepEqual([stale.ts.accept, stale.lean.accept], [false, false]);
  // Committed disposition referenced by the approval (P37), then the same with its target altered.
  const g = new Fixture().baseline();
  g.ok('request_review', { key: 'r18', decision: 'd1' });
  g.host.dispose('d', 'project', g.revision, 'ob-r17', 'supersede', 'Covered by r18', 'ob-r18');
  const disp = g.host.dispositions()[0];
  const ok = both(scenario(g, g.p1Files(), { dispositions: [disp.id] })());
  assert.deepEqual([ok.ts.accept, ok.lean.accept], [true, true]);
  g.host.db.prepare('UPDATE dispositions SET data=? WHERE id=?').run(JSON.stringify({ ...disp, successor: 'ob-other' }), disp.id);
  const altered = both(scenario(g, g.p1Files(fs => { fs['prompts/review.md'] += ' '; }), { dispositions: [disp.id] })());
  assert.deepEqual([altered.ts.accept, altered.lean.accept], [false, false]);
  // A live obligation retained in another branch still pins its package (restore case).
  const r = new Fixture().baseline();
  r.evolve(r.p1Files());
  const snap = (r.host.worlds() as any[]).find(w => w.kind === 'recovery').id;
  r.ok('request_review', { key: 'late', decision: 'd1' });
  const lateHash = r.host.ledger().find(o => o.id === 'ob-late')!.continuation.packageHash;
  r.host.restore('restore', snap);
  const branchRetire = both(scenario(r, { ...r.host.pkg(r.p0)!.files, 'package.json': JSON.stringify({ ...JSON.parse(r.host.pkg(r.p0)!.files['package.json']), parent: r.p0, version: 9, retire: [lateHash] }) })());
  assert.deepEqual([branchRetire.ts.accept, branchRetire.lean.accept], [false, false]);
});

test('R mode: activation requires the Lean checker and applies exactly its rebinds', { skip }, () => {
  const f = new Fixture(tempDir(), { assurance: 'R' }).baseline();
  const id = f.evolve(f.p1Files(undefined, { continuations: { [`${f.p0}:record_review`]: 'record_review' } }));
  const p1 = f.host.proposal(id).packageHash!;
  const ob = f.host.ledger().find(o => o.id === 'ob-r17')!;
  assert.deepEqual(ob.continuation, { packageHash: p1, action: 'record_review', interpreter: 'workshop-lang/1' });
  const event = f.host.db.prepare("SELECT data FROM events WHERE kind='package_activated'").get() as any;
  assert.match(String(event.data), /R checker [0-9a-f]{12} accepted; 1 rebind\(s\) applied exactly/);
  f.ok('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'through the adapter route' });
  // The checker identity is part of the approved candidate.
  const p = f.host.proposal(id);
  assert.notEqual(new Fixture().host.candidateHash(f.host.pkg(p1)!, 'project', p.preview!.baseRevision, p.report.capabilities.after), p.candidateHash);
});

test('R02: a missing or altered checker binary fails closed and names it', { skip }, () => {
  const missing = join(tempDir(), 'workshop-checker');
  const f = new Fixture(tempDir(), { assurance: 'R', checkerBinary: missing }).baseline();
  const { id, result } = f.propose(f.p1Files());
  assert.equal(result.status, 'previewable');
  f.host.approve(id, { previewHash: result.preview.previewHash, candidateHash: result.preview.candidateHash });
  const r = f.host.activate(id);
  assert.equal(r.status, 'rejected'); assert.ok((r as any).reasons.some((x: string) => x.includes(`R mode fails closed: checker binary missing at ${missing}`)));
  assert.equal(f.host.world('project').packageHash, f.p0);
  const altered = join(tempDir(), 'workshop-checker');
  copyFileSync(CHECKER_BINARY, altered); appendFileSync(altered, Buffer.from([0]));
  const g = new Fixture(tempDir(), { assurance: 'R', checkerBinary: altered }).baseline();
  const q = g.propose(g.p1Files());
  assert.equal(q.result.status, 'previewable');
  if (q.result.status !== 'previewable') return;
  g.host.approve(q.id, { previewHash: q.result.preview.previewHash, candidateHash: q.result.preview.candidateHash });
  assert.match((g.host.activate(q.id) as any).reasons.join(), /does not match the locked build/);
});

test('R01 guards: a weakened contract, a sorry, or an axiom declaration fails the proof build', { skip }, () => {
  const src = new URL('../lean', import.meta.url).pathname;
  const run = (mutate: (dir: string) => void) => {
    const dir = join(tempDir(), 'lean');
    cpSync(src, dir, { recursive: true, filter: p => !p.includes('/.lake') });
    mutate(dir);
    return spawnSync(process.execPath, [new URL('../scripts/r-build.ts', import.meta.url).pathname], { env: { ...process.env, WORKSHOP_LEAN_DIR: dir }, encoding: 'utf8' });
  };
  const weaken = run(d => { const f = join(d, 'WorkshopChecker', 'Contract.lean'); writeFileSync(f, readFileSync(f, 'utf8').replace('Route i o ∧ (∀ x ∈ o.artifacts', 'True ∧ (∀ x ∈ o.artifacts')); });
  assert.notEqual(weaken.status, 0); assert.match(weaken.stderr, /Contract.lean changed/);
  const sorry = run(d => { const f = join(d, 'WorkshopChecker', 'Theorems.lean'); writeFileSync(f, readFileSync(f, 'utf8').replace('theorem owner_approval : OwnerApproval := by', 'theorem owner_approval : OwnerApproval := by\n  sorry\ntheorem owner_approval_unused : OwnerApproval := by')); });
  assert.notEqual(sorry.status, 0); assert.match(sorry.stderr, /contains sorry, admit or an axiom declaration/);
  const restated = run(d => { const f = join(d, 'WorkshopChecker', 'Theorems.lean'); writeFileSync(f, readFileSync(f, 'utf8').replace('theorem keeps_identity_and_rule : KeepsIdentityAndRule := by', 'theorem keeps_identity_and_rule : True := trivial\ntheorem keeps_identity_and_rule_orig : KeepsIdentityAndRule := by')); });
  assert.notEqual(restated.status, 0, 'a theorem restated with a weaker type must fail the audit');
  const axiom = run(d => { const f = join(d, 'WorkshopChecker', 'Check.lean'); writeFileSync(f, readFileSync(f, 'utf8').replace('namespace Workshop', 'namespace Workshop\naxiom cheat : False')); });
  assert.notEqual(axiom.status, 0); assert.match(axiom.stderr, /axiom declaration/);
});
