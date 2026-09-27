import { join } from 'node:path';
import { AuthorJournal, hash, type FileEdit } from '../authoring.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { authorInDocker, liveGateProblems, runtimeLock, type ModelTransport } from '../docker-author.ts';
import { need } from './canonical.ts';
import { Host } from './store.ts';

// "Change this" through the Codex author: assemble the minimum relevant context,
// run the isolated author, apply its validated edits to the parent package, and
// submit the result to the ordinary admission path. The author never sees
// credentials, never runs code, and cannot choose the parent it builds on.
export const LANGUAGE_BRIEF = `workshop-lang/1 package rules (the host rejects anything else):
- Files: package.json, planner.json, schemas/*.json, actions/*.json, views/*.json, migrations/*.json, prompts/*.md, tests/*.json. package.json "files" must list every other file exactly.
- package.json keys: name, version (integer), language "workshop-lang/1", parent (the host sets it), interpreters ["workshop-lang/1"], files, capabilities, migration (path or null), views (ids to show); optional retire, continuations.
- Capabilities: records.write, relations.write, obligations.open, evidence.submit, tasks.review, decisions.draft. Declare only what effects use.
- Schemas: {"types":[{"id","title","fields":{name:{type,semantic,...}}}],"relations":[{"id","title","from","to","fields"}]}. Field types: string(max), int(min,max), bool, enum(values), ref(to), artifact, list(of,max). Every field needs a stable "semantic" ID. Never remove or change an existing field; new fields must be optional or have a default.
- Expressions are one-key JSON objects: lit, input, var, get [expr, field], record, records <type>, related {relation, from?, to?}, obligations {gate?, subject?, status?}, decision, exists, eq/ne/lt/le/gt/ge/add/sub/mul/div/in/union [a,b], and/or/concat/list [...], not, len, unique, if [c,a,b], filter/any/all/count {list, as, where}, map/sum {list, as, to}. Integers only.
- Actions: {"id","title","inputs":{...fields},"let":[{"name","value"}],"requires":[{"when","reason"}],"effects":[...]}. Effects: create/update {type,id,fields}, relate {relation,from,to,fields}, obligation {key,title,subjects,gate,verdicts,discharge:"owner"|"job",independent?,continuation}, evidence {obligation,verdict,note,artifact?}, task {kind:"review",obligation,prompt}, decision {id,question,subjects,choice}, foreach {list,as,effects}.
- Views: table {rows, columns:[{label,value}], actions?}, matrix {rows, columns, rowLabel, columnLabel, cell}, status {items:[{label,value}]}, form {action}. Row variable is "row"; matrix uses "row" and "column". Text only.
- Planner: {"rules":[{"id","when","suggest":{"action","label","input"}}]}.
- Migration: {"steps":[{"backfill":{"type","field","value"}}]} writing only newly added fields; variable "record".
- Keep every existing action that open commitments continue through. Do not approve, finalize, or delete anything; the host owns those.`;

export type Target = { kind: 'view' | 'action' | 'record'; id: string };
export function parseTarget(value: unknown): Target | null {
  const m = /^(view|action|record):([a-z][a-z0-9_-]{0,79})$/.exec(String(value ?? ''));
  return m ? { kind: m[1] as Target['kind'], id: m[2] } : null;
}
export function authorPrompt(host: Host, world: string, request: string, target: Target | null = null): { prompt: string; parent: string } {
  const w = host.world(world);
  const pkg = host.pkg(w.packageHash);
  need(pkg, 'package_unavailable', 'active package unavailable');
  const commitments = host.pendingWork().filter(o => o.world === world)
    .map(o => `- ${o.id} "${o.title}": continues through action ${o.continuation.action} (keep it working)`).join('\n') || '- none';
  const files = Object.keys(pkg.files).sort().map(p => `=== ${p} ===\n${pkg.files[p]}`).join('\n');
  const prompt = `You are changing a Workshop application package. Return ONLY a JSON object {"files":[{"path","content"}]} listing every file you add or replace (full content). Unlisted files stay as they are.

Owner request: ${request}

${LANGUAGE_BRIEF}

${targetContext(host, world, target)}Open commitments that must keep working:
${commitments}

Current package (${pkg.manifest.name} v${pkg.manifest.version}):
${files}`;
  return { prompt, parent: pkg.hash };
}

function targetContext(host: Host, world: string, target: Target | null): string {
  if (!target) return '';
  const pkg = host.pkg(host.world(world).packageHash)!;
  if (target.kind === 'view') return `The owner is pointing at view "${target.id}" (views/${target.id}.json). Focus the change there.\n\n`;
  if (target.kind === 'action') return `The owner is pointing at action "${target.id}" (actions/${target.id}.json). Focus the change there; keep it working for open commitments that continue through it.\n\n`;
  const r = host.state(world).records.get(target.id);
  return `The owner is pointing at record ${target.id} of type ${r?.type ?? 'unknown'} (schema in ${[...pkg.types.keys()].includes(r?.type ?? '') ? 'schemas/' : 'n/a'}): ${JSON.stringify(r?.data ?? null).slice(0, 2000)}\n\n`;
}

// The host applies edits to a copy of the parent; the returned paths never touch a filesystem.
export function applyEdits(parent: Record<string, string>, edits: FileEdit[], parentHash: string): Record<string, string> {
  const out = { ...parent };
  for (const e of edits) out[e.path] = e.content;
  const manifest = JSON.parse(out['package.json']);
  need(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'package_manifest', 'edited package.json is not an object');
  // The author cannot pick what it builds on.
  out['package.json'] = JSON.stringify({ ...manifest, parent: parentHash }, null, 2) + '\n';
  // The edited manifest defines the file set: files it no longer lists are dropped from the
  // candidate (the parent package itself stays retained and unchanged).
  const listed = new Set<string>(Array.isArray(manifest.files) ? manifest.files : []);
  for (const path of Object.keys(out)) if (path !== 'package.json' && !listed.has(path)) delete out[path];
  return out;
}

