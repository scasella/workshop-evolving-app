import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Host } from './store.ts';
import { readPackageDir } from './package-dir.ts';
import { recoveryReport } from './recovery.ts';
import { buildShell } from './server.ts';
import { runQueued, simulatedReviewer } from './runner.ts';
import { createExport, verifyExport } from './export.ts';

// Host CLI. Recovery commands read host tables only and never run a package.
const [command = 'help', dirArg = '.workshop/host', ...rest] = process.argv.slice(2);
const dir = resolve(dirArg);
const packagesDir = resolve(new URL('../../packages', import.meta.url).pathname);
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
// The Host adopts a fresh identity when it opens an exported state directory; say so.
function openHost(): Host {
  const host = new Host(dir);
  if (host.imported) console.error(`Imported copy: new instance ${host.imported.instance.slice(0, 8)}; ${host.imported.paused.length} agent job(s) paused, ${host.imported.staleApprovals.length} approval(s) require a fresh preview.`);
  return host;
}

if (command === 'init') {
  const host = openHost();
  if (!(host.worlds() as any[]).some(w => w.kind === 'live')) out({ created: host.createProject(rest[0] ?? 'project', readPackageDir(resolve(packagesDir, 'p0-notebook'))) });
  else out({ exists: true });
  host.close();
} else if (command === 'serve') {
  const port = Number(rest[0] ?? 4317);
  const host = openHost();
  if (!(host.worlds() as any[]).some(w => w.kind === 'live')) host.createProject('project', readPackageDir(resolve(packagesDir, 'p0-notebook')));
  const uncertain = host.reconcileAttempts();
  if (uncertain.length) console.log(`Reconciliation: ${uncertain.length} interrupted review attempt(s) marked uncertain; see Recovery.`);
  const { app, loginToken } = buildShell(host, { port, packagesDir });
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Workshop is running on this computer only (loopback).\nSign in by opening: http://127.0.0.1:${port}/login?token=${loginToken}\n(The link works until this process stops; keep it private.)`);
} else if (command === 'recovery' && !existsSync(join(dir, 'host.sqlite'))) {
  console.error(`No Workshop project in ${dir}. Start one with: node src/host/cli.ts serve ${dirArg}`); process.exitCode = 1;
} else if (command === 'recovery') {
  const host = openHost(); out(recoveryReport(host)); host.close();
} else if (command === 'pending') {
  const host = openHost(); out(host.pendingWork().map(o => ({ id: o.id, title: o.title, status: o.status, world: o.world, continuation: o.continuation }))); host.close();
} else if (command === 'allow') {
  const host = openHost(); host.grantAllowance(rest[0], Number(rest[1] ?? 1)); out(host.allowance(rest[0])); host.close();
} else if (command === 'review-simulated') {
  // Deterministic fixture reviewer for demos and tests. Results are stored labelled SIMULATED; this is not a model review.
  const host = openHost(); host.reconcileAttempts();
  out(await runQueued(host, simulatedReviewer, { root: rest[0] ?? 'root', concurrency: 2 })); host.close();
} else if (command === 'retry') {
  const host = openHost(); host.retryTask(rest[0]); out({ retry: rest[0] }); host.close();
} else if (command === 'export') {
  const host = openHost();
  const runtime = rest[1] ? { node: resolve(rest[1]), license: rest[2] ? resolve(rest[2]) : undefined, source: rest[3] ?? 'owner-supplied runtime' } : undefined;
  try { const m = await createExport(host, resolve(rest[0]), { runtime }); out({ exported: resolve(rest[0]), packages: m.closure.packages.length, artifacts: m.closure.artifacts.length, runtime: m.platform.runtime }); }
  catch (e: any) { out({ exportFailed: e.reasons ?? [e.message] }); process.exitCode = 1; }
  host.close();
} else if (command === 'verify-export') {
  const r = verifyExport(dir); out(r); if (!r.ok) process.exitCode = 1;
} else if (command === 'stop') {
  const host = openHost(); host.cancelTask(rest[0]); out({ cancelled: rest[0], cleanup: 'tracked separately' }); host.close();
} else {
  if (command !== 'help') { console.error(`Unknown command: ${command}`); process.exitCode = 1; }
  console.log('usage: node src/host/cli.ts <command> [state-dir=.workshop/host] [args]');
  console.log('  init | serve [port=4317] | recovery | pending | stop <task> | allow <root> <n> | review-simulated <root> | retry <task>');
  console.log('  export <out-dir> [node-binary license source] | verify-export (state-dir = bundle dir)');
}
