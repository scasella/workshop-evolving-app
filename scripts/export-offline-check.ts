import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from '../src/host/canonical.ts';
import { createExport } from '../src/host/export.ts';
import { readPackageDir, withManifest } from '../src/host/package-dir.ts';
import { Host } from '../src/host/store.ts';

// P25: export a real project, then open it in a fresh Linux x86-64 container
// with networking disabled, the image's own Node deleted, at a different path.
// P01 as well: the disconnected copy also re-exports itself (no network, no Codex).
const IMAGE = 'node:25.8.1-bookworm-slim@sha256:44bcbf493408a824104e74976ae5539f596c46cbe75ed0423a137552a555e2de';
const root = resolve(new URL('..', import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'workshop-offline-'));
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

// 1. Runtime: copied out of the digest-pinned image (no download), license text alongside.
mkdirSync(join(root, '.workshop', 'runtime'), { recursive: true });
const nodeBin = join(root, '.workshop', 'runtime', 'node-linux-x64');
if (!existsSync(nodeBin)) {
  const id = docker('create', '--platform', 'linux/amd64', IMAGE);
  try { docker('cp', `${id}:/usr/local/bin/node`, nodeBin); } finally { docker('rm', id); }
}
const license = join(root, '.workshop', 'runtime', 'NODE-LICENSE');
assert.ok(existsSync(license), 'fetch the Node v25.8.1 LICENSE first: see "Runtime license" in docs/EXPORT.md');

// 2. A project with history: P0 → P1, a fulfilled agent review with an artifact, an open owner review.
const host = new Host(join(work, 'source'));
const p0 = host.createProject('project', readPackageDir(join(root, 'packages', 'p0-notebook')));
let n = 0;
const act = (actionId: string, input: Record<string, any>, packageHash?: string) => {
  const w = host.world('project');
  const o = host.run({ operationId: `seed-${++n}`, worldId: 'project', expectedRevision: w.revision, packageHash: packageHash ?? w.packageHash, capabilityRef: 'cap-owner-project', actionId, input });
  assert.equal(o.status, 'committed', JSON.stringify(o));
};
act('add_alternative', { id: 'sqlite', title: 'SQLite' }); act('add_alternative', { id: 'postgres', title: 'Postgres' });
act('start_decision', { id: 'd1', question: 'Which storage engine?' });
act('request_review', { key: 'r17', decision: 'd1' }); act('request_ai_review', { key: 'ai1', decision: 'd1' });
host.grantAllowance('root', 2);
assert.equal(host.completeReview(host.startAttempt(host.tasks()[0].id, 'root'), { verdict: 'approve', note: 'SIMULATED fixture review', report: '# Simulated review\n' }).status, 'committed');
const prop = host.propose('prop-p1', 'project', 'Turn this project into a comparison workspace', withManifest(readPackageDir(join(root, 'packages', 'p1-comparison')), { parent: p0 }));
assert.equal(prop.status, 'previewable');
host.approve('prop-p1', { previewHash: prop.preview.previewHash, candidateHash: prop.preview.candidateHash });
assert.equal(host.activate('prop-p1').status, 'committed');
const bundle = join(work, 'bundle');
const manifest = await createExport(host, bundle, { runtime: { node: nodeBin, license, source: IMAGE } });
host.close();

