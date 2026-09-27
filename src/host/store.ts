import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonical, digest, fail, HostError, need, sha256, type Json } from './canonical.ts';
import { CHECKER_BINARY, checkerIdentity, rInput, runRChecker } from './rcheck.ts';
import { Budget, evaluateAction, evaluatePlanner, evaluateView, INTERPRETER, isRecordId, LIMITS, parsePackage, type Capability, type Package } from './lang.ts';
import {
  activationCore, authorizeAction, checkActivation, disposeObligation, finalizeDecision, Rejection, schemaProblems, stateDigest, subjectDigest, transferObligation, worldView,
  type ApprovalReceipt, type Authority, type Context, type Decision, type Disposition, type HostOp, type Obligation, type Plan,
  type Preview, type Principal, type Task, type WorldState
} from './checker.ts';

// Identity of the protected policy: the exact host checker/interpreter/store source.
// A changed checker changes every candidate hash, so old approvals cannot carry over.
// Reads .ts source beside this module; the export milestone must ship these files or pin the ID.
const here = dirname(fileURLToPath(import.meta.url));
export const POLICY_ID = digest(['canonical.ts', 'lang.ts', 'checker.ts', 'store.ts', 'rcheck.ts'].map(f => [f, sha256(readFileSync(join(here, f)))]));

export type Envelope = { operationId: string; worldId: string; expectedRevision: number; packageHash: string;
  capabilityRef: string; actionId: string; input: Record<string, Json>; attemptFence?: { task: string; generation: number; epoch: number } };
export type Outcome = { status: 'committed'; revision: number; notes: string[] } | { status: 'rejected'; code: string; reasons: string[] };
export type Faults = { beforeActivationCommit?: () => void; afterActivationCommit?: () => void };

const SCHEMA = `
PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS host_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS packages(hash TEXT PRIMARY KEY, files TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, media TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worlds(id TEXT PRIMARY KEY, parent TEXT, parent_revision INTEGER, kind TEXT NOT NULL CHECK(kind IN ('live','proposal','recovery')),
  status TEXT NOT NULL, package TEXT NOT NULL REFERENCES packages(hash), revision INTEGER NOT NULL, grant_caps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records(world TEXT NOT NULL REFERENCES worlds(id), id TEXT NOT NULL, type TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(world,id));
CREATE TABLE IF NOT EXISTS relations(world TEXT NOT NULL REFERENCES worlds(id), id TEXT NOT NULL, relation TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(world,id));
CREATE TABLE IF NOT EXISTS decisions(world TEXT NOT NULL REFERENCES worlds(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(world,id));
-- Host-global ledger: never copied or restored with world snapshots. One authoritative binding per obligation.
CREATE TABLE IF NOT EXISTS obligations(id TEXT PRIMARY KEY, world TEXT NOT NULL REFERENCES worlds(id), status TEXT NOT NULL, data TEXT NOT NULL);
-- Non-authoritative copies used by proposal/rehearsal worlds only.
CREATE TABLE IF NOT EXISTS shadow_obligations(world TEXT NOT NULL REFERENCES worlds(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(world,id));
CREATE TABLE IF NOT EXISTS evidence(seq INTEGER PRIMARY KEY, world TEXT NOT NULL, obligation TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dispositions(id TEXT PRIMARY KEY, world TEXT NOT NULL, obligation TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, world TEXT NOT NULL, obligation TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
-- Review jobs requested inside practice/rehearsal worlds. Never dispatched, transferred or counted as live work.
CREATE TABLE IF NOT EXISTS shadow_tasks(world TEXT NOT NULL, id TEXT NOT NULL, obligation TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(world,id));
CREATE TABLE IF NOT EXISTS attempts(task TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, subject TEXT NOT NULL, PRIMARY KEY(task,generation));
CREATE TABLE IF NOT EXISTS allowances(root TEXT PRIMARY KEY, total INTEGER NOT NULL, used INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capabilities(id TEXT PRIMARY KEY, world TEXT NOT NULL, parent TEXT, principal TEXT NOT NULL, caps TEXT NOT NULL, obligation TEXT, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, digest TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, world TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER, command TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, world TEXT NOT NULL, practice_world TEXT, request TEXT NOT NULL, package TEXT, candidate_hash TEXT,
  status TEXT NOT NULL, preview TEXT, report TEXT NOT NULL, supersedes TEXT, jobs TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, proposal TEXT NOT NULL REFERENCES proposals(id), receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activations(id TEXT PRIMARY KEY, proposal TEXT NOT NULL, world TEXT NOT NULL, from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL,
  from_package TEXT NOT NULL, to_package TEXT NOT NULL, snapshot TEXT NOT NULL);
`;

