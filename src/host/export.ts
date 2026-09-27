import { backup } from 'node:sqlite';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, need, sha256 } from './canonical.ts';
import { Rejection } from './checker.ts';
import { Host, POLICY_ID } from './store.ts';

// Export: an explicit snapshot bundle the owner can open offline on the declared
// platform. It carries state, the artifact and package closure, the host source,
// production dependencies and (optionally) the runtime. It never carries secrets.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXPORT_FORMAT = 'workshop-export/1';
export type Runtime = { node: string; license?: string; source: string };
export type ExportManifest = {
  format: string; exportedAt: string; sourceInstance: string; policyId: string;
  platform: { os: 'linux'; arch: 'x64'; baseline: string; runtime: string | null };
  closure: { packages: string[]; artifacts: string[] };
  files: Record<string, string>; mutableState: string[];
  licenses: { name: string; version: string; license: string; file: string | null }[];
  omitted: string[]; prerequisites: string[];
};

// Everything a retained world, commitment, job or evidence record needs.
export function exportClosure(host: Host, artifactSource: Host = host) {
  // Every dependent is recorded, so a failure names everything it would break.
  const packages = new Map<string, string[]>(); const artifacts = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, hash: string | null | undefined, why: string) => { if (hash) m.set(hash, [...new Set([...(m.get(hash) ?? []), why])]); };
  const addPkg = (hash: string, why: string) => add(packages, hash, why);
  const addArt = (hash: string | null | undefined, why: string) => add(artifacts, hash, why);
  for (const w of host.worlds() as any[]) if (w.status !== 'archived') addPkg(String(w.package), `world ${w.id}`);
  for (const o of host.ledger()) { addPkg(o.continuation.packageHash, `continuation of ${o.id}`); o.artifacts.forEach(a => addArt(a, `obligation ${o.id}`)); }
  for (const t of host.tasks()) addPkg(t.packageHash, `review job ${t.id}`);
  for (const a of host.db.prepare('SELECT to_package, from_package, id FROM activations').all() as any[]) { addPkg(String(a.to_package), `activation ${a.id}`); addPkg(String(a.from_package), `activation ${a.id}`); }
  for (const e of host.db.prepare('SELECT obligation, data FROM evidence').all() as any[]) addArt(JSON.parse(String(e.data)).artifact, `evidence for ${e.obligation}`);
  for (const a of host.db.prepare("SELECT task, result FROM attempts WHERE status='succeeded'").all() as any[]) addArt(a.result as string, `review attempt ${a.task}`);
  for (const w of host.worlds() as any[]) {
    if (w.status === 'archived') continue;
    const pkg = host.pkg(String(w.package));
    for (const r of host.state(String(w.id)).records.values())
      for (const [field, spec] of Object.entries(pkg?.types.get(r.type)?.fields ?? {}))
        if (spec.type === 'artifact' && typeof r.data[field] === 'string') addArt(r.data[field] as string, `${w.id}/${r.id}.${field}`);
  }
  const missing: string[] = [];
  for (const [hash, why] of packages) if (!host.pkg(hash)) missing.push(`package ${hash} (needed by ${why.join(', ')}) is missing or fails verification`);
  for (const [hash, why] of artifacts) {
    try { artifactSource.readArtifact(hash); } catch { missing.push(`artifact ${hash} (referenced by ${why.join(', ')}) is missing or fails verification`); }
  }
  return { packages: [...packages.keys()].sort(), artifacts: [...artifacts.keys()].sort(), missing };
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path).split('\\').join('/')];
  });
}
function productionModules(): string[] {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages as Record<string, any>).filter(([k, v]) => k.startsWith('node_modules/') && !v.dev).map(([k]) => k).sort();
}

