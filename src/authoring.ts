import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import profile from './codex-profile.json' with { type: 'json' };

export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function object(value: unknown, keys: string[]): asserts value is Record<string, any> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  check(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'unexpected fields');
}
export const responseSchema = {
  type: 'object', additionalProperties: false, required: ['files'], properties: {
    files: { type: 'array', minItems: 1, maxItems: 32, items: {
      type: 'object', additionalProperties: false, required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } }
    } }
  }
};
export type FileEdit = { path: string; content: string };
export function validateEdits(text: string): FileEdit[] {
  check(Buffer.byteLength(text) <= 256 * 1024, 'output exceeds edit budget');
  const result = JSON.parse(text);
  object(result, ['files']);
  check(Array.isArray(result.files) && result.files.length > 0 && result.files.length <= 32, 'invalid file count');
  const names = new Set<string>();
  for (const file of result.files) {
    object(file, ['path', 'content']);
    check(typeof file.path === 'string' && /^(package\.json|(?:schemas|actions|workflows|views|migrations|tests)\/[a-zA-Z0-9_-]{1,80}\.json|planner\.json|prompts\/[a-zA-Z0-9_-]{1,80}\.md)$/.test(file.path), 'forbidden file path');
    check(!names.has(file.path), 'duplicate file path'); names.add(file.path);
    check(typeof file.content === 'string' && Buffer.byteLength(file.content) <= 64 * 1024, 'invalid file content');
    check(!/[\u0000]/.test(file.content), 'NUL byte forbidden');
    if (file.path.endsWith('.json')) {
      const source = JSON.parse(file.content);
      const visit = (value: any, depth: number) => {
        check(depth <= 32, 'JSON nesting budget exceeded');
        if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item, depth + 1);
      };
      visit(source, 0);
      if (file.path === 'package.json') {
        check(source && typeof source === 'object' && !Array.isArray(source), 'invalid package manifest');
        for (const forbidden of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'bin'])
          check(!(forbidden in source), 'dependency installation or executable hook forbidden');
      }
    }
  }
  // These are proposed source bytes, not admitted executable packages. Store as
  // a single host-owned object: never map returned paths onto the filesystem.
  return result.files.sort((a: FileEdit, b: FileEdit) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export type AuthorRequest = { operationId: string; rootId: string; prompt: string; model: string };
type TransportResult = { code: number | null; signal: string | null; stdout: string; stderr: string;
  classification: 'exited' | 'timeout' | 'output_limit' | 'cancelled' | 'spawn_error' | 'invalid_utf8' };

export class AuthorJournal {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS author_roots(id TEXT PRIMARY KEY, allowance INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS author_attempts(id TEXT PRIMARY KEY, root TEXT REFERENCES author_roots(id), input_hash TEXT NOT NULL,
        state TEXT NOT NULL, receipt TEXT, candidate_hash TEXT);
      CREATE TABLE IF NOT EXISTS author_objects(hash TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  tx<T>(fn: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Protected host/owner operation; never a generated action.
  createRoot(id: string, allowance: number) {
    check(/^[a-zA-Z0-9_-]{1,80}$/.test(id), 'invalid root ID');
    check(Number.isSafeInteger(allowance) && allowance > 0 && allowance <= 100, 'invalid allowance');
    this.db.prepare('INSERT INTO author_roots(id,allowance) VALUES (?,?)').run(id, allowance);
  }
  // `external` lets the host's single root-allowance ledger charge the unit instead of author_roots.
  // It runs inside this transaction: if it throws, no attempt is recorded.
  reserve(request: AuthorRequest, external?: () => void) {
    check(/^[a-zA-Z0-9_-]{1,80}$/.test(request.operationId), 'invalid operation ID');
    return this.tx(() => {
      const digest = hash(JSON.stringify(request));
      const old = this.db.prepare('SELECT * FROM author_attempts WHERE id=?').get(request.operationId);
      if (old) { check(old.input_hash === digest, 'operation ID payload mismatch'); return false; }
      const active = this.db.prepare("SELECT count(*) n FROM author_attempts WHERE state='running'").get()!;
      check(Number(active.n) < 2, 'concurrency allowance exhausted');
      if (external) {
        external();
        // Mirror row for the foreign key only; the host ledger holds the real allowance.
        this.db.prepare('INSERT OR IGNORE INTO author_roots(id,allowance,used) VALUES (?,0,0)').run(request.rootId);
      }
      else {
        const used = this.db.prepare('UPDATE author_roots SET used=used+1 WHERE id=? AND used<allowance').run(request.rootId);
        check(used.changes === 1, 'root dispatch allowance exhausted or missing');
      }
      this.db.prepare("INSERT INTO author_attempts(id,root,input_hash,state) VALUES (?,?,?,'running')")
        .run(request.operationId, request.rootId, digest);
      return true;
    });
  }
  inspect(id: string) { return this.db.prepare('SELECT * FROM author_attempts WHERE id=?').get(id); }
  cancel(id: string) {
    this.db.prepare("UPDATE author_attempts SET state='cancelled' WHERE id=? AND state IN ('running','uncertain')").run(id);
  }
  // Call only after the previous controller/process group is confirmed stopped.
  reconcileAfterStoppedController() {
    this.db.prepare("UPDATE author_attempts SET state='uncertain' WHERE state='running'").run();
  }
  finish(id: string, receipt: unknown, files?: FileEdit[]) {
    return this.tx(() => {
      const current = this.inspect(id);
      check(current?.state === 'running', 'attempt no longer authorized to accept output');
      const bytes = files ? JSON.stringify({ files }) : null;
      const candidateHash = bytes ? hash(bytes) : null;
      if (bytes) this.db.prepare('INSERT OR IGNORE INTO author_objects VALUES (?,?)').run(candidateHash, bytes);
      this.db.prepare('UPDATE author_attempts SET state=?,receipt=?,candidate_hash=? WHERE id=?')
        .run(files ? 'proposed' : 'failed', JSON.stringify(receipt), candidateHash, id);
    });
  }
  close() { this.db.close(); }
}

export function executeBounded(executable: string, args: string[], env: NodeJS.ProcessEnv,
  prompt: string, signal?: AbortSignal, timeoutMs = 60000, outputLimit = 1024 * 1024): Promise<TransportResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', size = 0;
    const out: Buffer[] = [], err: Buffer[] = [];
    let classification: TransportResult['classification'] = 'exited';
    const child = spawn(executable, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = (reason: TransportResult['classification']) => {
      if (classification !== 'exited') return;
      classification = reason;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]] as const) {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > outputLimit) { stop('output_limit'); return; }
        (isError ? err : out).push(chunk);
      });
    }
    child.on('error', error => { classification = 'spawn_error'; stderr = error.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('close', (code, processSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try {
        stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(out));
        if (classification !== 'spawn_error') stderr = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(err));
      } catch { classification = 'invalid_utf8'; }
      resolve({ code, signal: processSignal, stdout, stderr, classification });
    });
  });
}

