import type { Host } from './store.ts';

// Independent recovery surface. Deliberately separate from the React renderer
// and never evaluates any package's views, planner, or actions: it reads only
// host tables, so a broken or hostile application package cannot hide it.
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function recoveryReport(host: Host) {
  const worlds = host.worlds() as any[];
  const packages = new Map<string, boolean>();
  const available = (hash: string) => { if (!packages.has(hash)) packages.set(hash, !!host.pkg(hash)); return packages.get(hash)!; };
  const pending = host.pendingWork().map(o => ({ id: o.id, title: o.title, status: o.status, world: o.world, continuation: o.continuation, discharge: o.policy.discharge,
    continuationAvailable: available(o.continuation.packageHash), missingArtifacts: o.artifacts.filter(a => !host.hasArtifact(a)) }));
  const broken = [
    ...worlds.filter(w => w.status !== 'archived' && !available(String(w.package))).map(w => `World ${w.id} references unavailable package ${String(w.package).slice(0, 12)}`),
    ...pending.filter(p => !p.continuationAvailable).map(p => `Commitment ${p.id} has no available continuation package`),
    ...pending.flatMap(p => p.missingArtifacts.map(a => `Commitment ${p.id} references missing artifact ${a.slice(0, 12)}`))
  ];
  const activations = host.db.prepare('SELECT * FROM activations ORDER BY rowid').all() as any[];
  const tasks = host.tasks().filter(t => t.status === 'queued' || t.status === 'running');
  return { worlds, pending, broken, activations, tasks };
}