export class Host {
  readonly db: DatabaseSync;
  readonly epoch: number;
  instance: string;
  imported: ReturnType<Host['adoptImport']> | null = null;
  private cache = new Map<string, Package>();
  faults: Faults = {};
  readonly dir: string;
  // Assurance mode: 'P' uses the tested TypeScript checker; 'R' additionally requires the
  // proved Lean checker to accept every activation and to agree on its obligation plan.
  readonly assurance: 'P' | 'R';
  readonly checkerBinary: string;
  constructor(dir: string, opts: { assurance?: 'P' | 'R'; checkerBinary?: string } = {}) {
    this.dir = dir;
    this.assurance = opts.assurance ?? (process.env.WORKSHOP_ASSURANCE === 'R' ? 'R' : 'P');
    this.checkerBinary = opts.checkerBinary ?? CHECKER_BINARY;
    mkdirSync(join(dir, 'artifacts'), { recursive: true }); mkdirSync(join(dir, 'staging'), { recursive: true });
    this.db = new DatabaseSync(join(dir, 'host.sqlite'));
    this.db.exec(SCHEMA);
    // Additive schema upgrade for databases created before events carried a time.
    if (!(this.db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='at'").get())) this.db.exec("ALTER TABLE events ADD COLUMN at TEXT");
    this.epoch = this.tx(() => {
      const row = this.db.prepare("SELECT value FROM host_state WHERE key='epoch'").get();
      const epoch = row ? Number(row.value) + 1 : 1;
      this.db.prepare("INSERT OR REPLACE INTO host_state VALUES ('epoch', ?)").run(String(epoch));
      return epoch;
    });
    // Local instance identity: approvals and dispatch authority are bound to it.
    const inst = this.db.prepare("SELECT value FROM host_state WHERE key='instance'").get();
    if (inst) this.instance = String(inst.value);
    else { this.instance = randomUUID(); this.db.prepare("INSERT INTO host_state VALUES ('instance', ?)").run(this.instance); }
    // An exported state directory adopts a fresh identity on its first open, whoever opens it.
    const marker = join(dir, 'IMPORT_PENDING');
    if (existsSync(marker)) { this.imported = this.adoptImport(); rmSync(marker); }
  }
  close() { this.db.close(); }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  private event(world: string, kind: string, data: unknown, revision: number | null = null, command: string | null = null) {
    this.db.prepare('INSERT INTO events(world,kind,revision,command,data,at) VALUES (?,?,?,?,?,?)').run(world, kind, revision, command, canonical(data), new Date().toISOString());
  }

  // ---------- Packages and artifacts ----------
  storePackage(files: Record<string, string>): Package {
    const pkg = parsePackage(files);
    this.db.prepare('INSERT OR IGNORE INTO packages VALUES (?,?,?)').run(pkg.hash, canonical(files), Date.now());
    this.cache.set(pkg.hash, pkg);
    return pkg;
  }
  // Repair: reinstall bytes for a package whose stored copy is missing or corrupt.
  // Content addressing makes this safe: only bytes hashing to the recorded identity are accepted.
  repairPackage(files: Record<string, string>, principal: Principal = 'owner'): string {
    need(principal === 'owner', 'principal_denied', 'only the owner repairs packages');
    const pkg = parsePackage(files);
    const row = this.db.prepare('SELECT hash FROM packages WHERE hash=?').get(pkg.hash);
    need(row, 'not_found', `package ${pkg.hash.slice(0, 12)} is not referenced by this host; propose it instead`);
    this.cache.delete(pkg.hash);
    this.tx(() => {
      this.db.prepare('UPDATE packages SET files=? WHERE hash=?').run(canonical(files), pkg.hash);
      const live = (this.worlds() as any[]).find(w => w.kind === 'live' && w.status === 'active');
      this.event(live?.id ?? 'host', 'package_repaired', { package: pkg.hash });
    });
    this.cache.set(pkg.hash, pkg);
    return pkg.hash;
  }
  // Verified availability: bytes must re-hash to the recorded identity.
  pkg = (hash: string): Package | undefined => {
    if (this.cache.has(hash)) return this.cache.get(hash);
    const row = this.db.prepare('SELECT files FROM packages WHERE hash=?').get(hash);
    if (!row) return undefined;
    try { const pkg = parsePackage(JSON.parse(String(row.files))); if (pkg.hash !== hash) return undefined; this.cache.set(hash, pkg); return pkg; }
    catch { return undefined; }
  };
  putArtifact(bytes: Uint8Array, media: string): string {
    need(bytes.byteLength <= 8 * 1024 * 1024, 'artifact_size', 'artifact exceeds 8 MiB');
    need(/^(text\/plain|text\/markdown|application\/json)$/.test(media), 'artifact_media', `unsupported media type ${media}`);
    const hash = sha256(bytes);
    const final = join(this.dir, 'artifacts', hash);
    if (!existsSync(final)) {
      // Stage, verify, fsync, then rename; the database never references partial bytes.
      const staged = join(this.dir, 'staging', `${hash}.${process.pid}.${Date.now()}`);
      const fd = openSync(staged, 'wx'); try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      need(sha256(readFileSync(staged)) === hash, 'artifact_corrupt', 'staged artifact failed verification');
      renameSync(staged, final);
    }
    this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?,?)').run(hash, bytes.byteLength, media);
    return hash;
  }
  hasArtifact = (hash: string): boolean => {
    const row = this.db.prepare('SELECT size FROM artifacts WHERE hash=?').get(hash);
    const path = join(this.dir, 'artifacts', hash);
    return !!row && existsSync(path) && statSync(path).size === Number(row.size);
  };
  readArtifact(hash: string): { bytes: Buffer; media: string } {
    const row = this.db.prepare('SELECT media FROM artifacts WHERE hash=?').get(hash);
    need(row && this.hasArtifact(hash), 'artifact_missing', `artifact ${hash.slice(0, 12)} missing`);
    const bytes = readFileSync(join(this.dir, 'artifacts', hash));
    need(sha256(bytes) === hash, 'artifact_corrupt', `artifact ${hash.slice(0, 12)} failed verification`);
    return { bytes, media: String(row.media) };
  }

  // ---------- State ----------
  createProject(worldId: string, genesis: Record<string, string>): string {
    need(isRecordId(worldId), 'type_error', 'invalid world ID');
    return this.tx(() => {
      const pkg = this.storePackage(genesis);
      need(pkg.manifest.parent === null, 'package_manifest', 'genesis package must have no parent');
      this.db.prepare("INSERT INTO worlds VALUES (?,NULL,NULL,'live','active',?,0,?)").run(worldId, pkg.hash, canonical(pkg.manifest.capabilities));
      this.db.prepare('INSERT INTO capabilities VALUES (?,?,NULL,?,?,NULL,0)').run(`cap-owner-${worldId}`, worldId, 'owner', canonical(pkg.manifest.capabilities));
      this.event(worldId, 'project_created', { package: pkg.hash }, 0);
      return pkg.hash;
    });
  }
  world(id: string) {
    const row = this.db.prepare('SELECT * FROM worlds WHERE id=?').get(id);
    need(row, 'not_found', `unknown world ${id}`);
    return { id, kind: String(row.kind), status: String(row.status), parent: row.parent as string | null, revision: Number(row.revision), packageHash: String(row.package) };
  }
  worlds() { return this.db.prepare('SELECT id,kind,status,parent,revision,package FROM worlds ORDER BY id').all(); }
  state(id: string): WorldState {
    const w = this.db.prepare('SELECT * FROM worlds WHERE id=?').get(id);
    need(w, 'not_found', `unknown world ${id}`);
    const records = new Map(this.db.prepare('SELECT * FROM records WHERE world=?').all(id).map((r: any) => [r.id, { id: r.id, type: r.type, rev: Number(r.rev), data: JSON.parse(r.data) }]));
    const relations = new Map(this.db.prepare('SELECT * FROM relations WHERE world=?').all(id).map((r: any) => [r.id, { id: r.id, relation: r.relation, from: r.src, to: r.dst, data: JSON.parse(r.data) }]));
    const decisions = new Map(this.db.prepare('SELECT * FROM decisions WHERE world=?').all(id).map((r: any) => [r.id, JSON.parse(r.data) as Decision]));
    return { id, revision: Number(w.revision), packageHash: String(w.package), grant: JSON.parse(String(w.grant_caps)), records, relations, decisions };
  }
  // The authoritative ledger for live/recovery worlds; shadows for practice worlds.
  ledger(world?: string): Obligation[] {
    if (world && this.world(world).kind === 'proposal')
      return this.db.prepare('SELECT data FROM shadow_obligations WHERE world=? ORDER BY id').all(world).map((r: any) => JSON.parse(r.data));
    return this.db.prepare('SELECT data FROM obligations ORDER BY id').all().map((r: any) => JSON.parse(r.data));
  }
  pendingWork(): Obligation[] { return this.ledger().filter(o => o.status === 'open' || o.status === 'blocked'); }
  // Live review jobs only (practice jobs live in shadow_tasks). The row's world column is authoritative.
  tasks(world?: string): (Task & { generation: number })[] {
    if (world && this.world(world).kind === 'proposal')
      return (this.db.prepare('SELECT * FROM shadow_tasks WHERE world=? ORDER BY id').all(world) as any[]).map(r => ({ ...JSON.parse(r.data), world: r.world, status: r.status, generation: 0 }));
    const rows = world ? this.db.prepare('SELECT * FROM tasks WHERE world=? ORDER BY id').all(world) : this.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    return rows.map((r: any) => ({ ...JSON.parse(r.data), world: r.world, status: r.status, generation: Number(r.generation) }));
  }
  dispositions(): Disposition[] { return this.db.prepare('SELECT data FROM dispositions').all().map((r: any) => JSON.parse(r.data)); }
  ctx(world?: string): Context { return { packages: this.pkg, artifacts: this.hasArtifact, tasks: this.tasks(world) }; }

  private applyPlan(plan: Plan, command: string | null, kind: string, rebind = false) {
    const w = this.world(plan.world);
    need(w.revision === plan.fromRevision, 'stale_revision', `world ${plan.world} changed during commit`);
    const shadow = w.kind === 'proposal';
    for (const op of plan.ops) this.applyOp(plan.world, op, shadow, rebind);
    this.event(plan.world, kind, { notes: plan.notes, ops: plan.ops.map(o => o.op) }, plan.toRevision, command);
  }
  private applyOp(world: string, op: HostOp, shadow: boolean, rebind = false) {
    switch (op.op) {
      case 'put_record': this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?)').run(world, op.record.id, op.record.type, op.record.rev, canonical(op.record.data)); break;
      case 'put_relation': this.db.prepare('INSERT OR REPLACE INTO relations VALUES (?,?,?,?,?,?)').run(world, op.relation.id, op.relation.relation, op.relation.from, op.relation.to, canonical(op.relation.data)); break;
      case 'put_decision': this.db.prepare('INSERT OR REPLACE INTO decisions VALUES (?,?,?)').run(world, op.decision.id, canonical(op.decision)); break;
      case 'put_obligation':
        need(op.obligation.world === world, 'binding_mismatch', 'plan writes an obligation bound elsewhere');
        if (shadow) this.db.prepare('INSERT OR REPLACE INTO shadow_obligations VALUES (?,?,?)').run(world, op.obligation.id, canonical(op.obligation));
        else {
          const prior = this.db.prepare('SELECT world FROM obligations WHERE id=?').get(op.obligation.id);
          need(!prior || prior.world === world || rebind, 'binding_mismatch', `obligation ${op.obligation.id} has another authoritative binding`);
          this.db.prepare('INSERT OR REPLACE INTO obligations VALUES (?,?,?,?)').run(op.obligation.id, world, op.obligation.status, canonical(op.obligation));
        }
        break;
      case 'put_evidence': this.db.prepare('INSERT INTO evidence(world,obligation,data) VALUES (?,?,?)').run(world, op.obligation, canonical({ ...op, shadow })); break;
      case 'put_task':
        if (shadow) this.db.prepare('INSERT OR REPLACE INTO shadow_tasks VALUES (?,?,?,?,?)').run(world, op.task.id, op.task.obligation, op.task.status, canonical({ ...op.task, world }));
        else this.db.prepare('INSERT INTO tasks(id,world,obligation,status,data) VALUES (?,?,?,?,?)').run(op.task.id, world, op.task.obligation, op.task.status, canonical({ ...op.task, world }));
        break;
      case 'rebind_task': {
        if (shadow) break; // practice worlds never own dispatchable jobs
        const t = this.db.prepare('SELECT data,status FROM tasks WHERE id=?').get(op.task);
        need(t && ['queued', 'reconcile', 'failed'].includes(String(t.status)), 'task_running', `job ${op.task} is no longer paused`);
        this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(canonical({ ...JSON.parse(String(t.data)), packageHash: op.packageHash }), op.task);
        break;
      }
      case 'set_world': this.db.prepare('UPDATE worlds SET revision=?, package=?, grant_caps=? WHERE id=?').run(op.revision, op.packageHash, canonical(op.grant), world); break;
    }
  }

