import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host/store.ts';
import { authorAttempts, authorJournal, authorPrompt, parseTarget } from '../src/host/evolve.ts';
import { buildShell, type AuthorService } from '../src/host/server.ts';
import { readPackageDir, withManifest } from '../src/host/package-dir.ts';
import { addFile, editJson, Fixture, tempDir } from './helpers.ts';

const PORT = 4317;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const packagesDir = new URL('../packages', import.meta.url).pathname;

const offlineAuthor: AuthorService = { problems: () => ['Codex is not signed in (run codex login)'], attempts: () => [], start: async () => { throw new Error('must not be called'); } };
async function shell(host: Host, author: AuthorService = offlineAuthor) {
  const { app, loginToken } = buildShell(host, { port: PORT, packagesDir, loginToken: 'test-login-token', author });
  const login = await app.inject({ method: 'GET', url: `/login?token=${loginToken}`, headers: { host: HOST } });
  assert.equal(login.statusCode, 303);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST, cookie } });
  const csrf = async () => /name="__csrf" value="([0-9a-f]+)"/.exec((await get('/change')).body)![1];
  const post = async (url: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: new URLSearchParams(form).toString(),
      headers: { host: HOST, cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  const follow = async (res: { statusCode: number; headers: any }) => { assert.equal(res.statusCode, 303); return get(String(res.headers.location)); };
  return { app, get, post, csrf, follow, cookie };
}
const actionForm = (world: string, revision: number, pkg: string, action: string, inputs: Record<string, string>, csrf: string) =>
  ({ __csrf: csrf, __world: world, __revision: String(revision), __package: pkg, __action: action, ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`in.${k}`, v])) });

test('P31: sessions, Host, Origin and CSRF guard every state change; hostile text renders inert', async () => {
  const f = new Fixture().baseline();
  const s = await shell(f.host);
  assert.equal((await s.app.inject({ method: 'GET', url: '/project', headers: { host: HOST } })).statusCode, 401);
  assert.equal((await s.app.inject({ method: 'GET', url: '/project', headers: { host: 'evil.example', cookie: s.cookie } })).statusCode, 403, 'DNS-rebinding Host refused');
  assert.equal((await s.app.inject({ method: 'GET', url: '/login?token=wrong', headers: { host: HOST } })).statusCode, 401);
  const csrf = await s.csrf();
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const before = f.revision;
  const cross = await s.post('/project/action', actionForm('project', before, f.p0, 'add_note', { id: 'x1', title: hostile }, csrf), { origin: 'http://evil.example' });
  assert.equal(cross.statusCode, 403);
  const noToken = await s.post('/project/action', actionForm('project', before, f.p0, 'add_note', { id: 'x1', title: hostile }, 'f'.repeat(64)));
  assert.equal(noToken.statusCode, 403);
  const noOrigin = await s.post('/project/action', actionForm('project', before, f.p0, 'add_note', { id: 'x1', title: hostile }, csrf), { origin: '' });
  assert.equal(noOrigin.statusCode, 403);
  const nullOrigin = await s.post('/project/action', actionForm('project', before, f.p0, 'add_note', { id: 'x1', title: hostile }, csrf), { origin: 'null' });
  assert.equal(nullOrigin.statusCode, 403);
  assert.equal(f.revision, before, 'no refused request mutated state');
  const ok = await s.follow(await s.post('/project/action', actionForm('project', before, f.p0, 'add_note', { id: 'x1', title: hostile }, csrf)));
  assert.equal(f.revision, before + 1);
  assert.ok(ok.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;'));
  assert.ok(!/<script|<img|onerror=/i.test(ok.body.replace(/&lt;[^]*?&gt;/g, '')), 'no executable markup in the page');
  assert.equal(ok.headers['referrer-policy'], 'same-origin', 'browsers must send a real Origin on same-origin posts');
  const csp = String(ok.headers['content-security-policy']);
  assert.match(csp, /default-src 'none'/); assert.doesNotMatch(csp, /script-src/);
  // Artifact bytes are served as sandboxed plain text.
  const hash = f.host.putArtifact(Buffer.from('<html><script>alert(3)</script></html>'), 'text/plain');
  const art = await s.get(`/artifact/${hash}`);
  assert.match(String(art.headers['content-type']), /^text\/plain/); assert.match(String(art.headers['content-security-policy']), /sandbox/);
  // Approval and finalization are host routes; no package can render them.
  assert.equal((await s.post('/protected/finalize', { __csrf: csrf, __world: 'project', __revision: String(f.revision), decision: 'd1', choice: 'sqlite' }, { origin: 'http://evil.example' })).statusCode, 403);
});

test('P02: a broken view or corrupted active package leaves the shell, commitments and Recovery working', async () => {
  const dir = tempDir();
  const f = new Fixture(dir).baseline();
  const files = f.p1Files(fs => addFile(fs, 'views/broken.json', JSON.stringify({ id: 'broken', title: 'Broken view', kind: 'status', items: [{ label: 'Crash', value: { div: [{ lit: 1 }, { lit: 0 }] } }] })),
    { views: ['broken', 'comparison', 'alternatives'] });
  f.evolve(files);
  let s = await shell(f.host);
  const page = await s.get('/project');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Broken view.*could not be shown: arith_div_zero/s);
  assert.match(page.body, /Comparison/); assert.match(page.body, /Outstanding commitments/);
  // Corrupt the active package bytes, then restart: startup must not silently fall back.
  const active = f.host.world('project').packageHash;
  f.host.db.prepare("UPDATE packages SET files=replace(files, 'Weighted totals', 'Tampered totals') WHERE hash=?").run(active);
  f.host.close();
  const host = new Host(dir);
  s = await shell(host);
  const broken = await s.get('/project');
  assert.equal(broken.statusCode, 200);
  assert.match(broken.body, /active application package is unavailable or failed verification/);
  assert.match(broken.body, /Review: Which storage engine\?/, 'commitments still listed from the host ledger');
  const recovery = await s.get('/recovery');
  assert.equal(recovery.statusCode, 200);
  assert.match(recovery.body, new RegExp(`World project references unavailable package ${active.slice(0, 12)}`));
  assert.match(recovery.body, /Review: Which storage engine\?/); assert.match(recovery.body, /action="\/protected\/export"/);
  // The pinned continuation (P0) is intact, so the owner can still complete the review.
  const csrf = await s.csrf();
  const done = await s.follow(await s.post('/project/continue', { __csrf: csrf, __world: 'project', __revision: String(host.world('project').revision), obligation: 'ob-r17', verdict: 'approve', note: 'Done during recovery' }));
  assert.match(done.body, /Review recorded/);
  assert.equal(host.ledger().find(o => o.id === 'ob-r17')!.status, 'fulfilled');
});

