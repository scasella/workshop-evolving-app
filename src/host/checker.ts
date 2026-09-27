import { canonical, digest, fail, HostError, need, type Json } from './canonical.ts';
import {
  Budget, checkValue, evaluate, hasEvidenceRoute, INTERPRETER, isRecordId, walkEffects,
  type Capability, type DecisionView, type Field, type Package, type Primitive, type RecordValue, type RelationValue, type WorldView
} from './lang.ts';

// The production authority. Pure functions over plain data: runtime commits in
// store.ts apply only the plans returned here, and tests call these same functions.
export const HOST_INTERPRETERS = [INTERPRETER];

export type ObligationStatus = 'open' | 'blocked' | 'fulfilled' | 'cancelled_by_owner' | 'superseded_by_owner';
export type Obligation = {
  id: string; key: string; title: string; world: string; originCommand: string; owner: 'owner';
  subjects: string[]; gate: string | null;
  policy: { version: 1; verdicts: string[]; discharge: 'owner' | 'job'; independent: boolean };
  continuation: { packageHash: string; action: string; interpreter: string };
  artifacts: string[]; status: ObligationStatus;
  fulfillment: null | { verdict: string; note: string; artifact: string | null; subjectDigest: string; principal: string; revision: number };
  renews: string | null; renewedBy: string | null; successor: string | null; reason: string | null; createdRevision: number;
};
export type Decision = DecisionView & { finalizedRevision: number | null };
export type Task = { id: string; kind: 'review'; world: string; obligation: string; prompt: string; packageHash: string;
  status: 'queued' | 'running' | 'reconcile' | 'succeeded' | 'failed' | 'cancelled'; createdRevision: number };
export type WorldState = {
  id: string; revision: number; packageHash: string; grant: Capability[];
  records: Map<string, RecordValue>; relations: Map<string, RelationValue>; decisions: Map<string, Decision>;
};
export type Principal = 'owner' | `job:${string}`;
export type Authority = { principal: Principal; capabilities: Set<Capability>; obligation?: string };
export type HostOp =
  | { op: 'put_record'; record: RecordValue }
  | { op: 'put_relation'; relation: RelationValue }
  | { op: 'put_obligation'; obligation: Obligation }
  | { op: 'put_evidence'; obligation: string; verdict: string; note: string; artifact: string | null; subjectDigest: string; principal: string; accepted: boolean }
  | { op: 'put_decision'; decision: Decision }
  | { op: 'put_task'; task: Task }
  | { op: 'rebind_task'; task: string; packageHash: string }
  | { op: 'set_world'; revision: number; packageHash: string; grant: Capability[] };
export type Plan = { world: string; fromRevision: number; toRevision: number; ops: HostOp[]; notes: string[] };
export type Context = { packages: (hash: string) => Package | undefined; artifacts: (hash: string) => boolean; tasks: Task[] };

const clone = <T>(value: T): T => structuredClone(value);
export class Rejection extends HostError {
  readonly reasons: string[];
  constructor(reasons: string[], code = 'rejected') { super(code, reasons.join('; ')); this.reasons = reasons; }
}

// Obligation-facing views for package expressions. Preview worlds see shadows.
export function worldView(state: WorldState, ledger: Obligation[], ctx: Context): WorldView {
  return {
    records: state.records, relations: state.relations, decisions: state.decisions,
    obligations: ledger.filter(o => o.world === state.id).map(o => ({ id: o.id, key: o.key, title: o.title, status: o.status, gate: o.gate, subjects: o.subjects })),
    subjectDigest: ids => digest(ids.map(id => state.records.get(id) ?? null))
  };
}

// Versioned read projection: the digest of what the obligation's own package
// could see. Additive fields introduced later do not silently invalidate reviews;
// any edit to a projected field or projected relation does.
export function subjectDigest(ob: Pick<Obligation, 'subjects' | 'continuation'> & { gate?: string | null }, state: WorldState, ctx: Context): string {
  const pkg = ctx.packages(ob.continuation.packageHash);
  need(pkg, 'continuation_missing', `package ${ob.continuation.packageHash.slice(0, 12)} for obligation continuation is unavailable`);
  const project = (fields: Record<string, Field>, data: Record<string, Json>) =>
    Object.fromEntries(Object.keys(fields).sort().filter(k => k in data).map(k => [k, data[k]]));
  const subjects = [...ob.subjects].sort();
  const records = subjects.map(id => {
    const r = state.records.get(id); const t = r && pkg.types.get(r.type);
    return r ? { id, type: r.type, data: t ? project(t.fields, r.data) : null } : { id, missing: true };
  });
  const relations = [...state.relations.values()].filter(r => pkg.relations.has(r.relation) && (subjects.includes(r.from) || subjects.includes(r.to)))
    .sort((a, b) => a.id < b.id ? -1 : 1).map(r => ({ id: r.id, data: project(pkg.relations.get(r.relation)!.fields, r.data) }));
  // A review gated on a decision also covers that decision's question and options.
  const d = 'gate' in ob && ob.gate ? state.decisions.get(ob.gate as string) : undefined;
  const gate = d ? { question: d.question, options: [...d.subjects].sort() } : null;
  return digest(gate ? { records, relations, gate } : { records, relations });
}