export function recoveryPage(host: Host, csrf: string, notice?: { kind: 'error' | 'ok'; lines: string[] }, authorAttempts: { id: string; state: string; root: string }[] = [],
  transferable: Map<string, string | null> = new Map()): string {
  const r = recoveryReport(host);
  const active = (r.worlds.find(w => w.kind === 'live' && w.status === 'active')?.id ?? null) as string | null;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
  const form = (action: string, fields: string, button: string, cls = '') => `<form method="post" action="${action}" class="inline">${hidden('__csrf', csrf)}${fields}<button type="submit"${cls ? ` class="${cls}"` : ''}>${button}</button></form>`;
  const rows = (items: string[], empty = 'None.') => items.length ? `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>` : `<p class="empty">${empty}</p>`;
  const pkgName = (hash: string) => { const p = host.pkg(hash); return p ? `${esc(p.manifest.name)} v${esc(p.manifest.version)}` : `unavailable package ${esc(hash.slice(0, 12))}`; };
  const live = r.worlds.filter(w => w.kind === 'live');
  const snapshots = r.worlds.filter(w => w.kind === 'recovery');
  const practice = r.worlds.filter(w => w.kind === 'proposal');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Versions &amp; recovery · Workshop</title><link rel="stylesheet" href="/shell.css"></head><body class="recovery">
<a class="skip" href="#main">Skip to content</a>
<nav class="handle" aria-label="Workshop controls"><a class="brand" href="/project">Workshop</a><ul><li><a href="/project">Project</a></li><li><a href="/change">Change this</a></li><li><a href="/recovery" aria-current="page">Versions &amp; recovery</a></li><li><a href="/recovery#export">Export</a></li><li><a href="/inspect">Activity</a></li></ul></nav>
<main id="main" tabindex="-1"><h1>Versions &amp; recovery</h1>
<p class="hint">Served by Workshop itself without running your app’s code, so it keeps working even if the app is broken.</p>
${notice ? `<div class="notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${notice.lines.map(n => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
${r.broken.length ? `<section aria-labelledby="broken"><h2 id="broken">Problems found</h2>${rows(r.broken.map(esc))}<p class="hint">If an app version is damaged and you have its original files, reinstall it from the terminal; its identity is checked.</p></section>` : ''}
<section aria-labelledby="pending"><h2 id="pending">Open reviews</h2>
${rows(r.pending.map(p => `<strong>${esc(p.title)}</strong> — ${esc(p.status)}${p.world !== active ? ` · on the kept branch “${esc(p.world)}”` : ''}${p.continuationAvailable ? '' : ' · <strong>its app version is unavailable</strong>'}
${p.continuationAvailable && p.discharge === 'owner' && p.world !== active ? `<form method="post" action="/recovery/continue" class="inline">${hidden('__csrf', csrf)}${hidden('obligation', p.id)}
<label for="rv-${esc(p.id)}">Verdict</label><select id="rv-${esc(p.id)}" name="verdict"><option value="approve">approved</option><option value="changes_requested">changes requested</option></select>
<label for="rn-${esc(p.id)}">Note</label><input id="rn-${esc(p.id)}" name="note" required maxlength="4000"><button type="submit">Record review on “${esc(p.world)}”</button></form>` : ''}
${active && p.world !== active ? (transferable.get(p.id) === null ? form('/recovery/transfer', hidden('obligation', p.id), `Move it to “${esc(active)}”`, 'secondary')
  : `<p class="meta">It cannot be moved to “${esc(active)}”: ${esc(transferable.get(p.id) ?? 'not checked')}</p>`) : ''}
${p.world !== active ? `<form method="post" action="/recovery/dispose" class="inline">${hidden('__csrf', csrf)}${hidden('obligation', p.id)}<label for="rd-${esc(p.id)}">Reason</label><input id="rd-${esc(p.id)}" name="reason" required minlength="3"><button type="submit" class="secondary">Cancel this review</button></form>` : ''}`),
  'No open reviews.')}
${r.pending.some(p => p.world === active) ? '<p class="hint">Reviews on your working branch are handled on the Project page.</p>' : ''}</section>
<section aria-labelledby="jobs"><h2 id="jobs">Review jobs waiting or running</h2>
${rows(r.tasks.map(t => `${esc(host.ledger().find(o => o.id === t.obligation)?.title ?? t.obligation)} — ${esc(t.status)} ${form('/recovery/cancel', hidden('task', t.id), 'Stop this job', 'secondary')}`))}</section>
${authorAttempts.some(a => a.state === 'running' || a.state === 'uncertain') ? `<section aria-labelledby="authoring"><h2 id="authoring">Codex calls needing attention</h2>
${rows(authorAttempts.filter(a => a.state === 'running' || a.state === 'uncertain').map(a => `${esc(a.id)} — ${a.state === 'uncertain' ? 'interrupted: the call may have run and been charged' : 'running'}; allowance ${esc(a.root)}; never retried automatically`))}</section>` : ''}
<section aria-labelledby="versions"><h2 id="versions">Branches</h2>
${rows(live.map(w => `<strong>${esc(w.id)}</strong> — ${w.status === 'active' ? 'your working branch' : 'kept'} · ${pkgName(String(w.package))} · revision ${esc(w.revision)}${w.status !== 'active' ? ' ' + form('/recovery/switch', hidden('target', w.id), `Switch to “${esc(w.id)}”`, 'secondary') : ''}`))}
<h3>Snapshots</h3>
<p class="hint">Taken automatically before each app change. Restoring one creates a new branch; the branch you leave is kept and you can switch back.</p>
${rows(snapshots.slice().reverse().map(w => `Before a change on “${esc(w.parent)}” (revision ${esc(w.revision)}, ${pkgName(String(w.package))})
${r.worlds.some(x => x.id === w.parent && x.status === 'active') ? `<a class="button secondary" href="/recovery/restore/${encodeURIComponent(w.id)}">Restore…</a>` : '<span class="meta">(switch to its branch to restore it)</span>'}`), 'No snapshots yet.')}
<h3>App changes applied</h3>${rows(r.activations.map(a => `${pkgName(String(a.from_package))} → ${pkgName(String(a.to_package))} on “${esc(a.world)}” (revision ${esc(a.from_revision)} → ${esc(a.to_revision)})`), 'None yet.')}
${practice.length ? `<details><summary>Technical: ${practice.length} practice world(s)</summary>${rows(practice.map(w => `${esc(w.id)} — ${esc(w.status)}, revision ${esc(w.revision)}`))}</details>` : ''}</section>
<section aria-labelledby="export"><h2 id="export">Export</h2>
<p>Write a self-contained copy of this project (data, files, the app versions it needs and Workshop itself) to a new folder. It opens offline with <code>./launch.sh</code>. Secrets and your Codex sign-in are never included.</p>
<form method="post" action="/protected/export">${hidden('__csrf', csrf)}<div class="field"><label for="dest">New folder (full path)</label><input id="dest" name="dest" required placeholder="/Users/you/Desktop/workshop-export" size="60"></div><button type="submit">Export</button></form>
<p class="hint">To bundle a Linux runtime as well, use the terminal: <code>node src/host/cli.ts export &lt;state-dir&gt; &lt;out-dir&gt; &lt;node-binary&gt; &lt;license&gt; &lt;source&gt;</code>.</p></section>
</main></body></html>`;
}