test('UI path: change request → practice → protected approval → apply → continue review → finalize', async () => {
  const f = new Fixture().baseline();
  const s = await shell(f.host);
  const csrf = await s.csrf();
  const project0 = await s.get('/project');
  assert.match(project0.body, /live Codex authoring not set up/);
  const proposed = await s.post('/change', { __csrf: csrf, request: 'Turn this project into a comparison workspace', source: 'p1-comparison' });
  assert.equal(proposed.statusCode, 303);
  const id = /\/proposal\/(prop-[0-9a-f]+)/.exec(String(proposed.headers.location))![1];
  const preview = await s.get(`/proposal/${id}`);
  assert.match(preview.body, /Practice only: nothing you do here is applied/);
  assert.match(preview.body, /Review: Which storage engine\?: keeps working \(it stays on the version of the app it was created in\)/);
  const p = f.host.proposal(id);
  // Practice action in the proposal world does not reach the live project.
  await s.post('/project/action', actionForm(p.practiceWorld!, f.host.world(p.practiceWorld!).revision, p.packageHash!, 'add_criterion', { id: 'practice', title: 'Practice', weight: '2' }, csrf));
  assert.ok(f.host.state(p.practiceWorld!).records.has('practice')); assert.ok(!f.host.state('project').records.has('practice'));
  const approval = await s.get(`/protected/approve/${id}`);
  assert.match(approval.body, /Apply this change\?/); assert.match(approval.body, /Exact identity/);
  // A forged hash in the approval form is refused.
  const forged = await s.post(`/protected/approve/${id}`, { __csrf: csrf, previewHash: 'a'.repeat(64), candidateHash: p.candidateHash!, decision: 'apply' });
  assert.match((await s.follow(forged)).body, /exact reviewed preview/);
  const applied = await s.follow(await s.post(`/protected/approve/${id}`, { __csrf: csrf, previewHash: p.preview!.previewHash, candidateHash: p.candidateHash!, decision: 'apply' }));
  assert.match(applied.body, /Change applied/); assert.match(applied.body, /Comparison \(app version 2\)/);
  assert.match(applied.body, /Not ready to finalize:.*Review: Which storage engine\?/s);
  assert.match(applied.body, /Finalize \(blocked\)/);
  const unconfirmed = await s.follow(await s.post('/protected/finalize', { __csrf: csrf, __world: 'project', __revision: String(f.revision), decision: 'd1', choice: 'sqlite' }));
  assert.match(unconfirmed.body, /I understand a final decision cannot be changed/);
  const blocked = await s.follow(await s.post('/protected/finalize', { __csrf: csrf, __world: 'project', __revision: String(f.revision), decision: 'd1', choice: 'sqlite', confirm: 'on' }));
  assert.match(blocked.body, /Cannot finalize: ob-r17/);
  await s.follow(await s.post('/project/continue', { __csrf: csrf, __world: 'project', __revision: String(f.revision), obligation: 'ob-r17', verdict: 'approve', note: 'Looks right' }));
  const final = await s.follow(await s.post('/protected/finalize', { __csrf: csrf, __world: 'project', __revision: String(f.revision), decision: 'd1', choice: 'sqlite', confirm: 'on' }));
  assert.match(final.body, /Decision finalized/); assert.match(final.body, /Final: SQLite/);
});