export function parseResponse(result: TransportResult): FileEdit[] {
  check(result.classification === 'exited' && result.code === 0, `CLI ${result.classification}, exit ${result.code}`);
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  check(events.some(event => event.type === 'turn.completed'), 'missing committed CLI turn');
  check(!events.some(event => ['turn.failed', 'error'].includes(event.type)), 'CLI reported failure');
  const completed = events.filter(event => event.type === 'item.completed');
  check(!completed.some(event => ['command_execution','file_change','mcp_tool_call','web_search'].includes(event.item?.type)), 'executable tool event forbidden');
  const messages = completed.filter(event => event.item?.type === 'agent_message');
  check(messages.length === 1, 'expected one structured final message');
  return validateEdits(messages[0].item.text);
}

export async function author(request: AuthorRequest, journal: AuthorJournal, options: {
  executable: string; mode: 'fixture' | 'live'; fixtureEndpoint?: string; signal?: AbortSignal;
}) {
  // No boolean receipt supplied by a model/JSON file can enable live authority.
  check(options.mode === 'fixture', 'LIVE_AUTHOR_ISOLATION_UNESTABLISHED: credential/egress/process boundary required');
  check(!options.signal?.aborted, 'request already cancelled');
  check(options.fixtureEndpoint, 'fixture endpoint required');
  const endpoint = new URL(options.fixtureEndpoint);
  check(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'fixture must use credential-free loopback');
  check(Buffer.byteLength(request.prompt) <= 64 * 1024 && request.prompt.length > 0, 'input bundle budget exceeded');
  check(/^[a-zA-Z0-9_.-]{1,100}$/.test(request.model), 'explicit model required');
  check(hash(readFileSync(options.executable)) === profile.sha256, 'CLI binary differs from inspected profile');
  if (!journal.reserve(request)) return journal.inspect(request.operationId);
  const root = mkdtempSync(join(tmpdir(), 'workshop-author-'));
  const work = join(root, 'input'); const home = join(root, 'codex');
  mkdirSync(work); mkdirSync(home);
  const schema = join(root, 'output-schema.json');
  writeFileSync(schema, JSON.stringify(responseSchema));
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--json', '--sandbox', 'read-only', '--model', request.model, '--output-schema', schema,
    ...profile.disabledFeatures.flatMap(name => ['--disable', name]),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'check_for_update_on_startup=false', '-c', 'model_provider="workshop_fixture"',
    '-c', 'model_providers.workshop_fixture.name="Credential-free fixture"',
    '-c', `model_providers.workshop_fixture.base_url=${JSON.stringify(endpoint.href)}`,
    '-c', 'model_providers.workshop_fixture.wire_api="responses"',
    '-c', 'model_providers.workshop_fixture.requires_openai_auth=false',
    '-c', 'model_providers.workshop_fixture.request_max_retries=0',
    '-c', 'model_providers.workshop_fixture.stream_max_retries=0', '-C', work, '-'];
  const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME!, CODEX_HOME: home, TMPDIR: root };
  const start = new Date().toISOString();
  const cancel = () => journal.cancel(request.operationId);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const result = await executeBounded(options.executable, args, env, request.prompt, options.signal);
    let files: FileEdit[] | undefined; let rejection: string | undefined;
    try { files = parseResponse(result); } catch (error) { rejection = String(error); }
    const receipt = { mode: 'recorded-fixture-not-model-authored', start, end: new Date().toISOString(),
      executable: options.executable, binaryHash: profile.sha256, cliVersion: profile.version,
      model: request.model, inputHash: hash(request.prompt), configurationHash: hash(JSON.stringify(args)),
      // Receipts keep argv shape but not the per-run temporary paths of this machine.
      args: args.map(a => a.startsWith(root) ? `<tmp>${a.slice(root.length)}` : a), result, rejection };
    if (journal.inspect(request.operationId)?.state === 'running') journal.finish(request.operationId, receipt, files);
    else journal.db.prepare('UPDATE author_attempts SET receipt=? WHERE id=?').run(JSON.stringify(receipt), request.operationId);
    return journal.inspect(request.operationId);
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    rmSync(root, { recursive: true, force: true });
  }
}