// 3. Fresh container: no network, Node removed from the image, bundle moved to a new path.
const probe = join(work, 'probe.mjs');
writeFileSync(probe, `
import { readFileSync } from 'node:fs';
const wait = ms => new Promise(r => setTimeout(r, ms));
let url; for (let i = 0; i < 240 && !url; i++) { try { url = /http:\\/\\/127\\.0\\.0\\.1:4391\\/login\\?token=[0-9a-f]+/.exec(readFileSync('/tmp/launch.log', 'utf8'))?.[0]; } catch {} if (!url) await wait(500); }
if (!url) { console.log(JSON.stringify({ error: 'shell did not start', log: (() => { try { return readFileSync('/tmp/launch.log', 'utf8'); } catch { return ''; } })() })); process.exit(1); }
const base = 'http://127.0.0.1:4391';
const login = await fetch(url, { redirect: 'manual' });
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = p => fetch(base + p, { headers: { cookie } }).then(r => r.text());
const project = await get('/project'); const recovery = await get('/recovery'); const change = await get('/change');
const field = n => new RegExp('name="' + n + '" value="([^"]+)"').exec(project)[1];
const body = new URLSearchParams({ __csrf: field('__csrf'), __world: 'project', __revision: field('__revision'), __package: field('__package'), __action: 'add_note',
  'in.id': 'offline-note', 'in.title': 'Written offline in the exported copy' });
const post = await fetch(base + '/project/action', { method: 'POST', redirect: 'manual', body,
  headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' } });
const after = await get('/project');
let external = 'reachable';
try { await fetch('https://example.com', { signal: AbortSignal.timeout(3000) }); } catch { external = 'denied'; }
console.log(JSON.stringify({ loginStatus: login.status, project: project.includes('Comparison (app version 2)'), openReview: project.includes('Review: Which storage engine?'),
  comparisonView: project.includes('Comparison'), recovery: recovery.includes('Open reviews') && recovery.includes('Review: Which storage engine?'), postStatus: post.status,
  offlineEdit: after.includes('Written offline in the exported copy'), externalNetwork: external,
  changePageWithoutCodex: change.includes('Codex CLI not found at /opt/homebrew/bin/codex') }));
process.exit(0);
`);
const inner = [
  'set -e',
  'rm -f /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx',
  'if command -v node >/dev/null 2>&1; then echo "HOST_NODE_PRESENT"; exit 99; fi',
  'cp -a /mnt/bundle /opt/moved-export && cd /opt/moved-export',
  './verify.sh > /tmp/verify.json && echo VERIFY_OK',
  './recovery.sh > /tmp/recovery.json && echo RECOVERY_OK && grep -c ob-r17 /tmp/recovery.json',
  './runtime/node app/src/host/cli.ts export ./state /tmp/re-export > /tmp/re-export.json && ./runtime/node app/src/host/cli.ts verify-export /tmp/re-export > /tmp/re-verify.json && echo REEXPORT_OK',
  '(PORT=4391 ./launch.sh > /tmp/launch.log 2>&1 &)',
  './runtime/node /mnt/probe.mjs',
  'grep -o "Imported copy[^;]*" /tmp/launch.log /dev/null || true'
].join('\n');
const started = Date.now();
const run = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', 'sh',
  '-v', `${bundle}:/mnt/bundle:ro`, '-v', `${probe}:/mnt/probe.mjs:ro`, IMAGE, '-c', inner], { encoding: 'utf8', timeout: 600_000 });
const lines = run.stdout.trim().split('\n');
const result = JSON.parse(lines.find(l => l.startsWith('{')) ?? '{}');
const evidence = {
  observedAt: new Date().toISOString(), scenario: 'P25 export, move, disconnect, start fresh', image: IMAGE, platform: 'linux/amd64 (QEMU emulation on an arm64 Docker VM)',
  network: 'none', hostNodeRemoved: !run.stdout.includes('HOST_NODE_PRESENT'), bundlePathInContainer: '/opt/moved-export (source was a host temp directory)',
  runtime: { sha256: sha256(readFileSync(nodeBin)), licenseSha256: sha256(readFileSync(license)) },
  manifest: { packages: manifest.closure.packages.length, artifacts: manifest.closure.artifacts.length, files: Object.keys(manifest.files).length, policyId: manifest.policyId },
  verify: run.stdout.includes('VERIFY_OK'), recoveryCli: run.stdout.includes('RECOVERY_OK'), reExportOffline: run.stdout.includes('REEXPORT_OK'), shell: result, exitCode: run.status, seconds: Math.round((Date.now() - started) / 1000),
  stderr: run.stderr.slice(-2000)
};
writeFileSync(join(root, 'evidence', 'export-offline.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
assert.equal(run.status, 0);
assert.ok(evidence.hostNodeRemoved && evidence.verify && evidence.recoveryCli && evidence.reExportOffline);
assert.deepEqual(result, { loginStatus: 303, project: true, openReview: true, comparisonView: true, recovery: true, postStatus: 303, offlineEdit: true, externalNetwork: 'denied', changePageWithoutCodex: true });
console.log('P25 offline export check passed.');
