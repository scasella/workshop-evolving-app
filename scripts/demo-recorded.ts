import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthorJournal } from '../src/authoring.ts';
import { authorAndPropose, diffEdits, recordedTransport } from '../src/host/evolve.ts';
import { createExport, verifyExport } from '../src/host/export.ts';
import { readPackageDir } from '../src/host/package-dir.ts';
import { recoveryReport } from '../src/host/recovery.ts';
import { runQueued, simulatedReviewer } from '../src/host/runner.ts';
import { Host } from '../src/host/store.ts';

// The demonstration story (docs/DESIGN.md), DETERMINISTIC variant. Model responses are recorded
// successor packages replayed through the real pinned Linux Codex CLI, the
// response firewall and the author journal; review jobs use the labelled
// simulated reviewer. Nothing here is a live model run or claims to be one.
const root = resolve(new URL('..', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'workshop-demo-'));
const log: { step: string; result: unknown }[] = [];
const note = (step: string, result: unknown) => { log.push({ step, result }); console.log(`• ${step}`); };
let host = new Host(dir);
const journal = new AuthorJournal(join(dir, 'author-journal.sqlite'));
let n = 0;
const act = (actionId: string, input: Record<string, any>, packageHash?: string, world = 'project') => {
  const w = host.world(world);
  const o = host.run({ operationId: `demo-${++n}`, worldId: world, expectedRevision: w.revision, packageHash: packageHash ?? w.packageHash, capabilityRef: 'cap-owner-project', actionId, input });
  assert.equal(o.status, 'committed', `${actionId}: ${JSON.stringify(o)}`);
  return o;
};
const dirFiles = (d: string) => readPackageDir(join(root, 'packages', d));

// P0 — project notebook with an explicit unresolved review and a bounded agent job.
const p0 = host.createProject('project', dirFiles('p0-notebook'));
act('add_note', { id: 'n1', title: 'Pick a storage engine for ingest', body: 'Needs an independent review before we commit.' });
act('add_alternative', { id: 'sqlite', title: 'SQLite', summary: 'Embedded, zero-ops' });
act('add_alternative', { id: 'postgres', title: 'Postgres', summary: 'Server with replication' });
act('start_decision', { id: 'd1', question: 'Which storage engine?' });
act('request_review', { key: 'r17', decision: 'd1' });
act('request_ai_review', { key: 'ai-early', decision: 'd1' });
host.grantAllowance('root-p0', 1);
const early = await runQueued(host, simulatedReviewer, { root: 'root-p0' });
host.close(); host = new Host(dir);
note('P0 notebook: two alternatives, open review r17, one bounded review job committed (SIMULATED reviewer); host restarted', {
  job: early.results, pending: host.pendingWork().map(o => o.id), epochAfterRestart: host.epoch, notRerun: (await runQueued(host, simulatedReviewer, { root: 'root-p0' })).results.length === 0 });

// P1 — authored through Change this. First a faulty candidate that strands r17, then the corrected one.
host.grantAllowance('evolve-p1', 2);
const p1Edits = diffEdits(host.pkg(p0)!.files, dirFiles('p1-comparison'));
const faulty = p1Edits.map(e => e.path === 'package.json' ? { ...e, content: JSON.stringify({ ...JSON.parse(e.content), retire: [p0] }) } : e);
const bad = await authorAndPropose(host, { world: 'project', request: 'Turn this project into a comparison workspace (faulty draft)', proposalId: 'p1-faulty',
  model: 'gpt-6-astra', mode: { kind: 'recorded', transport: recordedTransport(faulty) }, rootId: 'evolve-p1', journal });
assert.equal(bad.proposal?.status, 'rejected');
note('Faulty P1 (retires the package r17 continues through) authored via the real CLI with a RECORDED response, then rejected', { author: bad.receipt, reasons: bad.reasons });
const good = await authorAndPropose(host, { world: 'project', request: 'Turn this project into a comparison workspace. Let me compare candidates against explicit criteria, attach evidence, record a decision, and keep every unresolved review requirement.',
  proposalId: 'p1', model: 'gpt-6-astra', mode: { kind: 'recorded', transport: recordedTransport(p1Edits) }, rootId: 'evolve-p1', journal });
assert.equal(good.proposal?.status, 'previewable', JSON.stringify(good.reasons));
const p1prev = (good.proposal as any).preview;
act('add_criterion', { id: 'practice-only', title: 'Practice criterion', weight: 1 }, undefined, (good.proposal as any).practiceWorld);
host.approve('p1', { previewHash: p1prev.previewHash, candidateHash: p1prev.candidateHash });
assert.equal(host.activate('p1').status, 'committed');
act('record_review', { obligation: 'ob-r17', verdict: 'changes_requested', note: 'Need measured results first' }, p0);
note('P1 applied after practice (practice edit not applied live); r17 continued through its pinned P0 route', {
  author: good.receipt, packageTests: (good.proposal as any).report.supplementalTests, practiceLeak: host.state('project').records.has('practice-only'), r17: host.ledger().find(o => o.id === 'ob-r17')!.status });