function fillAndCheck(fields: Record<string, Field>, data: Record<string, Json>, where: string, existing?: Record<string, Json>) {
  const out: Record<string, Json> = existing ? { ...existing } : {};
  for (const [key, value] of Object.entries(data)) {
    need(key in fields, 'schema_violation', `${where}: unknown field ${key}`);
    if (value === null && fields[key].optional) { delete out[key]; continue; }
    out[key] = checkValue(fields[key], value, `${where}.${key}`);
  }
  for (const [key, spec] of Object.entries(fields))
    if (!(key in out)) {
      if (spec.default !== undefined) out[key] = spec.default;
      else need(spec.optional, 'schema_violation', `${where}: required field ${key} missing`);
    }
  need(Buffer.byteLength(canonical(out)) <= 64 * 1024, 'record_too_large', `${where}: a record may hold at most 64 KiB`);
  return out;
}
function checkRefs(state: WorldState, pkg: Package, record: RecordValue) {
  const fields = pkg.types.get(record.type)?.fields ?? {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = record.data[key]; if (value === undefined || value === null) continue;
    const refs = spec.type === 'ref' ? [[spec.to, value]] : spec.type === 'list' && spec.of.type === 'ref' ? (value as string[]).map(v => [(spec.of as any).to, v]) : [];
    for (const [type, id] of refs) need(state.records.get(id as string)?.type === type, 'reference_invalid', `${record.id}.${key} must reference an existing ${type}`);
  }
}

