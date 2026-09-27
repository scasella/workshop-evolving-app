import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HostError, type Json } from './canonical.ts';
import { finalizeDecision, Rejection, transferObligation } from './checker.ts';
import type { Field } from './lang.ts';
import { readPackageDir, withManifest } from './package-dir.ts';
import { recoveryPage } from './recovery.ts';
import { actionForm, commitments, decisions, h, messagePage, page, STATUS_TEXT, viewModel, witnessList, type FormContext } from './render.ts';
import type { Host, Outcome } from './store.ts';
import { authorAttempts, parseTarget, reconcileAuthorAttempts, type Target } from './evolve.ts';
import { codexReviewer, localAuthoringProblems, localAuthorAndPropose } from './local-codex.ts';
import { runQueued } from './runner.ts';
import { createExport, verifyExport } from './export.ts';

// Loopback-only protected shell. Localhost is not authentication: every request
// needs the host-issued session; every state change also needs a matching Host,
// same-origin Origin, and a session-bound CSRF token. No page carries script.
// The author service is injectable so the UI can be tested without Docker or credentials.
export type AuthorService = {
  problems: (root: string | null) => string[];
  attempts: () => { id: string; state: string; root: string }[];
  start: (args: { world: string; request: string; proposalId: string; root: string; target: Target | null }) => Promise<{ status: string; reasons: string[] }>;
};
// Owner-directed default: live calls go through the local `codex exec` (see local-codex.ts),
// with bounded repair attempts, each charged to the chosen allowance.
export function liveAuthorService(host: Host): AuthorService {
  return {
    problems: root => localAuthoringProblems(host, root),
    attempts: () => authorAttempts(host),
    start: async ({ world, request, proposalId, root, target }) => {
      const r = await localAuthorAndPropose(host, { world, request, proposalId, model: host.authorModel()!, root, target });
      return { status: r.proposal?.status ?? 'failed', reasons: r.proposal ? [] : r.attempts.flatMap(a => a.reasons).slice(0, 8) };
    }
  };
}
export type ShellOptions = { port: number; loginToken?: string; packagesDir?: string; author?: AuthorService };
const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSS = readFileSync(new URL('./shell.css', import.meta.url));
const OP = /^ui-[a-z0-9]{6,40}$/;
// An action with a title-like input creates something, so its `id` can be generated; otherwise `id` names an existing item.
export const createsItem = (inputs: Record<string, Field>) => 'id' in inputs && inputs.id.type === 'string' && ['title', 'statement', 'question', 'name'].some(k => k in inputs);