act('add_criterion', { id: 'ops', title: 'Operational cost', weight: 3 });
act('add_criterion', { id: 'scale', title: 'Write throughput', weight: 2 });
for (const [a, c, s] of [['sqlite', 'ops', 9], ['sqlite', 'scale', 5], ['postgres', 'ops', 5], ['postgres', 'scale', 8]] as const) act('score', { alternative: a, criterion: c, score: s });
act('attach_evidence', { id: 'ev1', alternative: 'sqlite', title: 'Ingest load test: 40k rows/s', kind: 'measurement', stance: 'for' });
act('attach_evidence', { id: 'ev2', alternative: 'postgres', title: 'Vendor replication claims', kind: 'citation', stance: 'for' });

// P2 — authored from within P1. During its preview the live review state changes: stale, refresh, re-approve.
host.grantAllowance('evolve-p2', 1);
const p2 = await authorAndPropose(host, { world: 'project', request: 'Add a third option. Separate measured results from assumptions, and run the independent reviews in parallel without letting me finalize before both are complete.',
  proposalId: 'p2', model: 'gpt-6-astra', mode: { kind: 'recorded', transport: recordedTransport(diffEdits(host.pkg(host.world('project').packageHash)!.files, dirFiles('p2-evidence'))) }, rootId: 'evolve-p2', journal });
assert.equal(p2.proposal?.status, 'previewable', JSON.stringify(p2.reasons));
host.approve('p2', { previewHash: (p2.proposal as any).preview.previewHash, candidateHash: (p2.proposal as any).preview.candidateHash });
act('record_review', { obligation: 'ob-r17', verdict: 'approve', note: 'Load test is convincing' }, p0);
const stale = host.activate('p2');
assert.equal(stale.status, 'rejected');
const fresh = host.refresh('p2', 'p2-refresh');
assert.equal(fresh.status, 'previewable');
host.approve('p2-refresh', { previewHash: fresh.preview.previewHash, candidateHash: fresh.preview.candidateHash });
assert.equal(host.activate('p2-refresh').status, 'committed');
note('P2 authored via RECORDED response; live review changed during preview → stale → refreshed → applied', { author: p2.receipt, stale: (stale as any).reasons, basis: { ev1: host.state('project').records.get('ev1')!.data.basis, ev2: host.state('project').records.get('ev2')!.data.basis } });

act('add_alternative', { id: 'duckdb', title: 'DuckDB', summary: 'Embedded analytics' });
act('score', { alternative: 'duckdb', criterion: 'ops', score: 8 }); act('score', { alternative: 'duckdb', criterion: 'scale', score: 6 });
act('attach_evidence', { id: 'ev3', alternative: 'postgres', title: 'Replica benchmark', kind: 'measurement', stance: 'against', basis: 'measured' });
act('attach_evidence', { id: 'ev4', alternative: 'duckdb', title: 'Columnar ingest test', kind: 'measurement', stance: 'for', basis: 'measured' });
act('add_assumption', { id: 'as1', alternative: 'postgres', statement: 'Ops team can run replication', confidence: 2 });
act('request_parallel_reviews', { key: 'final', decision: 'd1' });
const blocked = host.finalize('fin-early', 'project', host.world('project').revision, 'd1', 'sqlite');
assert.equal(blocked.status, 'rejected');
// Redrafting the decision to three options reopened earlier reviews: agent re-reviews are queued, owner re-reviews wait for the owner.
host.grantAllowance('root-p2', 4);
const reviews = await runQueued(host, simulatedReviewer, { root: 'root-p2', concurrency: 2 });
for (const o of host.pendingWork().filter(o => o.world === 'project' && o.policy.discharge === 'owner'))
  act(o.continuation.action, host.continuationInput(o, 'approve', 'Owner re-review of the three options', null), o.continuation.packageHash);
const final = host.finalize('fin', 'project', host.world('project').revision, 'd1', 'sqlite');
assert.equal(final.status, 'committed');
note('Third option, measured vs assumed, two parallel independent reviews (SIMULATED); finalize blocked until both complete, then final', { blocked: (blocked as any).reasons, reviews, final: host.state('project').decisions.get('d1') });

// Break the application, recover independently, repair, export, verify.
const active = host.world('project').packageHash;
const goodBytes = { ...host.pkg(active)!.files };
host.db.prepare("UPDATE packages SET files=replace(files, 'Measured results', 'Mangled results') WHERE hash=?").run(active);
host.close(); host = new Host(dir);
const broken = { packageAvailable: !!host.pkg(active), recovery: recoveryReport(host).broken, pending: recoveryReport(host).pending.length };
host.repairPackage(goodBytes);
note('Active package corrupted: recovery still lists state and broken reference; repaired from hash-verified source', { broken, repaired: !!host.pkg(active) });
const bundle = join(dir, 'export');
const manifest = await createExport(host, bundle);
note('Exported and verified', { verify: verifyExport(bundle), packages: manifest.closure.packages.length, artifacts: manifest.closure.artifacts.length });

const evidence = { observedAt: new Date().toISOString(), kind: 'DETERMINISTIC demonstration (recorded author responses through the real Codex CLI; simulated reviewer). Not the live P29 run.', dir: '<tmp>', steps: log };
writeFileSync(join(root, 'evidence', 'demo-recorded.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log('Deterministic demonstration completed; evidence/demo-recorded.json written.');