// ---------- Actions ----------
export function authorizeAction(input: {
  state: WorldState; ledger: Obligation[]; ctx: Context; executing: Package; actionId: string;
  authority: Authority; operationId: string; primitives: Primitive[];
}): Plan {
  const { ctx, executing, authority, operationId } = input;
  // Schema writes need the active package; evidence through an intact pinned
  // continuation does not, so commitments stay completable during recovery.
  const active = ctx.packages(input.state.packageHash);
  const schema = () => { need(active, 'package_unavailable', 'active package unavailable; open recovery'); return active; };
  const state: WorldState = { ...input.state, records: new Map(input.state.records), relations: new Map(input.state.relations), decisions: new Map(input.state.decisions) };
  const ledger = new Map(input.ledger.map(o => [o.id, clone(o)]));
  const tasks = [...ctx.tasks];
  const revision = input.state.revision + 1;
  const ops: HostOp[] = []; const notes: string[] = [];
  const touched = new Set<string>();
  const cap = (c: Capability) => {
    need(executing.manifest.capabilities.includes(c), 'capability_denied', `package did not declare ${c}`);
    need(state.grant.includes(c) && authority.capabilities.has(c), 'capability_denied', `principal lacks ${c}`);
  };
  const reviewed = new Map<string, string>();
  for (const p of input.primitives) {
    if (p.op === 'create_record' || p.op === 'update_record') {
      cap('records.write');
      need(isRecordId(p.id), 'type_error', `invalid record ID ${JSON.stringify(p.id)}`);
      const type = schema().types.get(p.type);
      need(type, 'schema_violation', `active package has no type ${p.type}`);
      const existing = state.records.get(p.id);
      if (p.op === 'create_record') {
        need(!existing && !state.decisions.has(p.id), 'duplicate_id', `record ${p.id} already exists`);
        state.records.set(p.id, { id: p.id, type: p.type, rev: 1, data: fillAndCheck(type.fields, p.data, p.id) });
      } else {
        need(existing && existing.type === p.type, 'not_found', `no ${p.type} record ${p.id}`);
        // Checked write: fields unknown to an older continuation package are preserved.
        state.records.set(p.id, { ...existing, rev: existing.rev + 1, data: fillAndCheck(type.fields, p.data, p.id, existing.data) });
      }
      touched.add(p.id);
    } else if (p.op === 'relate') {
      cap('relations.write');
      const def = schema().relations.get(p.relation);
      need(def, 'schema_violation', `active package has no relation ${p.relation}`);
      need(state.records.get(p.from)?.type === def.from && state.records.get(p.to)?.type === def.to, 'reference_invalid',
        `${p.relation} must connect an existing ${def.from} to an existing ${def.to}`);
      const id = `${p.relation}:${p.from}:${p.to}`;
      state.relations.set(id, { id, relation: p.relation, from: p.from, to: p.to, data: fillAndCheck(def.fields, p.data, id, state.relations.get(id)?.data) });
      touched.add(p.from); touched.add(p.to);
    } else if (p.op === 'open_obligation') {
      cap('obligations.open');
      need(isRecordId(p.key), 'type_error', `invalid obligation key ${JSON.stringify(p.key)}`);
      const id = `ob-${p.key}`;
      need(!ledger.has(id), 'duplicate_id', `obligation ${id} already exists`);
      need(p.subjects.length > 0 && p.subjects.every(s => state.records.has(s)), 'reference_invalid', 'obligation subjects must be existing records');
      need(p.gate === null || state.decisions.get(p.gate)?.status === 'draft', 'reference_invalid', 'obligation gate must be a draft decision');
      need(typeof p.title === 'string' && p.title.length > 0 && p.title.length <= 200, 'type_error', 'obligation title required');
      need(p.verdicts.length > 0, 'type_error', 'obligation must name at least one fulfilling verdict');
      ledger.set(id, { id, key: p.key, title: p.title, world: state.id, originCommand: operationId, owner: 'owner',
        subjects: [...p.subjects], gate: p.gate, policy: { version: 1, verdicts: [...p.verdicts], discharge: p.discharge, independent: p.independent },
        continuation: { packageHash: executing.hash, action: p.continuation, interpreter: INTERPRETER },
        artifacts: [], status: 'open', fulfillment: null, renews: null, renewedBy: null, successor: null, reason: null, createdRevision: revision });
      ops.push({ op: 'put_obligation', obligation: ledger.get(id)! });
    } else if (p.op === 'submit_evidence') {
      cap('evidence.submit');
      const ob = ledger.get(p.obligation);
      need(ob, 'not_found', `no obligation ${p.obligation}`);
      need(ob.world === state.id, 'binding_mismatch', `obligation ${ob.id} is bound to another world`);
      need(ob.status === 'open', 'obligation_closed', `obligation ${ob.id} is ${ob.status}`);
      need(executing.hash === ob.continuation.packageHash && input.actionId === ob.continuation.action, 'continuation_route',
        `evidence for ${ob.id} must arrive through its bound continuation ${ob.continuation.action}`);
      if (ob.policy.discharge === 'owner') need(authority.principal === 'owner', 'principal_denied', `${ob.id} is discharged by the owner only`);
      else need(authority.principal.startsWith('job:') && authority.obligation === ob.id &&
        tasks.some(t => `job:${t.id}` === authority.principal && t.obligation === ob.id && t.status === 'running'), 'principal_denied',
        `${ob.id} must be discharged by its own running review job`);
      need(typeof p.verdict === 'string' && typeof p.note === 'string' && p.note.length <= 4096, 'type_error', 'evidence verdict/note invalid');
      if (p.artifact !== null) need(ctx.artifacts(p.artifact), 'artifact_missing', `evidence artifact ${String(p.artifact).slice(0, 12)} is not stored`);
      // Evidence binds the subject as it existed before this transition.
      const bound = subjectDigest(ob, input.state, ctx);
      const accepted = ob.policy.verdicts.includes(p.verdict);
      if (accepted && ob.policy.independent) {
        const peers = [...ledger.values()].filter(o => o.gate === ob.gate && o.id !== ob.id && o.policy.independent && o.status === 'fulfilled');
        need(peers.every(o => o.fulfillment!.principal !== authority.principal), 'independence', `${ob.id} requires a reviewer independent of its peer reviews`);
      }
      ops.push({ op: 'put_evidence', obligation: ob.id, verdict: p.verdict, note: p.note, artifact: p.artifact, subjectDigest: bound, principal: authority.principal, accepted });
      if (accepted) {
        ob.status = 'fulfilled';
        ob.fulfillment = { verdict: p.verdict, note: p.note, artifact: p.artifact, subjectDigest: bound, principal: authority.principal, revision };
        if (p.artifact) ob.artifacts = [...ob.artifacts, p.artifact];
        ops.push({ op: 'put_obligation', obligation: ob });
        reviewed.set(ob.id, bound);
      }
    } else if (p.op === 'request_task') {
      cap('tasks.review');
      const ob = ledger.get(p.obligation);
      need(ob && ob.world === state.id && ob.status === 'open' && ob.policy.discharge === 'job', 'task_invalid', `${p.obligation} is not an open job-discharged obligation`);
      need(!tasks.some(t => t.obligation === ob.id && (t.status === 'queued' || t.status === 'running')), 'task_duplicate', `${ob.id} already has an active review job`);
      need(executing.files[`prompts/${p.prompt}.md`] !== undefined, 'reference_invalid', `missing prompt ${p.prompt}`);
      const task: Task = { id: `task-${ob.id}-${revision}`, kind: 'review', world: state.id, obligation: ob.id, prompt: p.prompt,
        packageHash: executing.hash, status: 'queued', createdRevision: revision };
      tasks.push(task); ops.push({ op: 'put_task', task });
    } else if (p.op === 'draft_decision') {
      cap('decisions.draft');
      need(isRecordId(p.id) && !state.records.has(p.id), 'type_error', `invalid decision ID ${p.id}`);
      const existing = state.decisions.get(p.id);
      need(!existing || existing.status === 'draft', 'decision_final', `decision ${p.id} is already final`);
      need(typeof p.question === 'string' && p.question.length > 0 && p.question.length <= 500, 'type_error', 'decision question required');
      need(p.subjects.every(s => state.records.has(s)), 'reference_invalid', 'decision subjects must exist');
      need(p.choice === null || p.subjects.includes(p.choice), 'reference_invalid', 'decision choice must be one of its subjects');
      const decision: Decision = { id: p.id, question: p.question, subjects: [...p.subjects], choice: p.choice, status: 'draft', finalizedRevision: null };
      state.decisions.set(p.id, decision); ops.push({ op: 'put_decision', decision });
    } else fail('primitive_unknown', `unsupported primitive ${(p as any).op}`);
  }
  for (const [id, bound] of reviewed) {
    const ob = ledger.get(id)!;
    need(ob.subjects.every(s => !touched.has(s)), 'evidence_subject_changed', `${id}: evidence cannot be submitted in the same step that changes its subject`);
    void bound;
  }
  for (const id of touched) { const r = state.records.get(id); if (r) { checkRefs(state, schema(), r); ops.push({ op: 'put_record', record: r }); } }
  for (const r of state.relations.values()) if (r !== input.state.relations.get(r.id)) ops.push({ op: 'put_relation', relation: r });
  ops.push(...renewals({ ...state, revision }, [...ledger.values()], ctx, notes));
  ops.push({ op: 'set_world', revision, packageHash: state.packageHash, grant: state.grant });
  return { world: state.id, fromRevision: input.state.revision, toRevision: revision, ops, notes };
}