test('Recovery UI: restore a snapshot; retained commitments stay visible, completable and transferable', async () => {
  const f = new Fixture().baseline();
  f.evolve(f.p1Files());
  const s = await shell(f.host);
  const csrf = await s.csrf();
  const rec = await s.get('/recovery');
  const snap = decodeURIComponent(/href="\/recovery\/restore\/([^"]+)"/.exec(rec.body)![1]);
  assert.match(rec.body, /the branch you leave is kept and you can switch back/);
  const confirm = await s.get(`/recovery/restore/${encodeURIComponent(snap)}`);
  assert.match(confirm.body, /Restore this snapshot\?/); assert.match(confirm.body, /the newer app version \(comparison → back to notebook\)/);
  assert.match(confirm.body, /Open reviews that stay with “project”/);
  const restored = await s.follow(await s.post('/recovery/restore', { __csrf: csrf, snapshot: snap }));
  assert.match(restored.body, /Snapshot restored as branch “project-b2”/);
  assert.match(restored.body, /Switch to “project”/, 'a way back is offered');
  const project = await s.get('/project');
  assert.match(project.body, /Review: Which storage engine\?/);
  assert.match(project.body, /Belongs to the branch “project”, which you left/, 'a restore never hides a newer responsibility');
  const after = await s.get('/recovery');
  assert.match(after.body, /Move it to “project-b2”/);
  const moved = await s.follow(await s.post('/recovery/transfer', { __csrf: csrf, obligation: 'ob-r17' }));
  assert.match(moved.body, /Review moved to your working branch/);
  assert.match((await s.get('/project')).body, /name="obligation" value="ob-r17"/, 'now completable from the project page');
});

test('Repair: reinstalling package bytes succeeds only for the exact recorded identity', async () => {
  const dir = tempDir();
  const f = new Fixture(dir).baseline();
  const original = { ...f.host.pkg(f.p0)!.files };
  f.host.db.prepare("UPDATE packages SET files=replace(files, 'Record a review', 'Record a rewiew') WHERE hash=?").run(f.p0);
  f.host.close();
  const host = new Host(dir);
  assert.equal(host.pkg(f.p0), undefined);
  assert.throws(() => host.repairPackage({ ...original, 'prompts/review.md': 'different bytes' }), /not referenced by this host/);
  assert.equal(host.repairPackage(original), f.p0);
  assert.ok(host.pkg(f.p0)); assert.equal(host.project('project').views.length, 3);
});

test('Ask Codex is an owner action: disabled with the specific missing conditions, charged to one allowance when run', async () => {
  const f = new Fixture().baseline();
  const calls: any[] = [];
  const stub: AuthorService = {
    attempts: () => [],
    problems: root => [...(f.host.authorModel() ? [] : ['no model chosen for live authoring (Authoring settings)']),
      ...(!root ? ['no call allowance granted for this change request (Authoring settings)'] : [])],
    start: async args => {
      calls.push(args);
      f.host.reserveUnit(args.root, `author ${args.proposalId}`);
      const r = f.host.propose(args.proposalId, args.world, args.request, withManifest(readPackageDir(`${packagesDir}/p1-comparison`), { parent: f.host.world('project').packageHash }));
      return { status: r.status, reasons: r.status === 'rejected' ? r.reasons : [] };
    }
  };
  const s = await shell(f.host, stub);
  const csrf = await s.csrf();
  const before = await s.get('/change');
  assert.match(before.body, /Not available yet\. To use it:/);
  assert.match(before.body, /no model chosen/); assert.match(before.body, /no call allowance granted/);
  assert.match(before.body, /<button type="submit" disabled="">Ask Codex \(live, paid calls: up to 3\)/);
  assert.ok(before.body.indexOf('Propose a new version of the app') < before.body.indexOf('Ask Codex to write the change'), 'the path that works comes first');
  const refused = await s.follow(await s.post('/change/author', { __csrf: csrf, request: 'x', root: '' }));
  assert.match(refused.body, /no model chosen/); assert.equal(calls.length, 0);
  await s.follow(await s.post('/protected/authoring', { __csrf: csrf, model: 'owner-chosen-model', root: 'change-1', units: '1' }, {}));
  assert.equal(f.host.authorModel(), 'owner-chosen-model'); assert.deepEqual(f.host.allowance('change-1'), { total: 1, used: 0 });
  const started = await s.follow(await s.post('/change/author', { __csrf: csrf, request: 'Turn this into a comparison workspace', root: 'change-1', target: 'view:alternatives' }));
  assert.match(started.body, /Codex request prop-[0-9a-f]+ started\. It may use up to 3 units/);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].target, { kind: 'view', id: 'alternatives' });
  assert.deepEqual(f.host.allowance('change-1'), { total: 1, used: 1 });
  assert.match((await s.get('/change')).body, /prop-[0-9a-f]+<\/a> — ready to try/);
});

