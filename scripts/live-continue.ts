import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexReviewer, type CallReceipt } from '../src/host/local-codex.ts';
import { runQueued } from '../src/host/runner.ts';
import { Host } from '../src/host/store.ts';

// PAID (not an npm script): the owner-directed continuation of the 2026-09-27 live run, kept for the record.
// Continues the live host after the reviewers requested changes: the (demo) owner addresses
// their feedback, requests another review of each open job review, and finalizes only if the
// live reviewers now approve. Nothing is overridden.
const MODEL = process.env.WORKSHOP_MODEL ?? 'gpt-6-astra';
const root = resolve(new URL('..', import.meta.url).pathname);
const host = new Host(join(root, '.workshop', 'live-host'));
const receipts: CallReceipt[] = [];
const log: { step: string; data?: unknown }[] = [];
const step = (s: string, data?: unknown) => { log.push({ step: s, data }); console.log(`• ${s} ${JSON.stringify(data ?? '').slice(0, 400)}`); };
let n = 0;
const must = (actionId: string, input: Record<string, any>, packageHash?: string) => {
  const w = host.world('project');
  const o = host.run({ operationId: `cont-${Date.now()}-${++n}`, worldId: 'project', expectedRevision: w.revision, packageHash: packageHash ?? w.packageHash, capabilityRef: 'cap-owner-project', actionId, input });
  if (o.status !== 'committed') throw new Error(`${actionId}: ${o.reasons.join('; ')}`);
};
host.reconcileAttempts();
const round = process.env.WORKSHOP_ROUND ?? '1';
if (round === '1') {
// Requirements the reviewers asked for, as explicit criteria (owner-entered demo data).
must('add_criterion', { id: 'req-throughput', title: 'Requirement: sustain 30k rows/s with 16 concurrent writers', weight: 5 });
must('add_criterion', { id: 'req-ops', title: 'Requirement: operable by one engineer, no dedicated DBA', weight: 4 });
must('add_criterion', { id: 'req-durability', title: 'Requirement: no data loss on node failure (year 1: nightly backup + WAL shipping is acceptable)', weight: 2 });
for (const [a, c, sc] of [['sqlite', 'req-throughput', 6], ['sqlite', 'req-ops', 10], ['sqlite', 'req-durability', 6], ['postgres', 'req-throughput', 7], ['postgres', 'req-ops', 4],
  ['postgres', 'req-durability', 9], ['duckdb', 'req-throughput', 8], ['duckdb', 'req-ops', 9], ['duckdb', 'req-durability', 5]] as const) must('score', { alternative: a, criterion: c, score: sc });
must('attach_evidence', { id: 'ev5', alternative: 'sqlite', title: 'Protocol A (8 vCPU/32 GB NVMe, 1 KiB rows, fsync on, 3x10 min): 16 writers funneled to 1 = 31k rows/s median (29-32k), p99 190 ms', kind: 'measurement', stance: 'for', basis: 'measured' });
must('attach_evidence', { id: 'ev6', alternative: 'postgres', title: 'Protocol A, Postgres 16, synchronous replica: 25k rows/s median (24-26k), p99 60 ms; async replica 36k rows/s', kind: 'measurement', stance: 'against', basis: 'measured' });
must('attach_evidence', { id: 'ev7', alternative: 'duckdb', title: 'Protocol A, DuckDB 1.1 appender, single process: 52k rows/s median (49-55k), p99 240 ms; no concurrent external writers', kind: 'measurement', stance: 'for', basis: 'measured' });
must('add_assumption', { id: 'as2', alternative: 'duckdb', statement: 'All writers can be routed through one ingest process', confidence: 3 });
step('Owner addressed reviewer feedback: requirements as criteria, measured results with protocol and variance');
} else {
// Round 2: reconcile scores with the measurements (the reviewers' finding) and add the
// durability, failure-recovery and writer-routing evidence they asked for (demo data).
for (const [a, c, sc] of [['sqlite', 'throughput', 7], ['postgres', 'throughput', 6], ['duckdb', 'throughput', 9],
  ['sqlite', 'req-throughput', 6], ['postgres', 'req-throughput', 4], ['duckdb', 'req-throughput', 9]] as const) must('score', { alternative: a, criterion: c, score: sc });
must('attach_evidence', { id: 'ev8', alternative: 'sqlite', title: 'Recovery drill: kill -9 during Protocol A, WAL replay 4 s, 0 rows lost; restore from nightly backup + WAL archive in 11 min on a fresh node', kind: 'measurement', stance: 'for', basis: 'measured' });
must('attach_evidence', { id: 'ev9', alternative: 'postgres', title: 'Failover drill: primary killed, sync replica promoted in 9 s, 0 rows lost; needs Patroni + on-call we do not have (1 engineer)', kind: 'measurement', stance: 'against', basis: 'measured' });
must('attach_evidence', { id: 'ev10', alternative: 'duckdb', title: 'Recovery drill: process killed mid-append, last 2 s of rows lost without an external queue; routing 16 writers via one process adds 35 ms p99', kind: 'measurement', stance: 'against', basis: 'measured' });
must('attach_evidence', { id: 'ev11', alternative: 'sqlite', title: 'Protocol A run twice more on a second host: 30.5k and 31.8k rows/s median; scripts and configs checked into ops/bench', kind: 'measurement', stance: 'for', basis: 'measured' });
must('add_assumption', { id: 'as3', alternative: 'sqlite', statement: 'Ingest volume stays under 30k rows/s sustained for year 1 (current peak 18k)', confidence: 4 });
step('Owner round 2: scores reconciled with measurements; recovery, failover and routing drills recorded');
}
const again = host.pendingWork().filter(o => o.world === 'project' && o.policy.discharge === 'job').map(o => host.requestAnotherReview(o.id));
step('Requested another review of each open job review', again);
const r = await runQueued(host, codexReviewer(MODEL, receipts), { root: 'live-demo', concurrency: 2 });
const verdicts = host.ledger().filter(o => ['ob-ai-early', 'ob-final-method', 'ob-final-risk'].includes(o.id))
  .map(o => ({ id: o.id, status: o.status, last: (host.db.prepare('SELECT data FROM evidence WHERE obligation=? ORDER BY seq DESC LIMIT 1').get(o.id) as any)?.data }))
  .map(v => ({ ...v, last: v.last ? JSON.parse(v.last).note : null }));