// On any change to a reviewed subject, atomically open a linked review for the
// new subject revision. The historical fulfillment remains as recorded.
export function renewals(state: WorldState, ledger: Obligation[], ctx: Context, notes: string[]): HostOp[] {
  const ops: HostOp[] = [];
  const ids = new Set(ledger.map(o => o.id));
  for (const ob of ledger) {
    if (ob.world !== state.id || ob.status !== 'fulfilled' || ob.renewedBy) continue;
    if (ob.gate && state.decisions.get(ob.gate)?.status === 'final') continue;
    if (subjectDigest(ob, state, ctx) === ob.fulfillment!.subjectDigest) continue;
    let n = 2; while (ids.has(`${ob.id}-r${n}`)) n++;
    const id = `${ob.id}-r${n}`; ids.add(id);
    const renewal: Obligation = { ...clone(ob), id, key: `${ob.key}-r${n}`, status: 'open', fulfillment: null, renews: ob.id, renewedBy: null,
      artifacts: [], createdRevision: state.revision, originCommand: `renewal:${ob.id}` };
    ops.push({ op: 'put_obligation', obligation: { ...clone(ob), renewedBy: id } }, { op: 'put_obligation', obligation: renewal });
    notes.push(`Subject of ${ob.id} changed after review; opened ${id} for the current subject.`);
    // A job-discharged renewal gets its own queued review, so it is never left without a route.
    if (ob.policy.discharge === 'job') {
      const original = ctx.tasks.filter(t => t.obligation === ob.id).at(-1);
      if (original) ops.push({ op: 'put_task', task: { ...original, id: `task-${id}-${state.revision}`, obligation: id, status: 'queued', createdRevision: state.revision } });
      else notes.push(`${id} has no prior review job to copy; request one or dispose of it.`);
    }
  }
  return ops;
}

// ---------- Protected decisions and dispositions (owner-only host commands) ----------
// lineage: retained ancestor worlds of a restored branch. Their live obligations
// still gate a decision copied from them, so restoring can never drop a review gate.
export function finalizeDecision(state: WorldState, ledger: Obligation[], ctx: Context, principal: Principal, decisionId: string, choice: string, lineage: string[] = []): Plan {
  need(principal === 'owner', 'principal_denied', 'only the owner can finalize a decision, through the protected surface');
  const d = state.decisions.get(decisionId);
  need(d, 'not_found', `no decision ${decisionId}`);
  need(d.status === 'draft', 'decision_final', `${decisionId} is already final`);
  need(d.subjects.includes(choice), 'reference_invalid', 'choice must be one of the decision subjects');
  const gating = ledger.filter(o => o.gate === decisionId && (o.world === state.id || lineage.includes(o.world)));
  const blocking: string[] = [];
  for (const o of gating) {
    if (o.status === 'open' || o.status === 'blocked') blocking.push(o.world === state.id ? `${o.id} (${o.title}) is ${o.status}`
      : `${o.id} (${o.title}) is ${o.status} in retained branch ${o.world}; complete it there, transfer it here, or dispose of it`);
    else if (o.status === 'fulfilled') {
      if (o.renewedBy) continue; // its successor requirement is checked on its own
      if (subjectDigest(o, state, ctx) !== o.fulfillment!.subjectDigest) blocking.push(`${o.id} reviewed an earlier subject revision`);
    } else if (o.status === 'superseded_by_owner') {
      const s = ledger.find(x => x.id === o.successor);
      need(s, 'ledger_invalid', `${o.id} names a missing successor`);
      if (s.status !== 'fulfilled' && s.gate !== decisionId && s.status !== 'cancelled_by_owner') blocking.push(`${o.id} was replaced by ${s.id} (${s.title}), which is still ${s.status}`);
    }
  }
  if (blocking.length) throw new Rejection(blocking.map(b => `Cannot finalize: ${b}`), 'finalize_blocked');
  const revision = state.revision + 1;
  return { world: state.id, fromRevision: state.revision, toRevision: revision, notes: [],
    ops: [{ op: 'put_decision', decision: { ...d, choice, status: 'final', finalizedRevision: revision } },
      { op: 'set_world', revision, packageHash: state.packageHash, grant: state.grant }] };
}