test('contextual change request: target-specific protected conditions and author context', async () => {
  const f = new Fixture().baseline();
  const s = await shell(f.host);
  const record = await s.get('/change?target=record:sqlite');
  assert.match(record.body, /Change the record “SQLite”/);
  assert.match(record.body, /“Review: Which storage engine\?” covers this item; changing what was reviewed opens a new review/);
  const action = await s.get('/change?target=action:record_review');
  assert.match(action.body, /is completed through this action; it must keep working/);
  assert.match((await s.get('/change?target=view:notes')).body, /Views cannot change commitments; 1 open commitment/);
  assert.match((await s.get('/change?target=bogus')).body, /Change this app/, 'malformed targets are ignored');
  assert.match((await s.get('/project')).body, /href="\/change\?target=view:notes"/);
  const { prompt } = authorPrompt(f.host, 'project', 'Show summaries', parseTarget('record:sqlite'));
  assert.match(prompt, /pointing at record sqlite of type alternative/);
});

test('an author call interrupted by a restart is shown as uncertain, keeps its unit, and is not retried', async () => {
  const dir = tempDir();
  const f = new Fixture(dir).baseline();
  f.host.setAuthorModel('owner-chosen-model'); f.host.grantAllowance('change-1', 2);
  const hanging: AuthorService = {
    problems: () => [], attempts: () => authorAttempts(f.host),
    start: args => {
      // The real author reserves in the journal (charging the host ledger) before launching, then waits on the model.
      authorJournal(f.host).reserve({ operationId: args.proposalId, rootId: args.root, prompt: 'p', model: 'owner-chosen-model' }, () => f.host.reserveUnit(args.root, `author ${args.proposalId}`));
      return new Promise(() => {});
    }
  };
  const s = await shell(f.host, hanging);
  const csrf = await s.csrf();
  await s.follow(await s.post('/change/author', { __csrf: csrf, request: 'Add a third option', root: 'change-1' }));
  assert.match((await s.get('/change')).body, /prop-[0-9a-f]+: running/);
  // The process "dies": a new host and shell take over the same directory.
  f.host.close();
  const host = new Host(dir);
  const after = await shell(host, { problems: () => [], attempts: () => authorAttempts(host), start: async () => { throw new Error('must not be called'); } });
  const change = (await after.get('/change')).body;
  assert.match(change, /interrupted — the call may have run and been charged \(change-1\); it is not retried/);
  assert.match((await after.get('/recovery')).body, /interrupted: the call may have run and been charged; allowance change-1/);
  assert.equal(authorAttempts(host)[0].state, 'uncertain');
  assert.deepEqual(host.allowance('change-1'), { total: 2, used: 1 }, 'the unit stays charged');
  assert.ok(host.db.prepare("SELECT 1 FROM events WHERE kind='author_attempts_uncertain'").get());
});