  // ---------- Commands ----------
  private idempotent(operationId: string, payload: unknown, run: () => Outcome): Outcome {
    need(typeof operationId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(operationId), 'type_error', 'invalid operation ID');
    const d = digest(payload);
    const prior = this.db.prepare('SELECT digest,outcome FROM commands WHERE id=?').get(operationId);
    if (prior) {
      if (prior.digest !== d) return { status: 'rejected', code: 'operation_mismatch', reasons: [`operation ${operationId} was already used with a different payload`] };
      return JSON.parse(String(prior.outcome));
    }
    let outcome: Outcome;
    try { outcome = this.tx(() => { const o = run(); this.db.prepare('INSERT INTO commands VALUES (?,?,?)').run(operationId, d, canonical(o)); return o; }); }
    catch (error: any) {
      const reasons = error instanceof Rejection ? error.reasons : [error.message];
      outcome = { status: 'rejected', code: error.code ?? 'error', reasons };
      // Rejections are journaled too, so a retried ID returns the same answer.
      if (!(error.code === 'stale_revision' || error.code === 'activation_stale' || error.code === 'budget_exhausted'))
        this.tx(() => this.db.prepare('INSERT OR IGNORE INTO commands VALUES (?,?,?)').run(operationId, d, canonical(outcome)));
    }
    return outcome;
  }
  // The recorded outcome of an operation ID, if any (lets the shell answer a repeated form submit).
  priorOutcome(operationId: string): Outcome | null {
    const row = this.db.prepare('SELECT outcome FROM commands WHERE id=?').get(operationId);
    return row ? JSON.parse(String(row.outcome)) : null;
  }
  private resolveAuthority(ref: string, world: string, principal: Principal): Authority {
    const row = this.db.prepare('SELECT * FROM capabilities WHERE id=?').get(ref);
    need(row && !row.revoked && row.principal === principal, 'capability_denied', 'capability reference is not valid for this principal');
    // Owner scope: its world, that world's practice copies, and retained ancestor branches.
    const root = row.world === world || (row.principal === 'owner' && ((this.world(world).parent !== null && this.rootLive(world) === row.world) || this.lineage(String(row.world)).includes(world)));
    need(root, 'capability_denied', 'capability is scoped to another world');
    // The owner's root authority follows the world's host-approved grant; delegated rows are fixed attenuations.
    const caps: Capability[] = principal === 'owner' ? this.state(world).grant : JSON.parse(String(row.caps));
    return { principal, capabilities: new Set(caps), obligation: row.obligation ? String(row.obligation) : undefined };
  }
  private rootLive(world: string): string { let w = this.world(world); while (w.parent && w.kind !== 'live') w = this.world(w.parent); return w.id; }
  // Live branches this world was restored from (nearest first), via their retained snapshots.
  lineage(world: string): string[] {
    const out: string[] = []; let w = this.world(world);
    while (w.parent) { w = this.world(w.parent); if (w.kind === 'live') out.push(w.id); if (out.length > 64) break; }
    return out;
  }

  // The host attaches the principal; a payload can never choose it.
  run(envelope: Envelope, principal: Principal = 'owner'): Outcome {
    return this.idempotent(envelope.operationId, { envelope, principal }, () => {
      const w = this.world(envelope.worldId);
      // A retained branch accepts only continuations of obligations still bound to it.
      const retainedContinuation = w.kind === 'live' && w.status === 'retained' && this.ledger().some(o => o.world === w.id &&
        (o.status === 'open' || o.status === 'blocked') && o.continuation.packageHash === envelope.packageHash && o.continuation.action === envelope.actionId);
      need((w.kind === 'live' && w.status === 'active') || (w.kind === 'proposal' && w.status === 'previewable') || retainedContinuation,
        'world_inactive', `world ${w.id} is ${w.kind}/${w.status}`);
      const authority = this.resolveAuthority(envelope.capabilityRef, envelope.worldId, principal);
      if (envelope.attemptFence) this.checkFence(envelope.attemptFence, principal);
      const state = this.state(envelope.worldId);
      need(state.revision === envelope.expectedRevision, 'stale_revision', `project changed (revision ${state.revision}, expected ${envelope.expectedRevision})`);
      const ledger = this.ledger(envelope.worldId);
      // Executing package: the active one, or the pinned continuation package of a live obligation.
      let executing: Package | undefined;
      if (envelope.packageHash === state.packageHash) {
        executing = this.pkg(state.packageHash);
        need(executing, 'package_unavailable', 'active package unavailable; open recovery');
      } else {
        const pinned = ledger.find(o => o.world === envelope.worldId && o.status === 'open' && o.continuation.packageHash === envelope.packageHash && o.continuation.action === envelope.actionId);
        need(pinned, 'package_mismatch', 'envelope names a package that is neither active nor a pinned continuation');
        executing = this.pkg(envelope.packageHash);
        need(executing, 'continuation_missing', 'pinned continuation package is unavailable');
      }
      const ctx = this.ctx(envelope.worldId);
      const evaluation = evaluateAction(executing, envelope.actionId, envelope.input, worldView(state, ledger, ctx), new Budget());
      if (!evaluation.ok) throw new HostError(evaluation.code, evaluation.reason);
      const plan = authorizeAction({ state, ledger, ctx, executing, actionId: envelope.actionId, authority, operationId: envelope.operationId, primitives: evaluation.primitives });
      this.applyPlan(plan, envelope.operationId, `action:${envelope.actionId}`);
      return { status: 'committed', revision: plan.toRevision, notes: plan.notes };
    });
  }
  finalize(operationId: string, worldId: string, expectedRevision: number, decisionId: string, choice: string, principal: Principal = 'owner'): Outcome {
    return this.idempotent(operationId, { finalize: { worldId, expectedRevision, decisionId, choice, principal } }, () => {
      const state = this.state(worldId);
      need(state.revision === expectedRevision, 'stale_revision', `project changed (revision ${state.revision}, expected ${expectedRevision})`);
      const fw = this.world(worldId);
      need((fw.kind === 'live' && fw.status === 'active') || (fw.kind === 'proposal' && fw.status === 'previewable'), 'world_inactive', 'decisions are finalized in the active branch (or rehearsed in a practice world)');
      // Every live branch sharing this decision's reviews gates it, not only the branch it was restored from.
      const branches = (this.worlds() as any[]).filter(w => w.kind === 'live' && w.id !== worldId).map(w => String(w.id));
      const plan = finalizeDecision(state, this.ledger(worldId), this.ctx(worldId), principal, decisionId, choice, branches);
      this.applyPlan(plan, operationId, 'decision_finalized');
      return { status: 'committed', revision: plan.toRevision, notes: [] };
    });
  }
  dispose(operationId: string, worldId: string, expectedRevision: number, obligation: string, kind: 'cancel' | 'supersede', reason: string, successor: string | null = null, principal: Principal = 'owner'): Outcome {
    return this.idempotent(operationId, { dispose: { worldId, expectedRevision, obligation, kind, reason, successor, principal } }, () => {
      need(this.world(worldId).kind !== 'proposal', 'world_inactive', 'dispositions apply to authoritative bindings only');
      const { plan, disposition } = disposeObligation(this.state(worldId), this.ledger(worldId), principal, expectedRevision, obligation, kind, reason, successor);
      this.applyPlan(plan, operationId, 'obligation_disposed');
      // Its waiting review jobs have nothing left to review.
      this.db.prepare("UPDATE tasks SET status='cancelled' WHERE obligation=? AND status IN ('queued','reconcile','failed')").run(obligation);
      this.db.prepare('INSERT INTO dispositions VALUES (?,?,?,?)').run(disposition.id, worldId, obligation, canonical(disposition));
      return { status: 'committed', revision: plan.toRevision, notes: [`Disposition ${disposition.id} recorded`] };
    });
  }