export type Disposition = { id: string; obligation: string; kind: 'cancel' | 'supersede'; reason: string; successor: string | null; revision: number; world: string };
export function disposeObligation(state: WorldState, ledger: Obligation[], principal: Principal, expectedRevision: number,
  obligationId: string, kind: 'cancel' | 'supersede', reason: string, successor: string | null): { plan: Plan; disposition: Disposition } {
  need(principal === 'owner', 'principal_denied', 'only the owner can cancel or supersede an obligation');
  need(state.revision === expectedRevision, 'stale_revision', `project changed (revision ${state.revision}, expected ${expectedRevision})`);
  const ob = ledger.find(o => o.id === obligationId);
  need(ob && ob.world === state.id, 'not_found', `no obligation ${obligationId} bound to this world`);
  need(ob.status === 'open' || ob.status === 'blocked', 'obligation_closed', `${ob.id} is ${ob.status}`);
  need(typeof reason === 'string' && reason.trim().length >= 3 && reason.length <= 500, 'type_error', 'a reason is required');
  if (kind === 'supersede') {
    const s = ledger.find(o => o.id === successor);
    need(s && s.id !== ob.id && s.world === state.id && (s.status === 'open' || s.status === 'fulfilled'), 'reference_invalid', 'supersession needs a live successor obligation');
  } else need(successor === null, 'type_error', 'cancellation has no successor');
  const revision = state.revision + 1;
  const updated: Obligation = { ...clone(ob), status: kind === 'cancel' ? 'cancelled_by_owner' : 'superseded_by_owner', reason, successor };
  const disposition: Disposition = { id: `disp-${ob.id}-${revision}`, obligation: ob.id, kind, reason, successor, revision, world: state.id };
  return { disposition, plan: { world: state.id, fromRevision: state.revision, toRevision: revision, notes: [],
    ops: [{ op: 'put_obligation', obligation: updated }, { op: 'set_world', revision, packageHash: state.packageHash, grant: state.grant }] } };
}

// ---------- Schema compatibility and migration ----------
function specKey(f: Field) { const { semantic, default: _d, optional: _o, ...rest } = f; return canonical({ ...rest, semantic }); }
export function schemaProblems(from: Package, to: Package): string[] {
  const problems: string[] = [];
  for (const [id, t] of from.types) {
    const next = to.types.get(id);
    if (!next) { problems.push(`removes type ${id}`); continue; }
    for (const [f, spec] of Object.entries(t.fields)) {
      const n = next.fields[f];
      if (!n) problems.push(`removes field ${id}.${f}`);
      else if (specKey(n) !== specKey(spec)) problems.push(`changes the meaning, units or type of ${id}.${f} (semantic ${spec.semantic})`);
      else if (!spec.optional && n.optional) problems.push(`makes required field ${id}.${f} optional`);
      else if (spec.optional && !n.optional && n.default === undefined) problems.push(`makes optional field ${id}.${f} required without a default`);
    }
    for (const [f, n] of Object.entries(next.fields)) if (!(f in t.fields)) {
      if (!n.optional && n.default === undefined) problems.push(`adds required field ${id}.${f} without a default`);
      const reused = Object.entries(t.fields).find(([, s]) => s.semantic === n.semantic);
      if (reused) problems.push(`reuses semantic ID ${n.semantic} of ${id}.${reused[0]} for new field ${f}`);
    }
  }
  for (const [id, r] of from.relations) {
    const next = to.relations.get(id);
    if (!next) { problems.push(`removes relation ${id}`); continue; }
    if (next.from !== r.from || next.to !== r.to) problems.push(`changes endpoints of relation ${id}`);
    for (const [f, spec] of Object.entries(r.fields)) {
      const n = next.fields[f];
      if (!n || specKey(n) !== specKey(spec)) problems.push(`removes or changes relation field ${id}.${f}`);
      else if (spec.optional && !n.optional && n.default === undefined) problems.push(`makes optional relation field ${id}.${f} required without a default`);
    }
    for (const [f, n] of Object.entries(next.fields)) if (!(f in r.fields) && !n.optional && n.default === undefined) problems.push(`adds required relation field ${id}.${f} without a default`);
  }
  return problems;
}

