import type { Json } from './canonical.ts';
import type { Host } from './store.ts';

// Review job runner: dispatches queued review tasks of the active live branch,
// at most `concurrency` at once, each under a fenced attempt that reserved one
// unit of the shared root allowance. Results enter only through completeReview.
export type ReviewBundle = { task: string; obligation: { id: string; title: string; verdicts: string[] }; prompt: string;
  subjects: { id: string; type: string; data: Record<string, Json> }[]; relations: { relation: string; from: string; to: string; data: Record<string, Json> }[];
  related: { id: string; type: string; data: Record<string, Json> }[]; decision: { id: string; question: string; options: string[] } | null };
export type ReviewResult = { verdict: string; note: string; report: string };
export type Reviewer = { kind: 'simulated' | 'codex'; review: (bundle: ReviewBundle, signal: AbortSignal) => Promise<ReviewResult> };

// Deterministic fixture reviewer. Its output is labelled as simulated everywhere it is stored.
export const simulatedReviewer: Reviewer = {
  kind: 'simulated',
  async review(bundle) {
    const note = `SIMULATED review (fixture, not a model) of ${bundle.subjects.length} subject(s) for ${bundle.obligation.id}`;
    return { verdict: bundle.obligation.verdicts[0], note, report: `# Simulated review\n\n${note}\n\nSubjects: ${bundle.subjects.map(s => s.id).join(', ')}\n` };
  }
};

export function reviewBundle(host: Host, taskId: string): ReviewBundle {
  const task = host.tasks().find(t => t.id === taskId)!;
  const ob = host.ledger().find(o => o.id === task.obligation)!;
  const pkg = host.pkg(ob.continuation.packageHash);
  const state = host.state(ob.world);
  // Minimum relevant context: the subjects as projected by the obligation's own package.
  const project = (fields: Record<string, unknown> | undefined, data: Record<string, Json>) =>
    Object.fromEntries(Object.entries(data).filter(([k]) => !fields || k in fields));
  // Plus one hop: the records at the other end of those relations (evidence, criteria,
  // assumptions), in the active package's current meaning, and the decision being gated.
  // A live review found that subjects alone left reviewers unable to see the evidence.
  const relations = [...state.relations.values()].filter(r => ob.subjects.includes(r.from) || ob.subjects.includes(r.to));
  const active = host.pkg(state.packageHash);
  const relatedIds = [...new Set(relations.flatMap(r => [r.from, r.to]))].filter(id => !ob.subjects.includes(id)).sort();
  const d = ob.gate ? state.decisions.get(ob.gate) : undefined;
  return {
    task: task.id, obligation: { id: ob.id, title: ob.title, verdicts: ob.policy.verdicts },
    prompt: host.pkg(task.packageHash)?.files[`prompts/${task.prompt}.md`] ?? '',
    subjects: ob.subjects.map(id => state.records.get(id)).filter(r => r !== undefined).map(r => ({ id: r!.id, type: r!.type, data: project(pkg?.types.get(r!.type)?.fields, r!.data) })),
    relations: relations.map(r => ({ relation: r.relation, from: r.from, to: r.to, data: r.data })),
    related: relatedIds.map(id => state.records.get(id)).filter(r => r !== undefined).slice(0, 200).map(r => ({ id: r!.id, type: r!.type, data: project(active?.types.get(r!.type)?.fields, r!.data) })),
    decision: d ? { id: d.id, question: d.question, options: [...d.subjects] } : null
  };
}

export async function runQueued(host: Host, reviewer: Reviewer, opts: { root: string; concurrency?: number; timeoutMs?: number }) {
  const concurrency = Math.min(Math.max(opts.concurrency ?? 2, 1), 4);
  const active = (host.worlds() as any[]).find(w => w.kind === 'live' && w.status === 'active')?.id;
  const queue = host.tasks(active).filter(t => t.status === 'queued').map(t => t.id);
  const results: { task: string; outcome: string; detail: string[] }[] = [];
  let peak = 0; let running = 0;
  const one = async (taskId: string) => {
    let fence;
    try { fence = host.startAttempt(taskId, opts.root); }
    catch (e: any) { results.push({ task: taskId, outcome: 'not_dispatched', detail: [e.message] }); return; }
    running++; peak = Math.max(peak, running);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10 * 60_000);
    try {
      const result = await reviewer.review(reviewBundle(host, taskId), controller.signal);
      const labelled = reviewer.kind === 'simulated' && !result.note.startsWith('SIMULATED') ? { ...result, note: `SIMULATED: ${result.note}` } : result;
      const o = host.completeReview(fence, labelled);
      results.push({ task: taskId, outcome: o.status, detail: o.status === 'committed' ? o.notes : o.reasons });
    } catch (e: any) {
      host.failAttempt(fence, String(e?.message ?? e));
      results.push({ task: taskId, outcome: 'failed', detail: [String(e?.message ?? e)] });
    } finally { clearTimeout(timer); running--; }
  };
  const workers = Array.from({ length: concurrency }, async () => { while (queue.length) await one(queue.shift()!); });
  await Promise.all(workers);
  return { results, peakConcurrency: peak, reviewer: reviewer.kind };
}