export async function createExport(host: Host, out: string, opts: { runtime?: Runtime } = {}): Promise<ExportManifest> {
  need(!existsSync(out) || readdirSync(out).length === 0, 'export_target', `export destination ${out} must be empty`);
  mkdirSync(join(out, 'state'), { recursive: true });
  // Consistent snapshot of the canonical database, including the control journal.
  await backup(host.db, join(out, 'state', 'host.sqlite'));
  const copy = new Host(join(out, 'state'));
  try {
    const closure = exportClosure(copy, host);
    if (closure.missing.length) throw new Rejection(closure.missing, 'export_closure');
    for (const a of closure.artifacts) writeFileSync(join(out, 'state', 'artifacts', a), host.readArtifact(a).bytes);
    const recheck = closure.artifacts.filter(a => !copy.hasArtifact(a));
    if (recheck.length) throw new Rejection(recheck.map(a => `artifact ${a} did not copy intact`), 'export_closure');
    copy.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copy.close();
    rmSync(join(out, 'state', 'staging'), { recursive: true, force: true });
    for (const f of ['host.sqlite-wal', 'host.sqlite-shm']) rmSync(join(out, 'state', f), { force: true });
    writeFileSync(join(out, 'state', 'IMPORT_PENDING'), 'First launch assigns a fresh instance identity and pauses agent work.\n');

    // Application: host source, fixture packages, production dependencies only.
    mkdirSync(join(out, 'app', 'src', 'host'), { recursive: true });
    for (const f of readdirSync(join(APP_ROOT, 'src', 'host')).filter(f => f.endsWith('.ts') || f.endsWith('.css')))
      copyFileSync(join(APP_ROOT, 'src', 'host', f), join(out, 'app', 'src', 'host', f));
    // The shell imports the author adapter; ship it (it cannot run without Codex and a gate receipt).
    for (const f of ['authoring.ts', 'docker-author.ts', 'host-model-relay.ts', 'response-firewall.ts', 'codex-profile.json'])
      copyFileSync(join(APP_ROOT, 'src', f), join(out, 'app', 'src', f));
    mkdirSync(join(out, 'app', 'docker'), { recursive: true });
    for (const f of ['runtime-lock.json', 'relay.mjs']) copyFileSync(join(APP_ROOT, 'docker', f), join(out, 'app', 'docker', f));
    cpSync(join(APP_ROOT, 'packages'), join(out, 'app', 'packages'), { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(APP_ROOT, f), join(out, 'app', f));
    const licenses: ExportManifest['licenses'] = [];
    for (const mod of productionModules()) {
      cpSync(join(APP_ROOT, mod), join(out, 'app', mod), { recursive: true });
      const meta = JSON.parse(readFileSync(join(APP_ROOT, mod, 'package.json'), 'utf8'));
      const file = readdirSync(join(APP_ROOT, mod)).find(f => /^licen[cs]e/i.test(f)) ?? null;
      licenses.push({ name: meta.name, version: meta.version, license: String(meta.license ?? 'UNKNOWN'), file: file ? `app/${mod}/${file}` : null });
    }
    if (opts.runtime) {
      mkdirSync(join(out, 'runtime'), { recursive: true });
      copyFileSync(opts.runtime.node, join(out, 'runtime', 'node')); chmodSync(join(out, 'runtime', 'node'), 0o755);
      if (opts.runtime.license) copyFileSync(opts.runtime.license, join(out, 'runtime', 'LICENSE'));
      licenses.push({ name: 'node', version: '25.8.1', license: 'MIT (Node.js) with bundled third-party licenses', file: opts.runtime.license ? 'runtime/LICENSE' : null });
    }
    const node = opts.runtime ? './runtime/node' : 'node';
    const script = (body: string) => `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\n${body}\n`;
    writeFileSync(join(out, 'launch.sh'), script(`exec ${node} app/src/host/cli.ts serve ./state "\${PORT:-4391}"`));
    writeFileSync(join(out, 'recovery.sh'), script(`exec ${node} app/src/host/cli.ts recovery ./state`));
    writeFileSync(join(out, 'verify.sh'), script(`exec ${node} app/src/host/cli.ts verify-export .`));
    for (const f of ['launch.sh', 'recovery.sh', 'verify.sh']) chmodSync(join(out, f), 0o755);
    writeFileSync(join(out, 'README.txt'), [
      'Workshop export', '',
      'Declared platform: Linux x86-64, Debian 12 (bookworm) or compatible glibc >= 2.36.',
      opts.runtime ? `Runtime: bundled Node.js 25.8.1 (${opts.runtime.source}).` : 'Runtime: NOT bundled. Install Node.js 25.8.1 before launching.',
      '', './verify.sh    check every file against manifest.json (run before first launch)',
      './recovery.sh  list versions, unfinished work and broken references without running any package',
      './launch.sh    start the loopback shell (PORT=4391 by default) and print a login URL', '',
      'Nothing is downloaded at launch. Model generation needs a separately installed and authenticated Codex CLI;',
      'agent work is paused on first launch until you resume it. Secrets and CLI authentication are not included.',
      'Bundled third-party software keeps its own license (see manifest.json "licenses"); this bundle is not a redistribution grant.', ''
    ].join('\n'));
    const mutableState = ['state/host.sqlite', 'state/IMPORT_PENDING'];
    const files = Object.fromEntries(walk(out).filter(f => f !== 'manifest.json').map(f => [f, sha256(readFileSync(join(out, f)))]));
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), sourceInstance: host.instance, policyId: POLICY_ID,
      platform: { os: 'linux', arch: 'x64', baseline: 'Debian 12 (bookworm) or compatible, glibc >= 2.36', runtime: opts.runtime ? `node 25.8.1 from ${opts.runtime.source}` : null },
      closure: { packages: closure.packages, artifacts: closure.artifacts }, files, mutableState, licenses,
      omitted: ['Codex CLI and its authentication (~/.codex)', 'host credentials and session cookies', 'authoring journals under .workshop/author-* and .workshop/docker-*', 'the Docker isolation gate receipt (live authoring from an export needs a fresh gate run)',
        'archived practice worlds are included in the database but their packages are not required by the closure', 'development dependencies (typescript, @types/*)'],
      prerequisites: opts.runtime ? ['Linux x86-64 with glibc >= 2.36', 'a web browser on the same machine for the loopback shell']
        : ['Node.js 25.8.1', 'Linux x86-64 with glibc >= 2.36', 'a web browser on the same machine']
    };
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally { if (copy.db.isOpen) copy.close(); }
}