// Deterministic migration: fill defaults for newly added fields, then run
// backfill expressions that may write only fields the candidate newly adds.
export function migrate(state: WorldState, ledger: Obligation[], ctx: Context, from: Package, to: Package): { records: RecordValue[]; problems: string[] } {
  const problems = schemaProblems(from, to);
  const out = new Map<string, RecordValue>();
  const added = (type: string) => { const old = from.types.get(type)?.fields ?? {}; return Object.keys(to.types.get(type)?.fields ?? {}).filter(f => !(f in old)); };
  for (const r of [...state.records.values()].sort((a, b) => a.id < b.id ? -1 : 1)) {
    const fields = to.types.get(r.type)?.fields; if (!fields) continue;
    const newFields = added(r.type).filter(f => fields[f].default !== undefined && !(f in r.data));
    if (newFields.length) out.set(r.id, { ...r, data: { ...r.data, ...Object.fromEntries(newFields.map(f => [f, fields[f].default!])) } });
  }
  const view = worldView(state, ledger, ctx);
  const budget = new Budget();
  for (const [i, step] of (to.migration?.steps ?? []).entries()) {
    const { type, field, value } = step.backfill;
    if (!added(type).includes(field)) { problems.push(`migration step ${i} writes existing field ${type}.${field}; only newly added fields may be backfilled`); continue; }
    for (const r of [...state.records.values()].filter(x => x.type === type).sort((a, b) => a.id < b.id ? -1 : 1)) {
      try {
        const base = out.get(r.id) ?? r;
        const v = evaluate(value, { world: view, inputs: {}, vars: new Map([['record', { id: r.id, type: r.type, ...r.data }]]), budget });
        checkValue(to.types.get(type)!.fields[field], v, `${r.id}.${field}`);
        out.set(r.id, { ...base, data: { ...base.data, [field]: v } });
      } catch (error: any) { problems.push(`migration step ${i} on ${r.id}: ${error.message}`); break; }
    }
  }
  return { records: [...out.values()], problems };
}
export function stateDigest(state: WorldState, ledger: Obligation[]): string {
  const sorted = <T extends { id: string }>(xs: Iterable<T>) => [...xs].sort((a, b) => a.id < b.id ? -1 : 1);
  return digest({ world: state.id, revision: state.revision, packageHash: state.packageHash, grant: [...state.grant].sort(),
    records: sorted(state.records.values()), relations: sorted(state.relations.values()), decisions: sorted(state.decisions.values()),
    obligations: sorted(ledger.filter(o => o.world === state.id)) });
}

// ---------- Continuation witnesses ----------
export function actionNeeds(pkg: Package, action: string): Capability[] {
  const needs = new Set<Capability>();
  const m: Record<string, Capability> = { create: 'records.write', update: 'records.write', relate: 'relations.write', evidence: 'evidence.submit', obligation: 'obligations.open', task: 'tasks.review', decision: 'decisions.draft' };
  walkEffects(pkg.actions.get(action)?.effects ?? [], e => { const k = Object.keys(e)[0]; if (m[k]) needs.add(m[k]); });
  return [...needs].sort();
}
export type Witness = { obligation: string; route: 'pinned' | 'adapter'; packageHash: string; action: string; ok: boolean; problems: string[] };
export function continuationWitnesses(state: WorldState, ledger: Obligation[], ctx: Context, candidate: Package, grant: Capability[], hostInterpreters = HOST_INTERPRETERS): Witness[] {
  return ledger.filter(o => o.world === state.id && (o.status === 'open' || o.status === 'blocked')).map(ob => {
    const problems: string[] = [];
    const c = ob.continuation;
    const adapter = candidate.manifest.continuations?.[`${c.packageHash}:${c.action}`];
    const label = `review ${ob.id} (${ob.title})`;
    let pkg: Package | undefined, action: string;
    if (adapter) {
      pkg = candidate; action = adapter;
      if (!candidate.actions.has(adapter) || !hasEvidenceRoute(candidate.actions.get(adapter)!))
        problems.push(`This update maps the continuation for ${label} to ${adapter}, which does not exist or cannot submit evidence`);
    } else {
      action = c.action;
      pkg = ctx.packages(c.packageHash);
      if (!pkg) problems.push(`This update strands ${label}: its package ${c.packageHash.slice(0, 12)} is not retained`);
      else if (candidate.manifest.retire?.includes(c.packageHash)) problems.push(`This update retires package ${c.packageHash.slice(0, 12)}, removing the continuation for ${label}`);
      else if (!pkg.actions.has(c.action) || !hasEvidenceRoute(pkg.actions.get(c.action)!)) problems.push(`The continuation ${c.action} for ${label} no longer exists`);
      if (pkg && !pkg.manifest.interpreters.some(i => hostInterpreters.includes(i))) problems.push(`No supported interpreter remains for the continuation of ${label}`);
      if (pkg && pkg !== candidate) {
        const drift = schemaProblems(pkg, candidate);
        if (drift.length) problems.push(`The continuation for ${label} can no longer read or write its records: ${drift.join(', ')}`);
      }
    }
    if (pkg && pkg.actions.has(action))
      for (const n of actionNeeds(pkg, action)) if (!grant.includes(n)) problems.push(`This update removes capability ${n}, which the continuation for ${label} needs`);
    for (const a of ob.artifacts) if (!ctx.artifacts(a)) problems.push(`Artifact ${a.slice(0, 12)} referenced by ${label} is missing`);
    for (const s of ob.subjects) if (!state.records.has(s)) problems.push(`Subject ${s} of ${label} is missing`);
    return { obligation: ob.id, route: adapter ? 'adapter' : 'pinned', packageHash: adapter ? candidate.hash : c.packageHash, action, ok: problems.length === 0, problems };
  });
}

