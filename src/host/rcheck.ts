import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, sha256 } from './canonical.ts';
import { actionNeeds, HOST_INTERPRETERS, schemaProblems, stateDigest, type ApprovalReceipt, type Context, type Disposition, type Obligation, type Preview, type WorldState } from './checker.ts';
import { hasEvidenceRoute, type Package } from './lang.ts';

// Research release R: the executing Lean checker for obligation-preserving activation.
// The host emits one canonical input, runs the pinned binary, and fails closed.
const LEAN_ROOT = join(fileURLToPath(new URL('../../lean', import.meta.url)));
export const CHECKER_BINARY = join(LEAN_ROOT, '.lake', 'build', 'bin', 'workshop-checker');
const LOCK = join(LEAN_ROOT, 'checker-lock.json');
export type CheckerLock = { binarySha256: string; sourceHash: string; contractHash: string; toolchain: string; theorems: string[]; axioms: string[] };
export type RVerdict = { accept: true; rebinds: { obligation: string; packageHash: string; action: string }[] } | { accept: false; reasons: string[] };

export function checkerSourceHash(): string {
  const files = ['lean-toolchain', 'lakefile.toml', 'Main.lean', 'WorkshopChecker.lean', 'contract.sha256',
    ...readdirSync(join(LEAN_ROOT, 'WorkshopChecker')).filter(f => f.endsWith('.lean')).map(f => `WorkshopChecker/${f}`)].sort();
  return digest(files.map(f => [f, sha256(readFileSync(join(LEAN_ROOT, f)))]));
}
export function checkerLock(): CheckerLock | null {
  try { return JSON.parse(readFileSync(LOCK, 'utf8')); } catch { return null; }
}
// Identity bound into candidate hashes and activation events in R mode.
export function checkerIdentity(binary = CHECKER_BINARY): { problems: string[]; identity: string | null; lock: CheckerLock | null } {
  const lock = checkerLock();
  const problems: string[] = [];
  if (!lock) problems.push(`no checker lock at ${relative(process.cwd(), LOCK)} (run npm run r:build)`);
  if (!existsSync(binary)) problems.push(`checker binary missing at ${binary}`);
  if (lock && existsSync(binary) && sha256(readFileSync(binary)) !== lock.binarySha256) problems.push(`checker binary ${binary} does not match the locked build`);
  if (lock && checkerSourceHash() !== lock.sourceHash) problems.push('checker or proof source changed since the locked build (run npm run r:build)');
  return { problems, identity: problems.length ? null : digest({ binary: lock!.binarySha256, source: lock!.sourceHash, toolchain: lock!.toolchain }), lock };
}

const attestActions = (pkg: Package) => [...pkg.actions.keys()].sort().map(id => ({ id, evidenceRoute: hasEvidenceRoute(pkg.actions.get(id)!), needs: actionNeeds(pkg, id) }));

export function rInput(args: { state: WorldState; ledger: Obligation[]; ctx: Context; candidate: Package; candidateHash: string; preview: Preview;
  approval: ApprovalReceipt | null; dispositions: Disposition[]; instance: string; hostInterpreters?: string[] }) {
  const { state, ledger, ctx, candidate } = args;
  const hostInterpreters = args.hostInterpreters ?? HOST_INTERPRETERS;
  const hashes = [...new Set(ledger.map(o => o.continuation.packageHash))].sort();
  const subjects = [...new Set(ledger.filter(o => o.world === state.id).flatMap(o => o.subjects))].sort();
  const artifacts = [...new Set(ledger.flatMap(o => o.artifacts))].sort();
  return {
    world: state.id, inst: args.instance, revision: state.revision, stateDigest: stateDigest(state, ledger.filter(o => o.world === state.id) as Obligation[]),
    baseRevision: args.preview.baseRevision, baseDigest: args.preview.baseDigest, candidateHash: args.candidateHash, previewHash: args.preview.previewHash,
    approval: args.approval ? { issuedBy: args.approval.issuedBy, owner: args.approval.owner, inst: args.approval.instance, candidateHash: args.approval.candidateHash,
      previewHash: args.approval.previewHash, expectedRevision: args.approval.expectedRevision, dispositions: [...args.approval.dispositions] } : null,
    obligations: [...ledger].sort((a, b) => a.id < b.id ? -1 : 1).map(o => ({ id: o.id, world: o.world, status: o.status, subjects: [...o.subjects],
      policy: { verdicts: [...o.policy.verdicts], discharge: o.policy.discharge, independent: o.policy.independent }, gate: o.gate, successor: o.successor,
      continuation: { packageHash: o.continuation.packageHash, action: o.continuation.action }, artifacts: [...o.artifacts] })),
    dispositions: [...args.dispositions].sort((a, b) => a.id < b.id ? -1 : 1).map(d => ({ id: d.id, obligation: d.obligation, kind: d.kind, successor: d.successor, revision: d.revision, world: d.world })),
    candidate: { hash: candidate.hash, retire: [...(candidate.manifest.retire ?? [])],
      adapters: Object.entries(candidate.manifest.continuations ?? {}).sort().map(([from, to]) => ({ fromPackage: from.split(':')[0], fromAction: from.split(':')[1], toAction: to })),
      actions: attestActions(candidate) },
    grant: [...(args.approval?.grant ?? [])].sort(),
    packages: hashes.map(hash => {
      const pkg = ctx.packages(hash);
      return pkg ? { hash, available: true, interpreterOk: pkg.manifest.interpreters.some(i => hostInterpreters.includes(i)),
        schemaCompatible: pkg === candidate || pkg.hash === candidate.hash || schemaProblems(pkg, candidate).length === 0, actions: attestActions(pkg) }
        : { hash, available: false, interpreterOk: false, schemaCompatible: false, actions: [] };
    }),
    records: subjects.filter(id => state.records.has(id)),
    artifacts: artifacts.filter(a => ctx.artifacts(a))
  };
}

function exec(input: unknown, args: string[] = [], binary = CHECKER_BINARY): string {
  const id = checkerIdentity(binary);
  if (id.problems.length) throw Object.assign(new Error(`R checker unavailable: ${id.problems.join('; ')}`), { code: 'r_checker_unavailable' });
  const run = spawnSync(binary, args, { input: canonical(input), encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw Object.assign(new Error(`R checker failed (${run.error?.message ?? `exit ${run.status}`}): ${String(run.stdout).slice(0, 300)}`), { code: 'r_checker_failed' });
  return run.stdout;
}
export function runRChecker(input: unknown, binary = CHECKER_BINARY): RVerdict { return JSON.parse(exec(input, [], binary)); }
export function roundTrip(input: unknown, binary = CHECKER_BINARY): unknown { return JSON.parse(exec(input, ['--roundtrip'], binary)); }
export function checkerBuiltAt(): number | null { try { return statSync(CHECKER_BINARY).mtimeMs; } catch { return null; } }