  // ---------- Jobs: attempts, fences, allowance ----------
  grantAllowance(root: string, total: number) {
    need(Number.isSafeInteger(total) && total >= 0 && total <= 100, 'type_error', 'allowance must be 0..100');
    this.tx(() => {
      const row = this.db.prepare('SELECT total FROM allowances WHERE root=?').get(root);
      if (row) this.db.prepare('UPDATE allowances SET total=total+? WHERE root=?').run(total, root);
      else this.db.prepare('INSERT INTO allowances VALUES (?,?,0)').run(root, total);
    });
  }
  // The single finite dispatch ledger: author attempts and review jobs both draw from it.
  // Call inside a host transaction. An uncertain launch keeps its unit; only the owner replenishes.
  private chargeUnit(root: string, purpose: string) {
    const a = this.allowance(root);
    need(a && a.used < a.total, 'allowance_exhausted', `root dispatch allowance ${root} is exhausted`);
    this.db.prepare('UPDATE allowances SET used=used+1 WHERE root=?').run(root);
    this.event('host', 'allowance_charged', { root, purpose, used: a.used + 1, total: a.total });
  }
  authorModel(): string | null { const r = this.db.prepare("SELECT value FROM host_state WHERE key='author_model'").get(); return r ? String(r.value) : null; }
  setAuthorModel(model: string, principal: Principal = 'owner') {
    need(principal === 'owner', 'principal_denied', 'only the owner chooses the authoring model');
    need(/^[a-zA-Z0-9_.-]{1,100}$/.test(model), 'type_error', 'invalid model name');
    this.tx(() => { this.db.prepare("INSERT OR REPLACE INTO host_state VALUES ('author_model', ?)").run(model); this.event('host', 'author_model_set', { model }); });
  }
  allowances() { return this.db.prepare('SELECT root,total,used FROM allowances ORDER BY root').all() as { root: string; total: number; used: number }[]; }
  recordEvent(kind: string, data: unknown) { this.tx(() => this.event('host', kind, data)); }
  reserveUnit(root: string, purpose: string) { this.tx(() => this.chargeUnit(root, purpose)); }
  allowance(root: string): { total: number; used: number } | undefined {
    const r = this.db.prepare('SELECT total,used FROM allowances WHERE root=?').get(root);
    return r ? { total: Number(r.total), used: Number(r.used) } : undefined;
  }
  // Reserve one invocation unit before launch; a new attempt fences out every older one.
  startAttempt(taskId: string, root: string): { task: string; generation: number; epoch: number; capabilityRef: string } {
    return this.tx(() => {
      const t = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      need(t, 'not_found', `no task ${taskId}`);
      need(t.status === 'queued' || t.status === 'running', 'task_closed', `task ${taskId} is ${t.status}`);
      need(this.world(String(t.world)).kind === 'live' && this.world(String(t.world)).status === 'active', 'dispatch_denied', 'only active live worlds dispatch model work');
      this.chargeUnit(root, `review ${taskId}`);
      const generation = Number(t.generation) + 1;
      this.db.prepare("UPDATE attempts SET status='superseded' WHERE task=? AND status='running'").run(taskId);
      // Bind the subject exactly as the reviewer will see it at dispatch.
      const ob = this.ledger().find(o => o.id === String(t.obligation));
      need(ob && ob.status === 'open', 'task_closed', `obligation ${t.obligation} is not open`);
      const subject = subjectDigest(ob, this.state(String(t.world)), this.ctx(String(t.world)));
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,NULL,?)').run(taskId, generation, this.epoch, 'running', subject);
      this.db.prepare("UPDATE tasks SET status='running', generation=? WHERE id=?").run(generation, taskId);
      const cap = `cap-${taskId}-g${generation}`;
      // Attenuated: evidence for exactly this obligation, nothing else.
      this.db.prepare("INSERT INTO capabilities VALUES (?,?,?,?,?,?,0)").run(cap, t.world, `cap-owner-${t.world}`, `job:${taskId}`, canonical(['evidence.submit']), t.obligation);
      this.db.prepare('UPDATE capabilities SET revoked=1 WHERE principal=? AND id<>?').run(`job:${taskId}`, cap);
      const data = JSON.parse(String(t.data)); data.status = 'running';
      this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(canonical(data), taskId);
      this.event(String(t.world), 'attempt_started', { task: taskId, generation, epoch: this.epoch, root });
      return { task: taskId, generation, epoch: this.epoch, capabilityRef: cap };
    });
  }
  private checkFence(fence: { task: string; generation: number; epoch: number }, principal: Principal) {
    need(principal === `job:${fence.task}`, 'fence_invalid', 'fence does not belong to this principal');
    const t = this.db.prepare('SELECT status,generation FROM tasks WHERE id=?').get(fence.task);
    need(t && t.status === 'running', 'fence_invalid', `task ${fence.task} is not running (cancelled or finished)`);
    need(Number(t.generation) === fence.generation, 'fence_stale', `attempt generation ${fence.generation} was replaced by ${t.generation}`);
    need(fence.epoch === this.epoch, 'fence_stale', `attempt belongs to controller epoch ${fence.epoch}; current epoch is ${this.epoch}`);
    const a = this.db.prepare('SELECT status FROM attempts WHERE task=? AND generation=?').get(fence.task, fence.generation);
    need(a?.status === 'running', 'fence_stale', 'attempt is no longer running');
  }
  // A review result is accepted only through the obligation's continuation, under the attempt fence.
  completeReview(fence: { task: string; generation: number; epoch: number; capabilityRef: string }, result: { verdict: string; note: string; report: string }): Outcome {
    const t = this.tasks().find(x => x.id === fence.task);
    if (!t) return { status: 'rejected', code: 'not_found', reasons: [`no task ${fence.task}`] };
    const ob = this.ledger().find(o => o.id === t.obligation);
    if (!ob) return { status: 'rejected', code: 'not_found', reasons: ['obligation missing'] };
    // A review applies only to the subject it was dispatched with.
    const attempt = this.db.prepare('SELECT subject,status FROM attempts WHERE task=? AND generation=?').get(fence.task, fence.generation);
    if (attempt?.status === 'running' && ob.world === t.world && subjectDigest(ob, this.state(t.world), this.ctx(t.world)) !== attempt.subject) {
      this.failAttempt(fence, 'subject changed since dispatch; this review does not apply to the current subject');
      return { status: 'rejected', code: 'subject_changed', reasons: [`The subject of ${ob.id} changed after the review was dispatched; this review does not apply. Retry to review the current subject.`] };
    }
    let artifact: string;
    try { artifact = this.putArtifact(Buffer.from(result.report), 'text/markdown'); } catch (e: any) { return { status: 'rejected', code: e.code, reasons: [e.message] }; }
    const operationId = `review-${fence.task}-g${fence.generation}`;
    const w = this.world(t.world);
    const outcome = this.run({ operationId, worldId: t.world, expectedRevision: w.revision, packageHash: ob.continuation.packageHash, capabilityRef: fence.capabilityRef,
      actionId: ob.continuation.action, input: this.continuationInput(ob, result.verdict, result.note, artifact), attemptFence: fence }, `job:${fence.task}`);
    // A refused result must not leave the attempt running forever (it would block retries).
    if (outcome.status === 'rejected') {
      // Only the current, valid attempt is failed; a stale or superseded result changes nothing.
      const current = this.db.prepare('SELECT t.generation AS g, a.status AS s, a.epoch AS e FROM tasks t JOIN attempts a ON a.task=t.id AND a.generation=? WHERE t.id=?').get(fence.generation, fence.task) as any;
      if (current && Number(current.g) === fence.generation && current.s === 'running' && Number(current.e) === this.epoch && fence.epoch === this.epoch)
        this.failAttempt(fence, `result refused: ${outcome.reasons.join('; ').slice(0, 300)}`);
      return outcome;
    }
    if (outcome.status === 'committed') this.tx(() => {
      this.db.prepare("UPDATE tasks SET status='succeeded' WHERE id=? AND generation=?").run(fence.task, fence.generation);
      this.db.prepare("UPDATE attempts SET status='succeeded', result=? WHERE task=? AND generation=?").run(artifact, fence.task, fence.generation);
      this.db.prepare('UPDATE capabilities SET revoked=1 WHERE principal=?').run(`job:${fence.task}`);
    });
    return outcome;
  }
  continuationInput(ob: Obligation, verdict: string, note: string, artifact: string | null): Record<string, Json> {
    const action = this.pkg(ob.continuation.packageHash)?.actions.get(ob.continuation.action);
    const all: Record<string, Json> = { obligation: ob.id, verdict, note, artifact };
    return Object.fromEntries(Object.entries(all).filter(([k, v]) => action && k in action.inputs && v !== null));
  }
  // Attempts left running by an earlier controller epoch have unknown outcomes:
  // mark them uncertain, keep their reservation, and wait for an owner decision.
  reconcileAttempts(): string[] {
    return this.tx(() => {
      const stale = this.db.prepare("SELECT task,generation,epoch FROM attempts WHERE status='running' AND epoch<?").all(this.epoch) as any[];
      for (const a of stale) {
        this.db.prepare("UPDATE attempts SET status='uncertain' WHERE task=? AND generation=?").run(a.task, a.generation);
        this.db.prepare("UPDATE tasks SET status='reconcile' WHERE id=? AND status='running'").run(a.task);
        this.db.prepare('UPDATE capabilities SET revoked=1 WHERE principal=?').run(`job:${a.task}`);
        const t = this.db.prepare('SELECT world FROM tasks WHERE id=?').get(a.task);
        this.event(String(t?.world), 'attempt_uncertain', { task: a.task, generation: a.generation, epoch: a.epoch,
          note: 'Interrupted: the model call may have run and incurred cost. Not retried automatically.' });
      }
      return stale.map(a => `${a.task}#${a.generation}`);
    });
  }
  // Owner decision after reconciliation: allow one more attempt (which consumes allowance).
  retryTask(taskId: string, principal: Principal = 'owner') {
    need(principal === 'owner', 'principal_denied', 'only the owner can retry an uncertain job');
    this.tx(() => {
      const t = this.db.prepare('SELECT world,status FROM tasks WHERE id=?').get(taskId);
      need(t && (t.status === 'reconcile' || t.status === 'failed'), 'task_state', `task ${taskId} is not awaiting reconciliation`);
      this.db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(taskId);
      this.event(String(t.world), 'task_retry_authorized', { task: taskId });
    });
  }
  // After a non-accepting verdict a job-discharged obligation has no job left; the owner can
  // queue another review of the current subject (charged when dispatched). Keeps C3 reachable.
  requestAnotherReview(obligationId: string, principal: Principal = 'owner'): string {
    need(principal === 'owner', 'principal_denied', 'only the owner requests another review');
    return this.tx(() => {
      const ob = this.ledger().find(o => o.id === obligationId);
      need(ob && ob.status === 'open' && ob.policy.discharge === 'job', 'task_invalid', `${obligationId} is not an open job-discharged review`);
      const w = this.world(ob.world);
      need(w.kind === 'live' && w.status === 'active', 'dispatch_denied', 'reviews are requested in the active branch');
      const tasks = this.tasks().filter(t => t.obligation === ob.id);
      need(!tasks.some(t => ['queued', 'running', 'reconcile'].includes(t.status)), 'task_duplicate', `${ob.id} already has a review job waiting or running`);
      const last = tasks.at(-1);
      need(last, 'task_invalid', `${ob.id} has no earlier review job to repeat`);
      const id = `task-${ob.id}-again-${tasks.length + 1}`;
      // The new job belongs to the obligation's current branch, whatever branch the earlier job ran in.
      const { generation: _g, ...data } = { ...(last as any), world: ob.world };
      this.db.prepare('INSERT INTO tasks(id,world,obligation,status,data) VALUES (?,?,?,?,?)').run(id, ob.world, ob.id, 'queued',
        canonical({ ...data, id, status: 'queued', createdRevision: w.revision }));
      this.event(ob.world, 'review_requested_again', { obligation: ob.id, task: id });
      return id;
    });
  }
  failAttempt(fence: { task: string; generation: number }, reason: string) {
    this.tx(() => {
      this.db.prepare("UPDATE attempts SET status='failed', result=? WHERE task=? AND generation=? AND status='running'").run(reason.slice(0, 500), fence.task, fence.generation);
      this.db.prepare("UPDATE tasks SET status='failed' WHERE id=? AND generation=? AND status='running'").run(fence.task, fence.generation);
      // Revoke only this attempt's capability; a newer attempt of the same task keeps its authority.
      this.db.prepare('UPDATE capabilities SET revoked=1 WHERE id=?').run(`cap-${fence.task}-g${fence.generation}`);
      const t = this.db.prepare('SELECT world FROM tasks WHERE id=?').get(fence.task);
      this.event(String(t?.world), 'attempt_failed', { task: fence.task, generation: fence.generation, reason: reason.slice(0, 500) });
    });
  }
  attempts(taskId: string) { return this.db.prepare('SELECT generation,epoch,status,result FROM attempts WHERE task=? ORDER BY generation').all(taskId) as any[]; }
  // First start of an imported copy: fresh instance identity; nothing that carried
  // execution or approval authority in the source instance can be replayed here.
  adoptImport(): { previous: string; instance: string; paused: string[]; staleApprovals: string[] } {
    return this.tx(() => {
      const previous = this.instance;
      this.instance = randomUUID();
      this.db.prepare("UPDATE host_state SET value=? WHERE key='instance'").run(this.instance);
      const paused = (this.db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running')").all() as any[]).map(r => String(r.id));
      this.db.prepare("UPDATE attempts SET status='uncertain' WHERE status='running'").run();
      this.db.prepare("UPDATE tasks SET status='reconcile' WHERE status IN ('queued','running')").run();
      this.db.prepare("UPDATE capabilities SET revoked=1 WHERE principal<>'owner'").run();
      this.db.prepare('UPDATE allowances SET total=used').run();
      const staleApprovals = (this.db.prepare("SELECT id FROM proposals WHERE status='approved'").all() as any[]).map(r => String(r.id));
      this.db.prepare("UPDATE proposals SET status='stale' WHERE status='approved'").run();
      const live = (this.worlds() as any[]).find(w => w.kind === 'live' && w.status === 'active');
      this.event(live?.id ?? 'host', 'instance_imported', { previous, instance: this.instance, paused, staleApprovals,
        note: 'Agent work paused until the owner provisions Codex and resumes it; dispatch allowance reset to zero.' });
      return { previous, instance: this.instance, paused, staleApprovals };
    });
  }
  // Revocation is committed first; physical process cleanup is tracked separately.
  cancelTask(taskId: string) {
    this.tx(() => {
      const t = this.db.prepare('SELECT world FROM tasks WHERE id=?').get(taskId);
      need(t, 'not_found', `no task ${taskId}`);
      this.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(taskId);
      this.db.prepare("UPDATE attempts SET status='cancelled' WHERE task=? AND status='running'").run(taskId);
      this.db.prepare('UPDATE capabilities SET revoked=1 WHERE principal=?').run(`job:${taskId}`);
      this.event(String(t.world), 'task_cancelled', { task: taskId, cleanup: 'pending' });
    });
  }

  // ---------- Evolution: propose, rehearse, approve, activate ----------
  candidateHash(pkg: Package, worldId: string, baseRevision: number, grant: Capability[], jobs: string[] = []) {
    // In R mode the exact checker binary, proof source and toolchain are part of what is approved.
    const checker = this.assurance === 'R' ? checkerIdentity(this.checkerBinary).identity : null;
    return digest({ jobs, checker, package: pkg.hash, migration: digest(pkg.migration ?? null), interpreter: INTERPRETER, policy: POLICY_ID,
      capabilities: [...pkg.manifest.capabilities].sort(), grant: [...grant].sort(), parent: pkg.manifest.parent, base: { world: worldId, revision: baseRevision } });
  }
  propose(proposalId: string, worldId: string, request: string, files: Record<string, string>, supersedes: string | null = null, migrateJobs: string[] = []) {
    const result = this.proposeCore(proposalId, worldId, request, files, supersedes, migrateJobs);
    if (result.status !== 'previewable') return result;
    // Supplemental package tests run only after every protected check has passed; they can reject, never admit.
    // An error inside rehearsal rejects the proposal rather than leaving it approvable without results.
    let tests: ReturnType<Host['rehearse']>;
    try { tests = this.rehearse(proposalId); }
    catch (e: any) { tests = [{ id: 'rehearsal', title: 'Rehearsal', passed: false, failures: [`rehearsal could not run: ${String(e?.message ?? e).slice(0, 300)}`], world: '' }]; }
    const failures = tests.filter(t => !t.passed).flatMap(t => t.failures.map(x => `Package test ${t.id} failed: ${x}`));
    this.tx(() => {
      const report = { ...result.report, supplementalTests: tests };
      this.db.prepare('UPDATE proposals SET report=?, status=? WHERE id=?').run(canonical(report), failures.length ? 'rejected' : 'previewable', proposalId);
      if (failures.length) { this.db.prepare("UPDATE worlds SET status='archived' WHERE id=?").run(result.practiceWorld); this.event(worldId, 'proposal_rejected', { proposal: proposalId, problems: failures }); }
    });
    if (failures.length) return { status: 'rejected' as const, reasons: failures, report: { ...result.report, supplementalTests: tests } };
    // The preview hash already bound the protected report; test results are recorded beside it.
    return { ...result, report: { ...result.report, supplementalTests: tests } };
  }
  // Each package test runs in its own disposable copy of the practice world.
  private rehearse(proposalId: string) {
    const p = this.proposal(proposalId);
    const pkg = this.pkg(p.packageHash!)!;
    const owner = `cap-owner-${p.world}`;
    return pkg.tests.map((t, i) => {
      const scratch = `${p.practiceWorld}-t${i + 1}`;
      this.tx(() => {
        this.db.prepare("INSERT INTO worlds SELECT ?,parent,parent_revision,'proposal','previewable',package,revision,grant_caps FROM worlds WHERE id=?").run(scratch, p.practiceWorld);
        for (const table of ['records', 'relations', 'decisions', 'shadow_obligations'])
          this.db.prepare(`INSERT INTO ${table} SELECT ?,${table === 'records' ? 'id,type,rev,data' : table === 'relations' ? 'id,relation,src,dst,data' : 'id,data'} FROM ${table} WHERE world=?`).run(scratch, p.practiceWorld);
        this.db.prepare('UPDATE shadow_obligations SET data=json_set(data, \'$.world\', ?) WHERE world=?').run(scratch, scratch);
      });
      const failures: string[] = [];
      for (const [n, step] of t.steps.entries()) {
        const w = this.world(scratch);
        const op = `rehearsal:${proposalId}:${t.id}:${n}`;
        if ('action' in step || 'finalize' in step) {
          const o = 'action' in step
            ? this.run({ operationId: op, worldId: scratch, expectedRevision: w.revision, packageHash: w.packageHash, capabilityRef: owner, actionId: step.action, input: step.input })
            : this.finalize(op, scratch, w.revision, step.finalize.decision, step.finalize.choice);
          if (o.status !== step.expect) failures.push(`step ${n + 1} expected ${step.expect}, got ${o.status}${o.status === 'rejected' ? ` (${o.reasons.join('; ')})` : ''}`);
          else if (o.status === 'rejected' && step.reason && !o.reasons.join(' ').includes(step.reason)) failures.push(`step ${n + 1} was rejected for a different reason: ${o.reasons.join('; ')}`);
        } else if ('view' in step) {
          const v = this.project(scratch).views.find(x => x.id === step.view);
          if (!v || !JSON.stringify(v).includes(step.contains)) failures.push(`step ${n + 1}: view ${step.view} does not contain ${JSON.stringify(step.contains)}`);
        } else {
          const present = this.project(scratch).planner.suggestions.some(s => s.rule === step.planner);
          if (present !== step.present) failures.push(`step ${n + 1}: planner rule ${step.planner} ${present ? 'suggested' : 'not suggested'}`);
        }
      }
      this.tx(() => this.db.prepare("UPDATE worlds SET status='archived' WHERE id=?").run(scratch));
      return { id: t.id, title: t.title, passed: failures.length === 0, failures, world: scratch };
    });
  }
  private proposeCore(proposalId: string, worldId: string, request: string, files: Record<string, string>, supersedes: string | null, migrateJobs: string[]) {
    need(isRecordId(proposalId), 'type_error', 'invalid proposal ID');
    const jobs = [...new Set(migrateJobs)].sort();
    return this.tx(() => {
      const live = this.world(worldId);
      need(live.kind === 'live' && live.status === 'active', 'world_inactive', 'proposals start from the active live world');
      let pkg: Package;
      try { pkg = this.storePackage(files); }
      catch (error: any) {
        const report = { rejected: [error.message], stage: 'admission' };
        this.db.prepare("INSERT INTO proposals VALUES (?,?,NULL,?,NULL,NULL,'rejected',NULL,?,?,?)").run(proposalId, worldId, request, canonical(report), supersedes, canonical(jobs));
        this.event(worldId, 'proposal_rejected', report);
        return { status: 'rejected' as const, reasons: [error.message] };
      }
      const state = this.state(worldId); const ledger = this.ledger(worldId); const ctx = this.ctx(worldId);
      if (pkg.hash === state.packageHash) {
        const report = { rejected: ['This package is already the active version of your project; there is nothing to change.'], stage: 'admission' };
        this.db.prepare("INSERT INTO proposals VALUES (?,?,NULL,?,?,NULL,'rejected',NULL,?,?,?)").run(proposalId, worldId, request, pkg.hash, canonical(report), supersedes, canonical(jobs));
        return { status: 'rejected' as const, reasons: report.rejected };
      }
      const grant = [...pkg.manifest.capabilities];
      const core = activationCore(state, ledger, ctx, pkg, grant, undefined, jobs);
      const current = this.pkg(state.packageHash)!;
      const candidateHash = this.candidateHash(pkg, worldId, state.revision, grant, jobs);
      const report = {
        request, candidateHash, packageHash: pkg.hash, baseRevision: state.revision,
        added: {
          types: [...pkg.types.keys()].filter(t => !current.types.has(t)),
          fields: [...pkg.types.values()].flatMap(t => Object.keys(t.fields).filter(f => current.types.has(t.id) && !(f in current.types.get(t.id)!.fields)).map(f => `${t.id}.${f}`)),
          relations: [...pkg.relations.keys()].filter(r => !current.relations.has(r)),
          actions: [...pkg.actions.keys()].filter(a => !current.actions.has(a)),
          views: [...pkg.views.keys()].filter(v => !current.views.has(v)),
          plannerRules: pkg.planner.map(r => r.id).filter(id => !current.planner.some(r => r.id === id))
        },
        capabilities: { before: state.grant, after: grant },
        schemaProblems: schemaProblems(current, pkg), witnesses: core.witnesses, problems: core.problems,
        migratedRecords: core.ops.filter(o => o.op === 'put_record').length
      };
      if (core.problems.length) {
        this.db.prepare("INSERT INTO proposals VALUES (?,?,NULL,?,?,?,'rejected',NULL,?,?,?)").run(proposalId, worldId, request, pkg.hash, candidateHash, canonical(report), supersedes, canonical(jobs));
        this.event(worldId, 'proposal_rejected', { proposal: proposalId, problems: core.problems });
        return { status: 'rejected' as const, reasons: core.problems, report };
      }
      // Practice world: copied rows at this snapshot plus non-authoritative ledger shadows.
      const practice = `${proposalId}-practice`;
      this.db.prepare("INSERT INTO worlds VALUES (?,?,?,'proposal','previewable',?,?,?)").run(practice, worldId, state.revision, pkg.hash, state.revision, canonical(grant));
      this.db.prepare('INSERT INTO records SELECT ?,id,type,rev,data FROM records WHERE world=?').run(practice, worldId);
      this.db.prepare('INSERT INTO relations SELECT ?,id,relation,src,dst,data FROM relations WHERE world=?').run(practice, worldId);
      this.db.prepare('INSERT INTO decisions SELECT ?,id,data FROM decisions WHERE world=?').run(practice, worldId);
      for (const o of ledger.filter(o => o.world === worldId))
        this.db.prepare('INSERT INTO shadow_obligations VALUES (?,?,?)').run(practice, o.id, canonical({ ...o, world: practice }));
      for (const op of core.ops) this.applyOp(practice, op.op === 'put_obligation' ? { ...op, obligation: { ...op.obligation, world: practice } } : op, true);
      const preview: Preview = { candidateHash, world: worldId, baseRevision: state.revision, baseDigest: stateDigest(state, ledger), resultDigest: core.resultDigest,
        witnessDigest: digest(core.witnesses), previewHash: '' };
      preview.previewHash = digest({ ...preview, previewHash: null, report: digest(report) });
      this.db.prepare("INSERT INTO proposals VALUES (?,?,?,?,?,?,'previewable',?,?,?,?)").run(proposalId, worldId, practice, request, pkg.hash, candidateHash, canonical(preview), canonical(report), supersedes, canonical(jobs));
      this.event(worldId, 'proposal_previewable', { proposal: proposalId, previewHash: preview.previewHash });
      return { status: 'previewable' as const, preview, report, practiceWorld: practice };
    });
  }
  proposal(id: string) {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
    need(row, 'not_found', `no proposal ${id}`);
    return { id, world: String(row.world), practiceWorld: row.practice_world as string | null, status: String(row.status), packageHash: row.package as string | null,
      candidateHash: row.candidate_hash as string | null, preview: row.preview ? JSON.parse(String(row.preview)) as Preview : null, report: JSON.parse(String(row.report)), request: String(row.request),
      jobs: JSON.parse(String(row.jobs)) as string[] };
  }
  proposals(world: string) { return this.db.prepare('SELECT id,status,request FROM proposals WHERE world=? ORDER BY rowid').all(world); }
  // Owner approval through the protected surface binds exact identities; it is host-stored, never model-supplied.
  approve(proposalId: string, seen: { previewHash: string; candidateHash: string }, dispositions: string[] = [], principal: Principal = 'owner'): ApprovalReceipt {
    need(principal === 'owner', 'principal_denied', 'only the owner approves activation');
    return this.tx(() => {
      const p = this.proposal(proposalId);
      need(p.status === 'previewable' && p.preview, 'proposal_state', `proposal is ${p.status}`);
      need(seen.previewHash === p.preview.previewHash && seen.candidateHash === p.candidateHash, 'approval_mismatch', 'approval must name the exact reviewed preview and candidate');
      const receipt: ApprovalReceipt = { id: `appr-${proposalId}`, owner: 'owner', candidateHash: p.candidateHash!, previewHash: p.preview.previewHash,
        expectedRevision: p.preview.baseRevision, grant: [...this.pkg(p.packageHash!)!.manifest.capabilities], dispositions, issuedBy: 'host', instance: this.instance };
      this.db.prepare('INSERT INTO approvals VALUES (?,?,?)').run(receipt.id, proposalId, canonical(receipt));
      this.db.prepare("UPDATE proposals SET status='approved' WHERE id=?").run(proposalId);
      this.event(p.world, 'proposal_approved', { proposal: proposalId, receipt: receipt.id });
      return receipt;
    });
  }
  activate(proposalId: string): Outcome {
    try {
      const outcome = this.tx(() => {
        const p = this.proposal(proposalId);
        need(p.status === 'approved', 'proposal_state', `proposal is ${p.status}, not approved`);
        need(this.world(p.world).status === 'active', 'world_inactive', `${p.world} is no longer the active branch; propose again against the active one`);
        if (this.assurance === 'R') {
          const id = checkerIdentity(this.checkerBinary);
          if (id.problems.length) throw new Rejection(id.problems.map(p => `R mode fails closed: ${p}`), 'r_checker_unavailable');
        }
        const row = this.db.prepare('SELECT receipt FROM approvals WHERE proposal=?').get(proposalId);
        const approval = row ? JSON.parse(String(row.receipt)) as ApprovalReceipt : null;
        const candidate = this.pkg(p.packageHash!);
        need(candidate, 'package_unavailable', 'candidate package bytes unavailable');
        const state = this.state(p.world); const ledger = this.ledger(p.world);
        // Recompute identity from stored bytes; any changed bound field invalidates the receipt.
        const candidateHash = this.candidateHash(candidate, p.world, p.preview!.baseRevision, approval?.grant ?? [], p.jobs);
        const { plan } = checkActivation({ state, ledger, ctx: this.ctx(p.world), candidate, candidateHash, preview: p.preview!, approval, dispositions: this.dispositions(), instance: this.instance, migrateJobs: p.jobs });
        if (this.assurance === 'R') {
          // The Lean checker must accept, and the obligation mutations applied must be exactly its plan.
          const verdict = runRChecker(rInput({ state, ledger, ctx: this.ctx(p.world), candidate, candidateHash, preview: p.preview!, approval, dispositions: this.dispositions(), instance: this.instance }), this.checkerBinary);
          if (!verdict.accept) throw new Rejection(verdict.reasons.map(r => `R checker: ${r}`), 'r_rejected');
          const key = (o: string, h: string, a: string) => `${o}|${h}|${a}`;
          const lean = verdict.rebinds.map(r => key(r.obligation, r.packageHash, r.action)).sort();
          const ts = plan.ops.filter(o => o.op === 'put_obligation').map(o => (o as any).obligation).map((o: Obligation) => key(o.id, o.continuation.packageHash, o.continuation.action)).sort();
          if (canonical(lean) !== canonical(ts)) throw new Rejection([`R mode fails closed: the Lean plan (${lean.join(', ') || 'no rebinds'}) differs from the host plan (${ts.join(', ') || 'no rebinds'})`], 'r_disagreement');
          plan.notes.push(`R checker ${checkerIdentity(this.checkerBinary).identity!.slice(0, 12)} accepted; ${lean.length} rebind(s) applied exactly`);
        }
        const snapshot = this.snapshotInTx(p.world, `pre-activation:${proposalId}`);
        this.applyPlan(plan, `activate:${proposalId}`, 'package_activated');
        this.db.prepare("UPDATE proposals SET status='active' WHERE id=?").run(proposalId);
        this.db.prepare("UPDATE worlds SET status='archived' WHERE id=?").run(p.practiceWorld);
        this.db.prepare('INSERT INTO activations VALUES (?,?,?,?,?,?,?,?)').run(`act-${proposalId}`, proposalId, p.world, plan.fromRevision, plan.toRevision, state.packageHash, candidate.hash, snapshot);
        this.faults.beforeActivationCommit?.();
        return { status: 'committed' as const, revision: plan.toRevision, notes: [`Activated ${candidate.hash.slice(0, 12)}; snapshot ${snapshot} retained`] };
      });
      this.faults.afterActivationCommit?.();
      return outcome;
    } catch (error: any) {
      const reasons = error instanceof Rejection ? error.reasons : [error.message];
      // Stale previews may be refreshed; any other failed activation is terminal for this approval.
      const status = error.code === 'activation_stale' ? 'stale' : 'rejected';
      const row = this.db.prepare('SELECT world FROM proposals WHERE id=?').get(proposalId);
      if (row) this.tx(() => {
        this.db.prepare('UPDATE proposals SET status=? WHERE id=? AND status=\'approved\'').run(status, proposalId);
        // Its practice world no longer matches anything that can be applied.
        this.db.prepare("UPDATE worlds SET status='archived' WHERE id=(SELECT practice_world FROM proposals WHERE id=?)").run(proposalId);
        this.event(String(row.world), 'activation_rejected', { proposal: proposalId, code: error.code ?? 'error', reasons });
      });
      return { status: 'rejected', code: error.code ?? 'error', reasons };
    }
  }
  rejectProposal(proposalId: string, reason: string, principal: Principal = 'owner') {
    need(principal === 'owner', 'principal_denied', 'only the owner rejects proposals');
    this.tx(() => {
      const p = this.proposal(proposalId);
      need(['previewable', 'approved', 'stale'].includes(p.status), 'proposal_state', `proposal is ${p.status}`);
      this.db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(proposalId);
      if (p.practiceWorld) this.db.prepare("UPDATE worlds SET status='archived' WHERE id=?").run(p.practiceWorld);
      this.event(p.world, 'proposal_rejected', { proposal: proposalId, reason, by: 'owner' });
    });
  }
  // Stale preview: keep the proposed source, take a fresh snapshot, rerun checks; a new approval is required.
  refresh(proposalId: string, newId: string) {
    const p = this.proposal(proposalId);
    need(p.packageHash, 'proposal_state', 'proposal has no admitted source');
    const files = JSON.parse(String(this.db.prepare('SELECT files FROM packages WHERE hash=?').get(p.packageHash)!.files));
    this.tx(() => {
      this.db.prepare("UPDATE proposals SET status='stale' WHERE id=? AND status IN ('previewable','approved')").run(proposalId);
      if (p.practiceWorld) this.db.prepare("UPDATE worlds SET status='archived' WHERE id=?").run(p.practiceWorld);
    });
    return this.propose(newId, p.world, p.request, files, proposalId, p.jobs);
  }

  // ---------- Snapshots and recovery ----------
  private snapshotInTx(worldId: string, label: string): string {
    const w = this.world(worldId);
    const id = `snap-${worldId}-r${w.revision}-${(this.db.prepare('SELECT COUNT(*) AS n FROM worlds').get() as any).n}`;
    this.db.prepare("INSERT INTO worlds SELECT ?,id,revision,'recovery','retained',package,revision,grant_caps FROM worlds WHERE id=?").run(id, worldId);
    this.db.prepare('INSERT INTO records SELECT ?,id,type,rev,data FROM records WHERE world=?').run(id, worldId);
    this.db.prepare('INSERT INTO relations SELECT ?,id,relation,src,dst,data FROM relations WHERE world=?').run(id, worldId);
    this.db.prepare('INSERT INTO decisions SELECT ?,id,data FROM decisions WHERE world=?').run(id, worldId);
    this.event(worldId, 'snapshot_retained', { snapshot: id, label });
    return id;
  }
  snapshot(worldId: string, label: string) { return this.tx(() => this.snapshotInTx(worldId, label)); }
  // Restore = a new active branch from a retained snapshot. The newer branch, its
  // obligations (still bound to it), and the whole journal are kept; nothing merges.
  // What restoring a snapshot would leave behind, in plain words (for the confirmation page).
  restorePreview(snapshotId: string): { source: string; excluded: string[]; pending: string[] } {
    const snap = this.world(snapshotId);
    need(snap.kind === 'recovery' && snap.parent, 'not_found', `${snapshotId} is not a retained snapshot`);
    const from = this.state(snap.parent); const to = this.state(snapshotId);
    const title = (r: { id: string; data: Record<string, unknown> }) => String(r.data.title ?? r.data.statement ?? r.id);
    const added = [...from.records.values()].filter(r => !to.records.has(r.id));
    const edited = [...from.records.values()].filter(r => to.records.has(r.id) && to.records.get(r.id)!.rev !== r.rev);
    const rel = [...from.relations.values()].filter(r => JSON.stringify(to.relations.get(r.id)?.data) !== JSON.stringify(r.data)).length;
    const dec = [...from.decisions.values()].filter(d => JSON.stringify(to.decisions.get(d.id)) !== JSON.stringify(d));
    const excluded = [
      ...(added.length ? [`${added.length} item(s) added since: ${added.slice(0, 8).map(title).join(', ')}${added.length > 8 ? ', …' : ''}`] : []),
      ...(edited.length ? [`${edited.length} item(s) edited since: ${edited.slice(0, 8).map(title).join(', ')}${edited.length > 8 ? ', …' : ''}`] : []),
      ...(rel ? [`${rel} link(s) such as scores or evidence changed since`] : []),
      ...dec.map(d => to.decisions.has(d.id) ? `the decision “${d.question}” in its newer state` : `the decision “${d.question}”`),
      ...(from.packageHash !== to.packageHash ? [`the newer app version (${this.pkg(from.packageHash)?.manifest.name ?? 'unknown'} → back to ${this.pkg(to.packageHash)?.manifest.name ?? 'unknown'})`] : [])
    ];
    return { source: from.id, excluded, pending: this.pendingWork().filter(o => o.world === from.id).map(o => o.title) };
  }
  // Make a retained live branch active again; the branch being left is retained, nothing is lost.
  switchBranch(operationId: string, target: string, principal: Principal = 'owner'): Outcome {
    return this.idempotent(operationId, { switchBranch: { target, principal } }, () => {
      need(principal === 'owner', 'principal_denied', 'only the owner switches branches');
      const t = this.world(target);
      need(t.kind === 'live' && t.status === 'retained', 'world_inactive', `${target} is not a retained branch`);
      const active = (this.worlds() as any[]).find(w => w.kind === 'live' && w.status === 'active');
      if (active) { this.db.prepare("UPDATE worlds SET status='retained' WHERE id=?").run(active.id); this.db.prepare('UPDATE capabilities SET revoked=1 WHERE id=?').run(`cap-owner-${active.id}`); }
      this.db.prepare("UPDATE worlds SET status='active' WHERE id=?").run(target);
      this.db.prepare("INSERT INTO capabilities VALUES (?,?,NULL,'owner','[]',NULL,0) ON CONFLICT(id) DO UPDATE SET revoked=0").run(`cap-owner-${target}`, target);
      this.event(target, 'branch_switched', { from: active?.id ?? null, to: target });
      return { status: 'committed', revision: t.revision, notes: [`Now working on ${target}. ${active ? `${active.id} is kept and you can switch back to it.` : ''}`] };
    });
  }
  // Latest recorded verdict per obligation (authoritative worlds only).
  lastReviews(): Map<string, { verdict: string; note: string }> {
    const out = new Map<string, { verdict: string; note: string }>();
    for (const r of this.db.prepare('SELECT obligation, data FROM evidence ORDER BY seq').all() as any[]) {
      const d = JSON.parse(String(r.data)); if (!d.shadow) out.set(String(r.obligation), { verdict: d.verdict, note: d.note });
    }
    return out;
  }
  // A readable, unused record ID derived from a title.
  newId(world: string, base: string): string {
    const stem = (base.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '') || 'item').slice(0, 50);
    const s = this.state(world); const taken = (id: string) => s.records.has(id) || s.decisions.has(id);
    let id = stem, k = 2; while (taken(id)) id = `${stem}-${k++}`; return id;
  }
  newKey(base: string): string {
    const stem = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'review';
    const ids = new Set(this.ledger().map(o => o.id));
    let k = 1; while (ids.has(`ob-${stem}-${k}`)) k++; return `${stem}-${k}`;
  }
  restore(operationId: string, snapshotId: string, principal: Principal = 'owner'): Outcome & { branch?: string; excluded?: string[] } {
    let details: { branch: string; excluded: string[] } | undefined;
    const outcome = this.idempotent(operationId, { restore: { snapshotId, principal } }, () => {
      need(principal === 'owner', 'principal_denied', 'only the owner restores a snapshot');
      const snap = this.world(snapshotId);
      need(snap.kind === 'recovery' && snap.parent, 'not_found', `${snapshotId} is not a retained snapshot`);
      const source = this.world(snap.parent);
      need(source.kind === 'live' && source.status === 'active', 'world_inactive', `snapshot source ${source.id} is not the active branch`);
      need(this.pkg(snap.packageHash), 'package_unavailable', `snapshot package ${snap.packageHash.slice(0, 12)} is unavailable`);
      const stem = source.id.replace(/-b\d+$/, '');
      let k = (this.db.prepare("SELECT COUNT(*) AS n FROM worlds WHERE kind='live'").get() as any).n + 1;
      while (this.db.prepare('SELECT 1 FROM worlds WHERE id=?').get(`${stem}-b${k}`)) k++;
      const branch = `${stem}-b${k}`;
      const from = this.state(source.id); const to = this.state(snapshotId);
      const excluded = [
        ...[...from.records.values()].filter(r => !to.records.has(r.id)).map(r => `record ${r.id} (added after the snapshot)`),
        ...[...from.records.values()].filter(r => to.records.has(r.id) && to.records.get(r.id)!.rev !== r.rev).map(r => `record ${r.id} (edited after the snapshot)`),
        ...[...from.relations.values()].filter(r => JSON.stringify(to.relations.get(r.id)?.data) !== JSON.stringify(r.data)).map(r => `relation ${r.id}`),
        ...[...from.decisions.values()].filter(d => JSON.stringify(to.decisions.get(d.id)) !== JSON.stringify(d)).map(d => `decision ${d.id}`),
        ...(from.packageHash !== to.packageHash ? [`application package ${from.packageHash.slice(0, 12)} (branch returns to ${to.packageHash.slice(0, 12)})`] : [])
      ];
      this.db.prepare("INSERT INTO worlds SELECT ?,id,revision,'live','active',package,revision,grant_caps FROM worlds WHERE id=?").run(branch, snapshotId);
      this.db.prepare('INSERT INTO records SELECT ?,id,type,rev,data FROM records WHERE world=?').run(branch, snapshotId);
      this.db.prepare('INSERT INTO relations SELECT ?,id,relation,src,dst,data FROM relations WHERE world=?').run(branch, snapshotId);
      this.db.prepare('INSERT INTO decisions SELECT ?,id,data FROM decisions WHERE world=?').run(branch, snapshotId);
      this.db.prepare("UPDATE worlds SET status='retained' WHERE id=?").run(source.id);
      this.db.prepare('INSERT INTO capabilities VALUES (?,?,NULL,?,?,NULL,0)').run(`cap-owner-${branch}`, branch, 'owner', canonical(to.grant));
      this.db.prepare("UPDATE capabilities SET revoked=1 WHERE id=?").run(`cap-owner-${source.id}`);
      const pending = this.pendingWork().filter(o => o.world === source.id).map(o => o.id);
      this.event(source.id, 'branch_retained', { restoredTo: branch, snapshot: snapshotId, excluded, pending });
      this.event(branch, 'snapshot_restored', { snapshot: snapshotId, retained: source.id, excluded, pending });
      details = { branch, excluded };
      return { status: 'committed', revision: to.revision, notes: [`Restored ${snapshotId} as ${branch}. ${source.id} is retained with ${excluded.length} newer change(s); ${pending.length} commitment(s) stay bound to it.`, ...excluded.map(e => `Not in this branch: ${e}`)] };
    });
    return { ...outcome, ...(details ?? {}) };
  }
  transfer(operationId: string, obligationId: string, toWorld: string, expectedRevision: number, principal: Principal = 'owner'): Outcome {
    return this.idempotent(operationId, { transfer: { obligationId, toWorld, expectedRevision, principal } }, () => {
      need(this.world(toWorld).kind === 'live' && this.world(toWorld).status === 'active', 'world_inactive', 'transfer into the active branch only');
      const from = this.ledger().find(o => o.id === obligationId)?.world;
      need(!this.tasks().some(t => t.obligation === obligationId && t.status === 'running'), 'task_running', `a review job for ${obligationId} is running; let it finish or stop it before transferring`);
      const plan = transferObligation(this.state(toWorld), this.ledger(), this.ctx(toWorld), principal, obligationId, this.lineage(toWorld), expectedRevision);
      this.applyPlan(plan, operationId, 'obligation_transferred', true);
      // Its not-yet-running review jobs move with it, so the continuation stays reachable.
      for (const t of this.tasks().filter(t => t.obligation === obligationId && ['queued', 'reconcile', 'failed'].includes(t.status)))
        this.db.prepare('UPDATE tasks SET world=?, data=? WHERE id=?').run(toWorld, canonical({ ...JSON.parse(String(this.db.prepare('SELECT data FROM tasks WHERE id=?').get(t.id)!.data)), world: toWorld }), t.id);
      if (from) this.event(from, 'obligation_transferred_out', { obligation: obligationId, to: toWorld });
      return { status: 'committed', revision: plan.toRevision, notes: plan.notes };
    });
  }

  // ---------- Read models for the shell ----------
  project(worldId: string) {
    const state = this.state(worldId); const ledger = this.ledger(worldId); const ctx = this.ctx(worldId);
    const pkg = this.pkg(state.packageHash);
    const view = worldView(state, ledger, ctx);
    return {
      world: this.world(worldId), package: pkg ? { hash: pkg.hash, name: pkg.manifest.name, version: pkg.manifest.version } : null,
      // Interactive evaluation: each view and the planner get a step budget and a 1.5 s deadline.
      views: pkg ? pkg.manifest.views.map(v => evaluateView(pkg.views.get(v)!, view, new Budget(LIMITS.steps, 1500))) : [],
      planner: pkg ? evaluatePlanner(pkg, view, new Budget(LIMITS.steps, 1500)) : { suggestions: [], error: 'active package unavailable' },
      actions: pkg ? [...pkg.actions.values()].map(a => ({ id: a.id, title: a.title, inputs: a.inputs })) : [],
      obligations: ledger.filter(o => o.world === worldId), decisions: [...state.decisions.values()], tasks: this.tasks(worldId)
    };
  }
}
export { HostError, fail };