// ---------- Activation ----------
export type ApprovalReceipt = { id: string; owner: 'owner'; candidateHash: string; previewHash: string; expectedRevision: number;
  grant: Capability[]; dispositions: string[]; issuedBy: 'host'; instance: string };
export type Preview = { previewHash: string; candidateHash: string; world: string; baseRevision: number; baseDigest: string; resultDigest: string; witnessDigest: string };
export function checkActivation(input: {
  state: WorldState; ledger: Obligation[]; ctx: Context; candidate: Package; candidateHash: string;
  preview: Preview; approval: ApprovalReceipt | null; dispositions: Disposition[]; hostInterpreters?: string[]; instance: string; migrateJobs?: string[];
}): { plan: Plan; resultDigest: string; witnesses: Witness[] } {
  const { state, ledger, ctx, candidate, preview, approval } = input;
  const problems: string[] = [];
  need(approval && approval.issuedBy === 'host' && approval.owner === 'owner', 'approval_missing', 'no owner approval receipt issued by the host');
  need(approval.instance === input.instance, 'approval_foreign', 'this approval was issued by another Workshop instance (an import or copy) and cannot authorize activation here');
  if (approval.candidateHash !== input.candidateHash || preview.candidateHash !== input.candidateHash) problems.push('The candidate changed after approval; a new preview and approval are required');
  if (approval.previewHash !== preview.previewHash) problems.push('The approval is for a different preview');
  if (problems.length) throw new Rejection(problems, 'approval_mismatch');
  if (state.revision !== approval.expectedRevision || state.revision !== preview.baseRevision || stateDigest(state, ledger) !== preview.baseDigest)
    problems.push(`The project changed after this preview (now revision ${state.revision}, preview of ${preview.baseRevision}); refresh it before applying`);
  if (problems.length) throw new Rejection(problems, 'activation_stale');
  for (const d of approval.dispositions) {
    const disp = input.dispositions.find(x => x.id === d);
    const ob = disp && ledger.find(o => o.id === disp.obligation);
    if (!disp || !ob || disp.world !== state.id || disp.revision > state.revision ||
      ob.status !== (disp.kind === 'cancel' ? 'cancelled_by_owner' : 'superseded_by_owner') || ob.successor !== disp.successor)
      problems.push(`Disposition ${d} is not a committed disposition matching the current ledger`);
  }
  const core = activationCore(state, ledger, ctx, candidate, approval.grant, input.hostInterpreters, input.migrateJobs);
  problems.push(...core.problems);
  if (problems.length) throw new Rejection(problems, 'activation_rejected');
  if (core.resultDigest !== preview.resultDigest) throw new Rejection(['Recomputed migration result differs from the approved preview'], 'activation_mismatch');
  const { ops, witnesses, resultDigest } = core;
  const revision = state.revision + 1;
  ops.push({ op: 'set_world', revision, packageHash: candidate.hash, grant: [...approval.grant] });
  return { plan: { world: state.id, fromRevision: state.revision, toRevision: revision, ops, notes: [] }, resultDigest, witnesses };
}