// Verifies an unlaunched bundle: every file hash, no extra files, the closure,
// and that the shipped checker source is the policy the manifest names.
export function verifyExport(bundle: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')) as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) problems.push(`unsupported export format ${manifest.format}`);
  const launched = !existsSync(join(bundle, 'state', 'IMPORT_PENDING'));
  const present = new Set(walk(bundle).filter(f => f !== 'manifest.json' && !/^state\/(host\.sqlite-(wal|shm)|staging\/)/.test(f)));
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (launched && manifest.mutableState.includes(path)) { present.delete(path); continue; }
    if (!present.has(path)) problems.push(`missing file ${path}`);
    else if (sha256(readFileSync(join(bundle, path))) !== hash) problems.push(`modified file ${path}`);
    present.delete(path);
  }
  for (const extra of present) if (!(launched && extra.startsWith('state/artifacts/'))) problems.push(`unexpected file ${extra}`);
  for (const a of manifest.closure.artifacts) if (!manifest.files[`state/artifacts/${a}`]) problems.push(`closure artifact ${a} not in bundle`);
  const policy = sha256(canonical(['canonical.ts', 'lang.ts', 'checker.ts', 'store.ts', 'rcheck.ts'].map(f => [f, sha256(readFileSync(join(bundle, 'app', 'src', 'host', f)))])));
  if (policy !== manifest.policyId) problems.push(`bundled checker source does not match policy ${manifest.policyId.slice(0, 12)}`);
  return { ok: problems.length === 0, problems };
}