// One author journal per host directory, next to host.sqlite.
const journals = new Map<string, AuthorJournal>();
export function authorJournal(host: Host): AuthorJournal {
  const path = join(host.dir, 'author-journal.sqlite');
  if (!journals.has(path)) journals.set(path, new AuthorJournal(path));
  return journals.get(path)!;
}
// Controller start: any attempt still marked running belonged to a process that is gone.
// Its outcome is unknown (the call may have run and cost money); keep its unit, never retry.
export function reconcileAuthorAttempts(host: Host): string[] {
  const j = authorJournal(host);
  const running = (j.db.prepare("SELECT id FROM author_attempts WHERE state='running'").all() as any[]).map(r => String(r.id));
  if (running.length) {
    j.reconcileAfterStoppedController();
    host.recordEvent('author_attempts_uncertain', { attempts: running, note: 'Interrupted Codex calls may have run and incurred cost; not retried automatically.' });
  }
  return running;
}
export function authorAttempts(host: Host): { id: string; state: string; root: string }[] {
  return (authorJournal(host).db.prepare('SELECT id,state,root FROM author_attempts ORDER BY rowid').all() as any[]).map(r => ({ id: String(r.id), state: String(r.state), root: String(r.root) }));
}

export type AuthorMode = { kind: 'recorded'; transport: ModelTransport } | { kind: 'live'; transport: ModelTransport };
export async function authorAndPropose(host: Host, opts: { world: string; request: string; proposalId: string; model: string;
  mode: AuthorMode; rootId: string; journal?: AuthorJournal; signal?: AbortSignal; target?: Target | null }) {
  const journal = opts.journal ?? authorJournal(host);
  const { prompt, parent } = authorPrompt(host, opts.world, opts.request, opts.target ?? null);
  need(Buffer.byteLength(prompt) <= 65536, 'author_budget', `assembled context is ${Buffer.byteLength(prompt)} bytes; the author input budget is 65536`);
  // Recorded mode replays a stored model response through the real CLI and firewall;
  // it is labelled as such everywhere. Live mode additionally requires fresh gate evidence.
  const attempt: any = await authorInDocker({ operationId: opts.proposalId, rootId: opts.rootId, prompt, model: opts.model }, journal,
    opts.mode.kind === 'live' ? 'live' : 'fixture', opts.mode.transport, opts.signal,
    () => host.reserveUnit(opts.rootId, `author ${opts.proposalId}`));
  const receipt = { attempt: attempt?.id, state: attempt?.state, mode: opts.mode.kind, inputHash: hash(prompt), candidate: attempt?.candidate_hash ?? null };
  if (attempt?.state !== 'proposed') return { receipt, proposal: null, reasons: [`author attempt ended ${attempt?.state}`] };
  const object = journal.db.prepare('SELECT data FROM author_objects WHERE hash=?').get(attempt.candidate_hash);
  const edits = JSON.parse(String(object!.data)).files as FileEdit[];
  const parentFiles = host.pkg(parent)!.files;
  let files: Record<string, string>;
  try { files = applyEdits(parentFiles, edits, parent); }
  catch (e: any) { return { receipt, proposal: null, reasons: [e.message] }; }
  const request = `${opts.request} [authored: ${opts.mode.kind === 'recorded' ? 'recorded response replayed through the Codex CLI, not a live model' : 'live Codex'}; attempt ${attempt.id}]`;
  const proposal = host.propose(opts.proposalId, opts.world, request, files);
  return { receipt, proposal, reasons: proposal.status === 'rejected' ? proposal.reasons : [] };
}

// SSE for a recorded final message, in the shape the pinned CLI consumes.
export function recordedTransport(edits: FileEdit[]): ModelTransport {
  const item = { id: 'msg_recorded', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({ files: edits }), annotations: [] }] };
  return async () => [
    { type: 'response.created', response: { id: 'resp_recorded', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_recorded', status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
// Edits that turn one package directory into another (for recording successor responses).
export function diffEdits(from: Record<string, string>, to: Record<string, string>): FileEdit[] {
  return Object.keys(to).sort().filter(p => from[p] !== to[p]).map(path => ({ path, content: to[path] }));
}

// Everything live authoring needs, stated as the specific missing conditions.
export function liveAuthoringProblems(host: Host, root: string | null): string[] {
  const problems: string[] = [];
  if (!host.authorModel()) problems.push('no model chosen for live authoring (Authoring settings)');
  const a = root ? host.allowance(root) : undefined;
  if (!root || !a) problems.push('no call allowance granted for this change request (Authoring settings)');
  else if (a.used >= a.total) problems.push(`allowance ${root} is used up (${a.used}/${a.total})`);
  problems.push(...liveGateProblems());
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
    if (typeof auth?.tokens?.access_token !== 'string') problems.push('Codex is not signed in (run codex login)');
  } catch { problems.push('Codex is not signed in (run codex login)'); }
  try { execFileSync('docker', ['image', 'inspect', runtimeLock().imageId], { stdio: 'ignore', timeout: 10000 }); }
  catch { problems.push('the pinned author image is not available in Docker (npm run author:docker:build)'); }
  return problems;
}