// Shared by preview and activation so rehearsal uses the same migration and witness code.
export function activationCore(state: WorldState, ledger: Obligation[], ctx: Context, candidate: Package, grant: Capability[], hostInterpreters = HOST_INTERPRETERS, migrateJobs: string[] = []) {
  const problems: string[] = [];
  const current = ctx.packages(state.packageHash);
  need(current, 'package_unavailable', 'active package unavailable');
  if (candidate.manifest.parent !== state.packageHash) problems.push('The candidate was not derived from the active package');
  for (const c of candidate.manifest.capabilities) if (!grant.includes(c)) problems.push(`Capability ${c} was requested but not granted`);
  // No obligation anywhere in the ledger (any branch, any status) may lose its continuation package.
  // No obligation anywhere (any branch, any status, adapter or not) may lose its package: same rule as the Lean contract.
  for (const h of candidate.manifest.retire ?? []) for (const o of ledger.filter(o => o.continuation.packageHash === h))
    problems.push(`This update retires package ${h.slice(0, 12)}, which ${o.world === state.id ? '' : `branch ${o.world}'s `}${o.id} still needs`);
  const migration = migrate(state, ledger, ctx, current, candidate);
  problems.push(...migration.problems.map(p => `This update ${p}`));
  const witnesses = continuationWitnesses(state, ledger, ctx, candidate, grant, hostInterpreters);
  for (const w of witnesses) problems.push(...w.problems);
  const records = new Map(state.records);
  for (const r of migration.records) records.set(r.id, r);
  const ops: HostOp[] = migration.records.map(record => ({ op: 'put_record', record }));
  for (const w of witnesses.filter(w => w.route === 'adapter' && w.ok)) {
    const ob = ledger.find(o => o.id === w.obligation)!;
    ops.push({ op: 'put_obligation', obligation: { ...clone(ob), continuation: { packageHash: candidate.hash, action: w.action, interpreter: INTERPRETER } } });
  }
  // Default: every job stays pinned to its original package. Only explicitly
  // selected, paused jobs move, and only if the candidate can still serve them.
  for (const id of [...new Set(migrateJobs)].sort()) {
    const t = ctx.tasks.find(x => x.id === id);
    if (!t || t.world !== state.id) { problems.push(`Selected job ${id} does not exist in this project`); continue; }
    if (!['queued', 'reconcile', 'failed'].includes(t.status)) { problems.push(`Selected job ${id} is ${t.status}; only paused or reconciled jobs can be migrated`); continue; }
    const ob = ledger.find(o => o.id === t.obligation);
    if (!ob || ob.status !== 'open') problems.push(`Selected job ${id} serves ${t.obligation}, which is not open`);
    if (candidate.files[`prompts/${t.prompt}.md`] === undefined) problems.push(`Selected job ${id} needs prompt ${t.prompt}, which the candidate does not provide`);
    ops.push({ op: 'rebind_task', task: id, packageHash: candidate.hash });
  }
  const resultDigest = digest({ records: [...records.values()].sort((a, b) => a.id < b.id ? -1 : 1), packageHash: candidate.hash, grant: [...grant].sort(), migrateJobs: [...new Set(migrateJobs)].sort() });
  return { problems, witnesses, ops, records, resultDigest };
}

// Explicit, checked rebinding of one live obligation from a retained ancestor
// branch to the active branch. Copying rows never moves authority; only this does.
export function transferObligation(target: WorldState, ledger: Obligation[], ctx: Context, principal: Principal, obligationId: string, lineage: string[], expectedRevision: number): Plan {
  need(principal === 'owner', 'principal_denied', 'only the owner can transfer an obligation');
  need(target.revision === expectedRevision, 'stale_revision', `project changed (revision ${target.revision}, expected ${expectedRevision})`);
  const ob = ledger.find(o => o.id === obligationId);
  need(ob && (ob.status === 'open' || ob.status === 'blocked'), 'not_found', `no live obligation ${obligationId}`);
  need(lineage.includes(ob.world), 'binding_mismatch', `${ob.id} is not bound to a retained ancestor of ${target.id}`);
  const problems: string[] = [];
  for (const s of ob.subjects) if (!target.records.has(s)) problems.push(`subject ${s} does not exist in ${target.id}`);
  if (ob.gate && target.decisions.get(ob.gate)?.status !== 'draft') problems.push(`gate ${ob.gate} is not a draft decision in ${target.id}`);
  const pkg = ctx.packages(ob.continuation.packageHash);
  if (!pkg || !pkg.actions.has(ob.continuation.action) || !hasEvidenceRoute(pkg.actions.get(ob.continuation.action)!)) problems.push(`continuation ${ob.continuation.action} is unavailable`);
  else { const drift = pkg.hash === target.packageHash ? [] : schemaProblems(pkg, ctx.packages(target.packageHash) ?? pkg); if (drift.length) problems.push(`continuation cannot read ${target.id}: ${drift.join(', ')}`); }
  if (!target.grant.includes('evidence.submit')) problems.push(`${target.id} does not grant evidence.submit`);
  for (const a of ob.artifacts) if (!ctx.artifacts(a)) problems.push(`artifact ${a.slice(0, 12)} missing`);
  if (problems.length) throw new Rejection(problems.map(p => `Cannot transfer ${ob.id}: ${p}`), 'transfer_rejected');
  const revision = target.revision + 1;
  return { world: target.id, fromRevision: target.revision, toRevision: revision, notes: [`${ob.id} now bound to ${target.id} (was ${ob.world})`],
    ops: [{ op: 'put_obligation', obligation: { ...clone(ob), world: target.id } }, { op: 'set_world', revision, packageHash: target.packageHash, grant: target.grant }] };
}