step('Live re-reviews', { results: r.results, peak: r.peakConcurrency, verdicts });
let final: unknown = null;
if (!host.pendingWork().some(o => o.world === 'project' && o.policy.discharge === 'job')) {
  for (const o of host.pendingWork().filter(o => o.world === 'project' && o.policy.discharge === 'owner'))
    must(o.continuation.action, host.continuationInput(o, 'approve', 'Owner confirmation after the independent reviews', null), o.continuation.packageHash);
  const s = host.state('project');
  const weights = new Map([...s.records.values()].filter(x => x.type === 'criterion').map(x => [x.id, Number(x.data.weight ?? 1)]));
  const totals = s.decisions.get('d1')!.subjects.map(id => [id, [...s.relations.values()].filter(x => x.from === id && weights.has(x.to))
    .reduce((t, x) => t + Number(Object.values(x.data).find(v => typeof v === 'number') ?? 0) * weights.get(x.to)!, 0)] as const).sort((a, b) => b[1] - a[1]);
  final = { totals, outcome: host.finalize(`fin-${Date.now()}`, 'project', host.world('project').revision, 'd1', totals[0][0]), decision: host.state('project').decisions.get('d1') };
  step('Decision', final);
} else step('Still blocked: a live reviewer requested changes again (reported as-is)', host.pendingWork().map(o => o.id));
writeFileSync(join(root, 'evidence', `live-demo-continue-${round}.json`), JSON.stringify({ kind: 'LIVE continuation: owner addresses reviewer feedback (demo data), live re-reviews', model: MODEL,
  allowance: host.allowance('live-demo'), steps: log, reviewReceipts: receipts }, null, 2) + '\n');
host.close();