test('review routes: request another review queues one job; running them needs a model and allowance', async () => {
  const f = new Fixture().baseline();
  f.ok('request_ai_review', { key: 'ai1', decision: 'd1' });
  f.host.grantAllowance('r', 2);
  assert.equal(f.host.completeReview(f.host.startAttempt(f.host.tasks()[0].id, 'r'), { verdict: 'changes_requested', note: 'more', report: 'r' }).status, 'committed');
  const s = await shell(f.host);
  const csrf = await s.csrf();
  assert.match((await s.get('/project')).body, /Request another review/);
  const queued = await s.follow(await s.post('/protected/review-again', { __csrf: csrf, obligation: 'ob-ai1' }));
  assert.match(queued.body, /Another review is queued/);
  assert.match(queued.body, /1 review job\(s\) waiting\. To run them, set up Codex/);
  const refused = await s.follow(await s.post('/protected/run-reviews', { __csrf: csrf, root: 'r' }));
  assert.match(refused.body, /no model chosen for live authoring/);
  assert.equal(f.host.tasks().find(t => t.id === 'task-ob-ai1-again-2')!.status, 'queued', 'nothing dispatched');
  assert.equal((await s.follow(await s.post('/protected/review-again', { __csrf: csrf, obligation: 'ob-ai1' }))).body.includes('already has a review job waiting'), true);
});

test('usability: generated IDs, pick-lists, kept input on errors, safe double submit, friendly error pages', async () => {
  const f = new Fixture().baseline();
  const s = await shell(f.host);
  const csrf = await s.csrf();
  const home = await s.get('/project');
  assert.match(home.body, /placeholder="leave blank to generate"/);
  assert.match(home.body, /<option value="ob-r17">Review: Which storage engine\? \(ob-r17\)<\/option>/, 'references are chosen from a list');
  assert.match(home.body, /<option value="sqlite">SQLite \(sqlite\)<\/option>/, 'editing picks an existing item');
  // No ID typed: one is generated from the title.
  const made = await s.follow(await s.post('/project/action', { ...actionForm('project', f.revision, f.p0, 'add_alternative', { id: '', title: 'Duck DB!' }, csrf), __op: 'ui-abcdef123' }));
  assert.match(made.body, /Add alternative — done/);
  assert.ok(f.host.state('project').records.has('duck-db'));
  // The same form submitted twice is recognised; nothing is added twice.
  const again = await s.follow(await s.post('/project/action', { ...actionForm('project', f.revision - 1, f.p0, 'add_alternative', { id: '', title: 'Duck DB!' }, csrf), __op: 'ui-abcdef123' }));
  assert.match(again.body, /Add alternative — done/);
  assert.equal([...f.host.state('project').records.keys()].filter(k => k.startsWith('duck-db')).length, 1);
  // A stale page keeps what was typed and says so plainly.
  const stale = await s.follow(await s.post('/project/action', actionForm('project', 0, f.p0, 'add_note', { id: '', title: 'Typed on an old page' }, csrf)));
  assert.match(stale.body, /The project changed since you opened this page, so nothing was saved/);
  assert.match(stale.body, /value="Typed on an old page"/, 'input kept');
  // Missing things and bad forms get real pages.
  const missing = await s.get('/proposal/nosuch');
  assert.equal(missing.statusCode, 404); assert.match(missing.body, /Not found/); assert.match(missing.body, /Back to the project/);
  assert.equal((await s.get('/nothing-here')).statusCode, 404);
  const badRev = await s.post('/project/action', actionForm('project', 0, f.p0, 'add_note', { title: 'x' }, csrf) as any, {});
  assert.equal((await s.post('/project/action', { ...actionForm('project', 0, f.p0, 'add_note', { title: 'x' }, csrf), __revision: 'abc' })).statusCode, 400);
  void badRev;
  const noSession = await s.app.inject({ method: 'GET', url: '/project', headers: { host: HOST } });
  assert.equal(noSession.statusCode, 401); assert.match(noSession.body, /Open the sign-in link that the Workshop host printed/);
});

test('usability: switch back after a restore, and export from the Recovery page', async () => {
  const f = new Fixture().baseline();
  f.evolve(f.p1Files());
  const s = await shell(f.host);
  const csrf = await s.csrf();
  const snap = (f.host.worlds() as any[]).find(w => w.kind === 'recovery').id;
  await s.follow(await s.post('/recovery/restore', { __csrf: csrf, snapshot: snap }));
  assert.equal(f.host.world('project').status, 'retained');
  const back = await s.follow(await s.post('/recovery/switch', { __csrf: csrf, target: 'project' }));
  assert.match(back.body, /Now working on project/);
  assert.equal(f.host.world('project').status, 'active');
  assert.match(back.body, /Comparison \(app version 2\)/, 'the newer work is back');
  const dest = `${tempDir()}/export-from-ui`;
  const exported = await s.follow(await s.post('/protected/export', { __csrf: csrf, dest }));
  assert.match(exported.body, /Exported to .* and verified/);
  const relative = await s.follow(await s.post('/protected/export', { __csrf: csrf, dest: 'not/absolute' }));
  assert.match(relative.body, /Enter a full folder path/);
});