export function buildShell(host: Host, opts: ShellOptions) {
  const app = Fastify({ bodyLimit: 64 * 1024, logger: false });
  const loginToken = opts.loginToken ?? randomBytes(24).toString('hex');
  const secret = randomBytes(32);
  const sessions = new Set<string>();
  const flashes = new Map<string, { kind: 'error' | 'ok'; lines: string[] }>();
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set([...hosts].map(x => `http://${x}`));
  const csrfFor = (session: string) => createHmac('sha256', secret).update(session).digest('hex');
  const session = (req: FastifyRequest) => {
    const m = /(?:^|;\s*)ws_session=([0-9a-f]{48})/.exec(req.headers.cookie ?? '');
    return m && sessions.has(m[1]) ? m[1] : null;
  };
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const html = (reply: FastifyReply, body: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(body);

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body as string))); } catch (e) { done(e as Error, undefined); }
  });
  app.addHook('onRequest', async (req, reply) => {
    // 'same-origin', not 'no-referrer': with no-referrer, browsers send Origin: null on
    // same-origin form posts, which the Origin check below must (and does) refuse.
    reply.header('Content-Security-Policy', CSP).header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin')
      .header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY');
    // DNS-rebinding defence: the Host header must name this loopback listener.
    if (!hosts.has(String(req.headers.host))) return reply.code(403).type('text/plain').send('Forbidden host');
    if ((req.method === 'GET' && req.url.startsWith('/login')) || req.url === '/shell.css') return;
    const s = session(req);
    if (!s) return html(reply, messagePage('Sign in to Workshop', ['You are not signed in. Open the sign-in link that the Workshop host printed in its terminal when it started (it looks like http://127.0.0.1:PORT/login?token=…).',
      'Restarting the host prints a new link and ends earlier sessions.']), 401);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = String(req.headers.origin ?? '');
      if (!origins.has(origin)) return reply.code(403).type('text/plain').send('Cross-origin request refused');
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'POST') {
      const s = session(req)!; const token = String((req.body as any)?.__csrf ?? '');
      if (!same(token, csrfFor(s))) return reply.code(403).type('text/plain').send('Missing or invalid form token');
    }
  });
  const csrf = (req: FastifyRequest) => csrfFor(session(req)!);
  const flash = (reply: FastifyReply, to: string, kind: 'error' | 'ok', lines: string[]) => {
    const id = randomUUID(); flashes.set(id, { kind, lines });
    if (flashes.size > 100) flashes.delete(flashes.keys().next().value!);
    // The notice goes in the query, before any #fragment, or the browser would never send it.
    const [path, fragment] = to.split('#');
    return reply.code(303).header('Location', `${path}${path.includes('?') ? '&' : '?'}notice=${id}${fragment ? `#${fragment}` : ''}`).send();
  };
  const notice = (req: FastifyRequest) => { const id = (req.query as any)?.notice; const n = id ? flashes.get(id) : undefined; if (id) flashes.delete(id); return n; };
  // Plain-language versions of the host's refusals.
  const explain = (o: Extract<Outcome, { status: 'rejected' }>) => o.code === 'stale_revision'
    ? ['The project changed since you opened this page, so nothing was saved. Your entry is filled in again below; submit it once more.']
    : o.code === 'operation_mismatch' ? ['This form was already submitted with different values; reload the page and try again.'] : o.reasons;
  const outcome = (reply: FastifyReply, to: string, o: Outcome, ok: string) =>
    o.status === 'committed' ? flash(reply, to, 'ok', [ok, ...o.notes]) : flash(reply, to, 'error', explain(o));
  const liveWorld = () => (host.worlds() as any[]).find(w => w.kind === 'live' && w.status === 'active')?.id as string;
  const titles = (world: string) => new Map<string, string>([
    ...[...host.state(world).records.values()].map(r => [r.id, String(r.data.title ?? r.data.statement ?? r.id)] as [string, string]),
    ...host.ledger().map(o => [o.id, o.title] as [string, string])]);
  const revisionOf = (b: Record<string, string>) => { const n = Number(b.__revision); if (!Number.isSafeInteger(n) || n < 0) throw new HostError('bad_request', 'This form is out of date; reload the page.'); return n; };
  const opOf = (b: Record<string, string>) => OP.test(String(b.__op ?? '')) ? String(b.__op) : `ui-${randomUUID()}`;
  const formContext = (world: string): FormContext => {
    const s = host.state(world);
    return {
      records: [...s.records.values()].map(r => ({ id: r.id, type: r.type, title: String(r.data.title ?? r.data.statement ?? r.id) })),
      decisions: [...s.decisions.values()].filter(d => d.status === 'draft').map(d => ({ id: d.id, title: d.question })),
      obligations: host.ledger(world).filter(o => o.world === world && (o.status === 'open' || o.status === 'blocked')).map(o => ({ id: o.id, title: o.title }))
    };
  };

  app.get('/login', async (req, reply) => {
    const token = String((req.query as any)?.token ?? '');
    if (!same(token, loginToken)) return html(reply, messagePage('Sign-in link not valid', ['This sign-in link is not valid for the running host. Use the link printed in the terminal the last time Workshop started.']), 401);
    const s = randomBytes(24).toString('hex'); sessions.add(s);
    return reply.code(303).header('Set-Cookie', `ws_session=${s}; HttpOnly; SameSite=Strict; Path=/`).header('Location', '/project').send();
  });
  app.get('/shell.css', async (_req, reply) => reply.type('text/css').send(CSS));
  app.get('/', async (_req, reply) => reply.code(303).header('Location', '/project').send());

  // ---------- Working project ----------
  app.get('/project', async (req, reply) => {
    const world = liveWorld();
    const token = csrf(req);
    let prefill: { action?: string; input?: Record<string, unknown> } = {};
    try { prefill = JSON.parse(String((req.query as any)?.prefill ?? '{}')); } catch { /* ignore malformed prefill */ }
    const w = host.world(world);
    const state = host.state(world);
    const names = titles(world);
    const pkg = host.pkg(w.packageHash);
    const project = pkg ? host.project(world) : null;
    const ledger = host.ledger();
    const retained = (host.worlds() as any[]).filter(x => x.kind === 'live' && x.status === 'retained');
    const branches = (host.worlds() as any[]).filter(x => x.kind === 'live' && x.id !== world).map(x => String(x.id));
    const blocking = new Map<string, string[]>();
    for (const d of state.decisions.values()) if (d.status === 'draft') {
      try { finalizeDecision(state, ledger, host.ctx(world), 'owner', d.id, d.subjects[0] ?? '', branches); }
      // Any failure here only affects the hint; the page must still render.
      catch (e: any) { blocking.set(d.id, e instanceof Rejection ? e.reasons.map(r => r.replace(/^Cannot finalize: /, '')) : [String(e?.message ?? e)]); }
    }
    const queued = host.tasks(world).filter(t => t.status === 'queued');
    const authoringReady = !!host.authorModel() && host.allowances().some(r => r.used < r.total);
    const views = (project?.views ?? []).map(v => {
      let rendered; try { rendered = viewModel(v); } catch (e: any) { rendered = viewModel({ id: v.id, title: v.title, kind: v.kind, error: e.message }); }
      return h('div', { key: v.id }, rendered, h('p', { className: 'meta' }, h('a', { href: `/change?target=view:${v.id}` }, `Change the “${v.title}” view…`)));
    });
    const ctx = formContext(world);
    const empty = state.records.size === 0;
    const body = h('div', null,
      h('header', { className: 'project-head' }, h('h1', null, pkg ? `${pkg.manifest.name[0].toUpperCase()}${pkg.manifest.name.slice(1)} (app version ${pkg.manifest.version})` : 'Project'),
        h('p', { className: 'lede' }, 'Your project: notes, options, decisions and the reviews they need. You can change how this app works under “Change this”; every change is previewed, and your open reviews and history are kept.'),
        h('p', { className: 'meta' }, `Branch ${world} · revision ${w.revision} · live Codex authoring ${host.authorModel() ? `set up (${host.authorModel()})` : 'not set up'}`)),
      retained.length || w.parent ? h('div', { className: 'notice', role: 'status' },
        h('p', null, w.parent ? `You are on “${world}”, restored from an earlier snapshot. ` : '', retained.length ? `Kept branches you can return to: ` : ''),
        retained.map(r => h('form', { key: r.id, method: 'post', action: '/recovery/switch', className: 'inline' }, h('input', { type: 'hidden', name: '__csrf', value: token }),
          h('input', { type: 'hidden', name: 'target', value: r.id }), h('button', { type: 'submit', className: 'secondary' }, `Switch to “${r.id}” (revision ${r.revision})`)))) : null,
      pkg ? null : h('div', { className: 'notice error', role: 'alert' }, h('p', null, 'The active application package is unavailable or failed verification. Your records and commitments are intact. '), h('p', null, h('a', { href: '/recovery' }, 'Open Versions & recovery'))),
      empty ? h('div', { className: 'notice', role: 'note' }, h('p', null, 'New project. Start by adding the options you are choosing between (Add alternative), then start a decision and require a review. The “Suggested next steps” box below follows along.')) : null,
      queued.length ? (host.allowances().length && host.authorModel()
        ? h('form', { method: 'post', action: '/protected/run-reviews', className: 'inline protected' },
          h('input', { type: 'hidden', name: '__csrf', value: token }), h('label', { htmlFor: 'review-root' }, `${queued.length} review job(s) waiting. Charge to allowance`),
          h('select', { id: 'review-root', name: 'root' }, host.allowances().map(r => h('option', { key: r.root, value: r.root }, `${r.root} (${r.total - r.used} left)`))),
          h('button', { type: 'submit' }, 'Run them with Codex (live, paid calls)'))
        : h('p', { className: 'notice', role: 'note' }, `${queued.length} review job(s) waiting. To run them, set up Codex under `, h('a', { href: '/change#authoring-settings' }, 'Change this → Authoring settings'), '.')) : null,
      commitments({ csrf: token, world, revision: w.revision, obligations: ledger.filter(o => o.world === world || host.lineage(world).includes(o.world)), titles: names,
        waiting: new Set(host.tasks().filter(t => ['queued', 'running', 'reconcile'].includes(t.status)).map(t => t.obligation)), lastReview: host.lastReviews(), authoringReady,
        live: ledger.filter(o => o.world === world && (o.status === 'open' || o.status === 'blocked')).map(o => ({ id: o.id, title: o.title })) }),
      decisions({ csrf: token, world, revision: w.revision, decisions: [...state.decisions.values()], titles: names, blocking }),
      project?.planner.suggestions.length ? h('section', { className: 'next', 'aria-labelledby': 'next' }, h('h2', { id: 'next' }, 'Suggested next steps'),
        h('ul', null, project.planner.suggestions.map((s, i) => h('li', { key: i }, h('a', { href: `/project?prefill=${encodeURIComponent(JSON.stringify({ action: s.action, input: s.input }))}#action-${s.action}` }, s.label))))) : null,
      project?.planner.error ? h('p', { className: 'notice error', role: 'alert' }, `Planner unavailable: ${project.planner.error}`) : null,
      h('section', { 'aria-labelledby': 'app' }, h('h2', { id: 'app' }, 'Your project'), ...views),
      project ? h('section', { 'aria-labelledby': 'actions' }, h('h2', { id: 'actions' }, 'Actions'), h('p', { className: 'hint' }, 'Open an action to fill it in.'),
        project.actions.map(a => h('div', { key: a.id }, actionForm({ csrf: token, world, revision: w.revision, packageHash: w.packageHash, action: a, ctx,
          prefill: prefill.action === a.id ? prefill.input : undefined, open: prefill.action === a.id }), h('p', { className: 'meta' }, h('a', { href: `/change?target=action:${a.id}` }, `Change “${a.title}”…`))))) : null);
    return html(reply, page({ title: 'Project', csrf: token, body, notice: notice(req), current: '/project' }));
  });

  // Fill generated identifiers, drop empty optionals, keep integers typed.
  const coerce = (world: string, actionId: string, inputs: Record<string, Field>, body: Record<string, string>) => {
    const out: Record<string, Json> = {};
    for (const [name, spec] of Object.entries(inputs)) {
      const raw = body[`in.${name}`];
      if (spec.type === 'bool') { out[name] = raw === 'on'; continue; }
      if (raw === undefined || raw === '') continue;
      out[name] = spec.type === 'int' ? (/^-?\d{1,15}$/.test(raw) ? Number(raw) : raw) : raw.trim();
    }
    if (createsItem(inputs) && out.id === undefined) {
      const basis = ['title', 'statement', 'question', 'name'].map(k => out[k]).find(v => typeof v === 'string' && v) as string | undefined;
      out.id = host.newId(world, basis ?? actionId);
    }
    if ('key' in inputs && inputs.key.type === 'string' && out.key === undefined) out.key = host.newKey(actionId.replace(/^request_/, ''));
    return out;
  };
  const rawInputs = (b: Record<string, string>) => Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith('in.')).map(([k, v]) => [k.slice(3), v]));
  app.post('/project/action', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const pkg = host.pkg(b.__package);
    const action = pkg?.actions.get(b.__action);
    const practice = host.world(b.__world).kind === 'proposal';
    const base = practice ? `/proposal/${(host.db.prepare('SELECT id FROM proposals WHERE practice_world=?').get(b.__world) as any)?.id}` : '/project';
    if (!action) return flash(reply, base, 'error', ['That action is not part of this version of the app.']);
    // A repeated submit of the same rendered form gets the answer recorded the first time.
    const prior = OP.test(String(b.__op ?? '')) ? host.priorOutcome(b.__op) : null;
    if (prior?.status === 'committed') return flash(reply, base, 'ok', [`${practice ? 'Practice: ' : ''}${action.title} — done.`, 'This form had already been submitted; it was saved once.']);
    const o = host.run({ operationId: opOf(b), worldId: b.__world, expectedRevision: revisionOf(b), packageHash: b.__package,
      capabilityRef: `cap-owner-${liveWorld()}`, actionId: b.__action, input: coerce(b.__world, action.id, action.inputs, b) });
    if (o.status === 'committed') return flash(reply, base, 'ok', [`${practice ? 'Practice: ' : ''}${action.title} — done.`, ...o.notes]);
    // Keep what the owner typed: reopen the same form, filled in.
    return flash(reply, `${base}?prefill=${encodeURIComponent(JSON.stringify({ action: action.id, input: rawInputs(b) }))}#action-${action.id}`, 'error', explain(o));
  });
  app.post('/project/continue', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const ob = host.ledger(b.__world).find(o => o.id === b.obligation);
    if (!ob) return flash(reply, '/project', 'error', ['That review no longer exists.']);
    const o = host.run({ operationId: opOf(b), worldId: b.__world, expectedRevision: revisionOf(b), packageHash: ob.continuation.packageHash,
      capabilityRef: `cap-owner-${liveWorld()}`, actionId: ob.continuation.action, input: host.continuationInput(ob, b.verdict, b.note, null) });
    return outcome(reply, '/project', o, `Review recorded for “${ob.title}”: ${STATUS_TEXT[b.verdict] ?? b.verdict}.`);
  });
  app.post('/protected/finalize', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.confirm !== 'on') return flash(reply, '/project', 'error', ['Tick “I understand a final decision cannot be changed” to finalize.']);
    return outcome(reply, '/project', host.finalize(opOf(b), b.__world, revisionOf(b), b.decision, b.choice), 'Decision finalized.');
  });
  // Dispatch queued review jobs to Codex in the background, charged to an owner-granted allowance.
  let reviewing = false;
  app.post('/protected/run-reviews', async (req, reply) => {
    const root = String((req.body as any).root ?? '');
    const problems = localAuthoringProblems(host, root || null);
    if (problems.length) return flash(reply, '/project', 'error', problems);
    if (reviewing) return flash(reply, '/project', 'error', ['Review jobs are already running.']);
    reviewing = true;
    void runQueued(host, codexReviewer(host.authorModel()!), { root, concurrency: 2 }).finally(() => { reviewing = false; });
    return flash(reply, '/project', 'ok', [`Review jobs are running with Codex, charged to ${root} (one unit each). Reload this page to see the verdicts.`]);
  });
  app.post('/protected/review-again', async (req, reply) => {
    try { host.requestAnotherReview(String((req.body as any).obligation)); return flash(reply, '/project', 'ok', ['Another review is queued. It uses one allowance unit when it runs.']); }
    catch (e: any) { return flash(reply, '/project', 'error', [e.message]); }
  });
  app.post('/protected/dispose', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const kind = b.kind === 'supersede' ? 'supersede' : 'cancel';
    if (kind === 'supersede' && !b.successor) return flash(reply, '/project', 'error', ['To replace a review, choose the review that replaces it.']);
    if (!b.reason || b.reason.trim().length < 3) return flash(reply, '/project', 'error', ['Give a reason of at least a few words; it is kept in the history.']);
    return outcome(reply, '/project', host.dispose(opOf(b), b.__world, revisionOf(b), b.obligation, kind, b.reason.trim(), kind === 'supersede' ? b.successor : null),
      kind === 'cancel' ? 'Review cancelled; the reason is kept in the history.' : 'Review replaced; the reason is kept in the history.');
  });

  // ---------- Change this: propose, rehearse, approve ----------
  const sources = () => opts.packagesDir ? readdirSync(opts.packagesDir).filter(d => statSync(join(opts.packagesDir!, d)).isDirectory()).sort() : [];
  const author = opts.author ?? liveAuthorService(host);
  // This shell is the controller: attempts left running by a previous process are now uncertain.
  reconcileAuthorAttempts(host);
  const authoring = new Map<string, { request: string; status: string; reasons: string[]; started: string; target: string | null }>();
  // What the owner should know before changing the targeted thing: host-derived, not package-derived.
  const targetConditions = (world: string, target: Target | null): string[] => {
    const live = host.ledger().filter(o => o.world === world && (o.status === 'open' || o.status === 'blocked'));
    if (!target) return live.map(o => `“${o.title}” stays open and keeps its original rule.`);
    if (target.kind === 'record') return live.filter(o => o.subjects.includes(target.id)).map(o => `“${o.title}” covers this item; changing what was reviewed opens a new review.`);
    if (target.kind === 'action') return live.filter(o => o.continuation.action === target.id).map(o => `“${o.title}” is completed through this action; it must keep working (the version it was created in is kept).`);
    return [`Views cannot change commitments; ${live.length} open commitment(s) stay as they are.`];
  };
  const targetName = (world: string, target: Target) => {
    const pkg = host.pkg(host.world(world).packageHash);
    if (target.kind === 'view') return pkg?.views.get(target.id)?.title ?? target.id;
    if (target.kind === 'action') return pkg?.actions.get(target.id)?.title ?? target.id;
    return titles(world).get(target.id) ?? target.id;
  };
  app.get('/change', async (req, reply) => {
    const token = csrf(req); const world = liveWorld();
    const target = parseTarget((req.query as any)?.target);
    const w = host.world(world);
    const roots = host.allowances();
    const defaultRoot = roots.find(r => r.used < r.total)?.root ?? null;
    const problems = author.problems(defaultRoot);
    const conditions = targetConditions(world, target);
    const label = target ? `${target.kind} “${targetName(world, target)}”` : null;
    const request = label ? `Change the ${label}: ` : '';
    const local = h('section', { 'aria-labelledby': 'local' }, h('h2', { id: 'local' }, problems.length ? 'Propose a new version of the app' : 'Or: propose a package you edited yourself'),
      h('p', { className: 'hint' }, 'Pick a package folder (the app ships with p1-comparison and p2-evidence as examples). You get a preview you can try before anything changes.'),
      h('form', { method: 'post', action: '/change' }, h('input', { type: 'hidden', name: '__csrf', value: token }),
        h('div', { className: 'field' }, h('label', { htmlFor: 'request' }, 'What should change?'), h('textarea', { id: 'request', name: 'request', required: true, rows: 2, maxLength: 2000, defaultValue: request })),
        h('div', { className: 'field' }, h('label', { htmlFor: 'source' }, 'Package folder'),
          h('select', { id: 'source', name: 'source' }, sources().map(s => h('option', { key: s, value: s }, s)))),
        h('button', { type: 'submit' }, 'Prepare a preview')));
    const ask = h('section', { 'aria-labelledby': 'ask' }, h('h2', { id: 'ask' }, 'Ask Codex to write the change'),
      problems.length ? h('div', { className: 'notice', role: 'status' }, h('p', null, 'Not available yet. To use it:'), h('ul', null, problems.map((p, i) => h('li', { key: i }, p))),
        h('p', null, h('a', { href: '#authoring-settings' }, 'Open Authoring settings'))) : null,
      h('form', { method: 'post', action: '/change/author' }, h('input', { type: 'hidden', name: '__csrf', value: token }),
        target ? h('input', { type: 'hidden', name: 'target', value: `${target.kind}:${target.id}` }) : null,
        h('div', { className: 'field' }, h('label', { htmlFor: 'ask-request' }, 'What should change?'), h('textarea', { id: 'ask-request', name: 'request', required: true, rows: 3, maxLength: 2000, defaultValue: request })),
        roots.length ? h('div', { className: 'field' }, h('label', { htmlFor: 'ask-root' }, 'Charge to allowance'),
          h('select', { id: 'ask-root', name: 'root', defaultValue: defaultRoot ?? undefined }, roots.map(r => h('option', { key: r.root, value: r.root }, `${r.root} (${r.total - r.used} left)`)))) : null,
        h('button', { type: 'submit', disabled: problems.length > 0 }, 'Ask Codex (live, paid calls: up to 3)')));
    const settings = h('details', { className: 'protected', id: 'authoring-settings', open: !host.authorModel() || !roots.some(r => r.used < r.total) }, h('summary', null, 'Authoring settings'),
      h('p', { className: 'meta' }, 'Needs the Codex CLI signed in on this machine. Each call to Codex, and each review job, uses one unit of the allowance you grant. Nothing runs until you press a button.'),
      h('form', { method: 'post', action: '/protected/authoring', className: 'inline' }, h('input', { type: 'hidden', name: '__csrf', value: token }),
        h('label', { htmlFor: 'model' }, 'Model'), h('input', { id: 'model', name: 'model', defaultValue: host.authorModel() ?? '', required: true, pattern: '[A-Za-z0-9_.-]{1,100}' }),
        h('label', { htmlFor: 'root' }, 'Allowance name'), h('input', { id: 'root', name: 'root', defaultValue: `change-${w.revision}`, required: true, pattern: '[A-Za-z0-9_.:-]{1,80}' }),
        h('label', { htmlFor: 'units' }, 'Calls (1–10)'), h('input', { id: 'units', name: 'units', type: 'number', min: 1, max: 10, defaultValue: 3, required: true }),
        h('button', { type: 'submit' }, 'Save and grant')));
    const rows = author.attempts();
    const ids = [...new Set([...rows.map(r => r.id), ...authoring.keys()])];
    const describe = (id: string) => {
      const row = rows.find(r => r.id === id); const mem = authoring.get(id);
      if (row?.state === 'uncertain') return `${id}: interrupted — the call may have run and been charged (${row.root}); it is not retried`;
      if (mem?.status === 'running' || row?.state === 'running') return `${id}: running${mem ? ` since ${mem.started}` : ''} — reload to check`;
      const status = mem?.status ?? row?.state ?? 'unknown';
      return h('span', null, h('a', { href: `/proposal/${id}` }, id), ` — ${STATUS_TEXT[status] ?? status}${mem?.reasons.length ? `: ${mem.reasons.join('; ')}` : ''}`);
    };
    const proposals = (host.proposals(world) as any[]).slice().reverse();
    const body = h('div', null, h('h1', null, label ? `Change the ${label}` : 'Change this app'),
      h('section', { className: 'protected', 'aria-labelledby': 'conditions' }, h('h2', { id: 'conditions' }, 'What stays protected'),
        conditions.length ? h('ul', null, conditions.map((c, i) => h('li', { key: i }, c))) : h('p', { className: 'empty' }, 'No open commitments are affected.'),
        h('p', { className: 'meta' }, 'A change can ask for more permissions; you see and approve them before anything is applied.')),
      ...(problems.length ? [local, ask, settings] : [ask, settings, local]),
      ids.length ? h('section', null, h('h2', null, 'Codex requests'), h('ul', null, ids.map(id => h('li', { key: id }, describe(id))))) : null,
      proposals.length ? h('section', null, h('h2', null, 'Earlier proposals'), h('ul', null, proposals.map(p => h('li', { key: p.id }, h('a', { href: `/proposal/${p.id}` }, p.request), ` — ${STATUS_TEXT[p.status] ?? p.status}`)))) : null);
    return html(reply, page({ title: 'Change this', csrf: token, body, notice: notice(req), current: '/change' }));
  });
  app.post('/protected/authoring', async (req, reply) => {
    const b = req.body as Record<string, string>;
    try {
      host.setAuthorModel(String(b.model));
      const units = Number(b.units);
      if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(String(b.root)) || !Number.isSafeInteger(units) || units < 1 || units > 10) throw new Error('The allowance needs a name and 1–10 calls.');
      host.grantAllowance(String(b.root), units);
    } catch (e: any) { return flash(reply, '/change', 'error', [e.message]); }
    return flash(reply, '/change', 'ok', [`Model ${b.model}; allowance ${b.root} can now make ${b.units} call(s). No call has been made.`]);
  });
  app.post('/change/author', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const target = parseTarget(b.target);
    const problems = author.problems(b.root || null);
    if (problems.length) return flash(reply, '/change', 'error', problems);
    const id = `prop-${randomBytes(4).toString('hex')}`;
    const request = String(b.request ?? '').slice(0, 2000) || 'Change request';
    authoring.set(id, { request, status: 'running', reasons: [], started: new Date().toISOString(), target: b.target ?? null });
    // The model call runs in the background; its receipt and proposal appear on this page.
    void author.start({ world: liveWorld(), request, proposalId: id, root: b.root, target })
      .then(r => authoring.set(id, { ...authoring.get(id)!, status: r.status, reasons: r.reasons }))
      .catch((e: any) => authoring.set(id, { ...authoring.get(id)!, status: 'failed', reasons: [String(e?.message ?? e)] }));
    return flash(reply, '/change', 'ok', [`Codex request ${id} started. It may use up to 3 units of ${b.root} (one per attempt). The proposal appears here when it finishes; reload to check.`]);
  });
  app.post('/change', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (!sources().includes(b.source)) return flash(reply, '/change', 'error', ['Choose one of the listed package folders.']);
    const world = liveWorld();
    const files = withManifest(readPackageDir(join(opts.packagesDir!, b.source)), { parent: host.world(world).packageHash });
    const id = `prop-${randomBytes(4).toString('hex')}`;
    const r = host.propose(id, world, String(b.request ?? '').slice(0, 2000) || 'Change request', files);
    return r.status === 'previewable' ? flash(reply, `/proposal/${id}`, 'ok', ['Preview ready. Try it below; nothing changes in your project until you apply it.'])
      : flash(reply, `/proposal/${id}`, 'error', r.reasons);
  });
  app.get('/proposal/:id', async (req, reply) => {
    const token = csrf(req);
    const p = host.proposal((req.params as any).id);
    const r = p.report;
    let prefill: { action?: string; input?: Record<string, unknown> } = {};
    try { prefill = JSON.parse(String((req.query as any)?.prefill ?? '{}')); } catch { /* ignore */ }
    const practice = p.practiceWorld && (p.status === 'previewable' || p.status === 'approved') ? host.project(p.practiceWorld) : null;
    const pw = p.practiceWorld ? host.world(p.practiceWorld) : null;
    const cand = p.packageHash ? host.pkg(p.packageHash) : undefined;
    const successor = host.db.prepare('SELECT id, status FROM proposals WHERE supersedes=?').get(p.id) as any;
    const actionTitle = (a: string) => cand?.actions.get(a)?.title ?? a;
    const list = (label: string, items: string[]) => items?.length ? h('p', null, h('strong', null, `${label}: `), items.join(', ')) : null;
    const newCaps = r.capabilities ? r.capabilities.after.filter((c: string) => !r.capabilities.before.includes(c)) : [];
    const body = h('div', null, h('p', null, h('a', { href: '/change' }, '← Change this')),
      h('h1', null, `“${p.request.replace(/ \[authored.*\]$/, '')}”`), h('p', { className: 'meta' }, `Proposal ${p.id} · ${STATUS_TEXT[p.status] ?? p.status}`),
      successor ? h('p', { className: 'notice', role: 'status' }, 'This preview was refreshed. ', h('a', { href: `/proposal/${successor.id}` }, 'Open the current preview')) : null,
      r.problems?.length || r.rejected?.length ? h('section', { className: 'notice error', role: 'alert' }, h('h2', null, 'Why this cannot be applied'), h('ul', null, [...(r.problems ?? []), ...(r.rejected ?? [])].map((x: string, i: number) => h('li', { key: i }, x)))) : null,
      r.added ? h('section', null, h('h2', null, 'What changes'), list('New kinds of item', r.added.types), list('New fields', r.added.fields), list('New links', r.added.relations),
        list('New actions', r.added.actions.map(actionTitle)), list('New views', r.added.views.map((v: string) => cand?.views.get(v)?.title ?? v)), list('New suggestions', r.added.plannerRules),
        h('p', null, h('strong', null, 'New permissions: '), newCaps.length ? newCaps.join(', ') : 'none'),
        h('p', null, `${r.migratedRecords} existing item(s) get new fields; nothing you entered is rewritten.`)) : null,
      r.witnesses ? h('section', null, h('h2', null, 'Your open reviews'), h('p', { className: 'hint' }, 'Checked by Workshop itself, not by the proposed app.'), witnessList(r.witnesses, titles(p.world))) : null,
      r.supplementalTests?.length ? h('section', null, h('h2', null, 'The package’s own rehearsals'),
        h('p', { className: 'hint' }, 'Scripted checks written by the package, replayed on a copy of your data. They can block a change but never replace Workshop’s own checks.'),
        h('ul', null, r.supplementalTests.map((t: any) => h('li', { key: t.id, className: t.passed ? 'ok' : 'bad' }, `${t.title}: ${t.passed ? 'passed' : t.failures.join('; ')}`)))) : null,
      practice && pw ? h('section', { className: 'practice', 'aria-labelledby': 'practice' }, h('h2', { id: 'practice' }, 'Try the changed app'),
        h('p', { className: 'notice', role: 'note' }, h('strong', null, 'Practice only: nothing you do here is applied.'), ' Applying installs the new version and its data migration on your real project.'),
        ...practice.views.map(v => viewModel(v, `/proposal/${p.id}`)),
        h('h3', null, 'Practice actions'), practice.actions.map(a => h('div', { key: a.id },
          actionForm({ csrf: token, world: pw.id, revision: pw.revision, packageHash: pw.packageHash, action: a, practice: true, ctx: formContext(pw.id),
            prefill: prefill.action === a.id ? prefill.input : undefined, open: prefill.action === a.id })))) : null,
      p.status === 'previewable' ? h('p', null, h('a', { className: 'button', href: `/protected/approve/${p.id}` }, 'Review and apply…')) : null,
      p.status === 'stale' && !successor ? h('form', { method: 'post', action: `/proposal/${p.id}/refresh` }, h('input', { type: 'hidden', name: '__csrf', value: token }),
        h('p', null, 'Your project changed after this preview. Refreshing keeps your edits and the proposed version, and asks for your approval again.'), h('button', { type: 'submit' }, 'Refresh preview')) : null);
    return html(reply, page({ title: 'Proposal', csrf: token, body, notice: notice(req), current: '/change' }));
  });
  app.post('/proposal/:id/refresh', async (req, reply) => {
    const old = (req.params as any).id as string;
    const existing = host.db.prepare('SELECT id FROM proposals WHERE supersedes=?').get(old) as any;
    if (existing) return flash(reply, `/proposal/${existing.id}`, 'ok', ['This preview was already refreshed.']);
    const id = `prop-${randomBytes(4).toString('hex')}`;
    const r = host.refresh(old, id);
    return r.status === 'previewable' ? flash(reply, `/proposal/${id}`, 'ok', ['Fresh preview ready; approve it again to apply.']) : flash(reply, `/proposal/${id}`, 'error', r.reasons);
  });
  // Protected approval surface: exact identity, plain summary, Apply or Reject. Never generated by a package.
  app.get('/protected/approve/:id', async (req, reply) => {
    const token = csrf(req);
    const p = host.proposal((req.params as any).id);
    if (p.status === 'active') return flash(reply, `/proposal/${p.id}`, 'ok', ['This change is already applied.']);
    if (p.status !== 'previewable' || !p.preview) return flash(reply, `/proposal/${p.id}`, 'error', [`This proposal is ${STATUS_TEXT[p.status] ?? p.status} and cannot be applied.`]);
    const live = host.world(p.world);
    const stale = live.revision !== p.preview.baseRevision;
    const failing = (p.report.witnesses ?? []).filter((w: any) => !w.ok);
    const newCaps = p.report.capabilities.after.filter((c: string) => !p.report.capabilities.before.includes(c));
    const body = h('div', { className: 'protected approval' }, h('p', null, h('a', { href: `/proposal/${p.id}` }, '← Back to the preview')), h('h1', null, 'Apply this change?'),
      h('p', null, `“${p.request.replace(/ \[authored.*\]$/, '')}”`),
      h('p', null, `This installs the previewed version of the app on your project and migrates your data as shown. Your open reviews:`), witnessList(p.report.witnesses ?? [], titles(p.world)),
      h('p', null, h('strong', null, 'New permissions: '), newCaps.length ? newCaps.join(', ') : 'none'),
      h('details', null, h('summary', null, 'Exact identity (for audit)'), h('dl', null,
        h('dt', null, 'Candidate'), h('dd', null, h('code', null, p.candidateHash)), h('dt', null, 'Preview'), h('dd', null, h('code', null, p.preview.previewHash)),
        h('dt', null, 'Base state'), h('dd', null, h('code', null, p.preview.baseDigest)), h('dt', null, 'Migration result'), h('dd', null, h('code', null, p.preview.resultDigest)))),
      stale ? h('div', { className: 'notice error', role: 'alert' }, h('p', null, `Your project changed after this preview (now revision ${live.revision}, preview of ${p.preview.baseRevision}). Refresh the preview before applying.`),
        h('form', { method: 'post', action: `/proposal/${p.id}/refresh` }, h('input', { type: 'hidden', name: '__csrf', value: token }), h('button', { type: 'submit' }, 'Refresh preview')))
      : failing.length ? h('p', { role: 'alert' }, 'This change would strand open reviews and cannot be applied.') :
        h('div', null,
          h('form', { method: 'post', action: `/protected/approve/${p.id}`, className: 'inline' }, h('input', { type: 'hidden', name: '__csrf', value: token }),
            h('input', { type: 'hidden', name: 'previewHash', value: p.preview.previewHash }), h('input', { type: 'hidden', name: 'candidateHash', value: p.candidateHash! }),
            h('button', { type: 'submit', name: 'decision', value: 'apply' }, 'Apply this change')),
          h('details', null, h('summary', null, 'Reject instead'),
            h('form', { method: 'post', action: `/protected/approve/${p.id}`, className: 'inline' }, h('input', { type: 'hidden', name: '__csrf', value: token }),
              h('label', { htmlFor: 'reject-reason' }, 'Reason (optional)'), h('input', { id: 'reject-reason', name: 'reason', maxLength: 300 }),
              h('button', { type: 'submit', name: 'decision', value: 'reject', className: 'secondary' }, 'Reject this change')))));
    return html(reply, page({ title: 'Apply change', csrf: token, body, notice: notice(req), current: '/change' }));
  });
  app.post('/protected/approve/:id', async (req, reply) => {
    const id = (req.params as any).id; const b = req.body as Record<string, string>;
    if (b.decision === 'reject') {
      try { host.rejectProposal(id, `Rejected by owner${b.reason ? `: ${String(b.reason).slice(0, 300)}` : ''}`); } catch (e: any) { return flash(reply, `/proposal/${id}`, 'error', [e.message]); }
      return flash(reply, `/proposal/${id}`, 'ok', ['You rejected this change; nothing was applied.']);
    }
    try { host.approve(id, { previewHash: b.previewHash, candidateHash: b.candidateHash }); }
    catch (e: any) { return flash(reply, `/proposal/${id}`, 'error', [e.message]); }
    const o = host.activate(id);
    return o.status === 'committed' ? flash(reply, '/project', 'ok', ['Change applied.', ...o.notes]) : flash(reply, `/proposal/${id}`, 'error', o.reasons);
  });

  // ---------- Activity, recovery, export, artifacts ----------
  const KIND: Record<string, string> = { project_created: 'setup', proposal_previewable: 'change', proposal_rejected: 'change', proposal_approved: 'you approved', package_activated: 'change applied',
    activation_rejected: 'host check', decision_finalized: 'you decided', obligation_disposed: 'you', snapshot_retained: 'safety copy', snapshot_restored: 'restore', branch_retained: 'restore',
    branch_switched: 'restore', attempt_started: 'review job', attempt_failed: 'review job', attempt_uncertain: 'review job', task_cancelled: 'review job', allowance_charged: 'cost',
    instance_imported: 'import', package_repaired: 'repair', review_requested_again: 'review job', author_attempts_uncertain: 'Codex', author_model_set: 'settings' };
  app.get('/inspect', async (req, reply) => {
    const token = csrf(req);
    const events = host.db.prepare('SELECT seq,world,kind,revision,command,data,at FROM events ORDER BY seq DESC LIMIT 200').all() as any[];
    const body = h('div', null, h('h1', null, 'Activity'), h('p', { className: 'hint' }, 'Everything Workshop recorded, newest first. Actions from the app appear as “action:…”; checks and decisions by Workshop itself are labelled.'),
      h('table', null, h('caption', { className: 'visually-hidden' }, 'Activity'), h('thead', null, h('tr', null, ['When', 'What', 'Kind', 'Branch', 'Detail'].map(c => h('th', { key: c, scope: 'col' }, c)))),
        h('tbody', null, events.map(e => h('tr', { key: e.seq }, [e.at ? String(e.at).replace('T', ' ').slice(0, 19) : '', e.kind, e.kind.startsWith('action:') ? 'app action' : KIND[e.kind] ?? 'host', e.world,
          String(e.data).slice(0, 240)].map((c, i) => h('td', { key: i }, String(c))))))));
    return html(reply, page({ title: 'Activity', csrf: token, body, current: '/inspect' }));
  });
  app.get('/recovery', async (req, reply) => {
    const n = notice(req); const world = liveWorld();
    // Offer a transfer only where the host's own check would accept it.
    const transferable = new Map<string, string | null>();
    for (const o of host.pendingWork().filter(o => o.world !== world)) {
      try { transferObligation(host.state(world), host.ledger(), host.ctx(world), 'owner', o.id, host.lineage(world), host.world(world).revision); transferable.set(o.id, null); }
      catch (e: any) { transferable.set(o.id, (e.reasons ?? [e.message]).join('; ')); }
    }
    return html(reply, recoveryPage(host, csrf(req), n, author.attempts(), transferable));
  });
  app.post('/recovery/cancel', async (req, reply) => {
    try { host.cancelTask(String((req.body as any).task)); return flash(reply, '/recovery', 'ok', ['Job stopped. It can no longer deliver a result.']); }
    catch (e: any) { return flash(reply, '/recovery', 'error', [e.message]); }
  });
  app.get('/recovery/restore/:snap', async (req, reply) => {
    const token = csrf(req); const snap = (req.params as any).snap as string;
    const pre = host.restorePreview(snap);
    const body = h('div', { className: 'protected approval' }, h('p', null, h('a', { href: '/recovery' }, '← Versions & recovery')), h('h1', null, 'Restore this snapshot?'),
      h('p', null, `Restoring creates a new branch from the snapshot and makes it your working project. The current branch “${pre.source}” is kept exactly as it is, and you can switch back to it at any time.`),
      h('h2', null, 'Not in the restored branch'), pre.excluded.length ? h('ul', null, pre.excluded.map((x, i) => h('li', { key: i }, x))) : h('p', null, 'Nothing: the snapshot matches the current branch.'),
      pre.pending.length ? h('div', null, h('h2', null, 'Open reviews that stay with “' + pre.source + '”'), h('ul', null, pre.pending.map((x, i) => h('li', { key: i }, x))),
        h('p', { className: 'meta' }, 'They stay open and still gate your decisions. You can finish, move or cancel them from Versions & recovery.')) : null,
      h('form', { method: 'post', action: '/recovery/restore' }, h('input', { type: 'hidden', name: '__csrf', value: token }), h('input', { type: 'hidden', name: 'snapshot', value: snap }),
        h('button', { type: 'submit' }, 'Restore as a new branch'), ' ', h('a', { href: '/recovery' }, 'Cancel')));
    return html(reply, page({ title: 'Restore snapshot', csrf: token, body, current: '/recovery' }));
  });
  app.post('/recovery/restore', async (req, reply) => {
    const r = host.restore(`ui-${randomUUID()}`, String((req.body as any).snapshot));
    return r.status === 'committed' ? flash(reply, '/project', 'ok', [`Snapshot restored as branch “${r.branch}”. Your previous branch is kept; switch back from the banner or from Versions & recovery.`]) : flash(reply, '/recovery', 'error', r.reasons);
  });
  app.post('/recovery/switch', async (req, reply) => outcome(reply, '/project', host.switchBranch(`ui-${randomUUID()}`, String((req.body as any).target)), 'Branch switched.'));
  app.post('/recovery/continue', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const ob = host.pendingWork().find(o => o.id === b.obligation);
    if (!ob) return flash(reply, '/recovery', 'error', ['That review is no longer open.']);
    const w = host.world(ob.world);
    return outcome(reply, '/recovery', host.run({ operationId: `ui-${randomUUID()}`, worldId: ob.world, expectedRevision: w.revision, packageHash: ob.continuation.packageHash,
      capabilityRef: `cap-owner-${liveWorld()}`, actionId: ob.continuation.action, input: host.continuationInput(ob, b.verdict, b.note, null) }), `Review recorded for “${ob.title}”.`);
  });
  app.post('/recovery/transfer', async (req, reply) => {
    const world = liveWorld();
    return outcome(reply, '/recovery', host.transfer(`ui-${randomUUID()}`, String((req.body as any).obligation), world, host.world(world).revision), 'Review moved to your working branch.');
  });
  app.post('/recovery/dispose', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const ob = host.pendingWork().find(o => o.id === b.obligation);
    if (!ob) return flash(reply, '/recovery', 'error', ['That review is no longer open.']);
    if (!b.reason || b.reason.trim().length < 3) return flash(reply, '/recovery', 'error', ['Give a reason of at least a few words.']);
    return outcome(reply, '/recovery', host.dispose(`ui-${randomUUID()}`, ob.world, host.world(ob.world).revision, ob.id, 'cancel', b.reason.trim()), 'Review cancelled; the reason is kept in the history.');
  });
  // Export to an owner-chosen folder. The folder must not exist yet (or be empty).
  app.post('/protected/export', async (req, reply) => {
    const dest = String((req.body as any).dest ?? '').trim();
    if (!isAbsolute(dest)) return flash(reply, '/recovery#export', 'error', ['Enter a full folder path, such as /Users/you/Desktop/workshop-export.']);
    if (existsSync(dest) && readdirSync(dest).length) return flash(reply, '/recovery#export', 'error', ['That folder already has files in it. Choose a new or empty folder.']);
    try {
      const m = await createExport(host, dest);
      const v = verifyExport(dest);
      return flash(reply, '/recovery#export', v.ok ? 'ok' : 'error', [v.ok ? `Exported to ${dest} and verified (${Object.keys(m.files).length} files).` : `Exported to ${dest}, but verification failed: ${v.problems.join('; ')}`,
        'Open it later with ./launch.sh inside that folder. To include a Linux runtime, use the terminal: node src/host/cli.ts export <state-dir> <out-dir> <node-binary> <license> <source>.']);
    } catch (e: any) { return flash(reply, '/recovery#export', 'error', e.reasons ?? [e.message]); }
  });
  // Artifacts are served as inert text, never as a document the browser renders.
  app.get('/artifact/:hash', async (req, reply) => {
    const hash = (req.params as any).hash;
    if (!/^[0-9a-f]{64}$/.test(hash) || !host.hasArtifact(hash)) return html(reply, messagePage('Not found', ['There is no stored file with that identity.']), 404);
    const a = host.readArtifact(hash);
    return reply.header('Content-Security-Policy', "sandbox; default-src 'none'").header('Content-Disposition', 'inline; filename="artifact.txt"')
      .type('text/plain; charset=utf-8').send(a.bytes);
  });
  app.setNotFoundHandler((_req, reply) => { html(reply, messagePage('Page not found', ['There is nothing at this address.']), 404); });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as HostError;
    if (e.code === 'not_found') return html(reply, messagePage('Not found', [e.message]), 404);
    if (e.code === 'bad_request') return html(reply, messagePage('Please reload', [e.message]), 400);
    return html(reply, messagePage('Something went wrong', [`Workshop could not complete that request: ${e.message}.`, 'Your data is unchanged by this error. Versions & recovery keeps working.']), 500);
  });
  return { app, loginToken };
}
