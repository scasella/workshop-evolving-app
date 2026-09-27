import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AuthorJournal, hash, parseResponse, responseSchema } from './authoring.ts';
import type { AuthorRequest } from './authoring.ts';
import { filterResponse, prepareRequest } from './response-firewall.ts';

const lockPath = new URL('../docker/runtime-lock.json', import.meta.url);
export function runtimeLock() { return JSON.parse(readFileSync(lockPath, 'utf8')); }
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }).trim();
export type ModelTransport = (body: any, signal: AbortSignal) => Promise<string>;

export async function runDocker(config: { mode: 'probe' | 'author'; model?: string; prompt?: string; hostHome?: string },
  transport?: ModelTransport, signal?: AbortSignal) {
  const lock = runtimeLock();
  if (hash(readFileSync(new URL('../docker/relay.mjs', import.meta.url))) !== lock.relayHash ||
      hash(readFileSync(new URL('./codex-profile.json', import.meta.url))) !== lock.profileHash)
    throw new Error('runtime source changed: rebuild and repeat isolation probes');
  const name = `workshop-author-${crypto.randomUUID()}`;
  const id = docker(['create', '--name', name, '--platform', 'linux/amd64', '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65532:65532',
    '--memory', '1g', '--cpus', '1', '--pids-limit', '64', '--ulimit', 'nofile=256:256',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777', '--log-driver', 'none', '--init', '-i', lock.imageId]);
  const controller = new AbortController();
  let reason: string | undefined;
  const stop = (why: string) => {
    if (reason) return;
    reason = why; controller.abort();
    try { docker(['kill', id]); } catch { /* Container may already have exited. */ }
  };
  const cancel = () => stop('cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const inspection = JSON.parse(docker(['inspect', id]))[0];
    const h = inspection.HostConfig;
    if (inspection.Image !== lock.imageId || h.NetworkMode !== 'none' || !h.ReadonlyRootfs ||
        inspection.Config.User !== '65532:65532' || h.Privileged || h.Binds?.length ||
        h.CapDrop?.join(',') !== 'ALL' || !h.SecurityOpt?.includes('no-new-privileges') ||
        h.PidsLimit !== 64 || h.Memory !== 1073741824 || h.LogConfig.Type !== 'none' ||
        inspection.Mounts.some((m: any) => m.Type !== 'tmpfs' || m.Destination !== '/tmp'))
      throw new Error('Docker isolation configuration mismatch');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) throw new Error('cancelled before launch');
    const child = spawn('docker', ['start', '-ai', id], { stdio: ['pipe', 'pipe', 'pipe'] });
    let result: any; let requests = 0; let stderr = ''; let pending = '';
    let protocolBytes = 0;
    let firewallRejection: string | undefined;
    let transportError: string | undefined;
    const requestMetadata: unknown[] = [];
    timer = setTimeout(() => stop('timeout'), 120000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      protocolBytes += chunk.length;
      if (protocolBytes > 8 * 1024 * 1024) { stop('protocol_output_limit'); return; }
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        void receive(line).catch(error => { firewallRejection = String(error); stop('protocol_failure'); });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 65536) stop('stderr_limit'); });
    async function receive(line: string) {
      const message = JSON.parse(line);
      if (message.type === 'request') {
        requests++;
        requestMetadata.push({ model: message.body?.model, tools: message.body?.tools,
          inputIsArray: Array.isArray(message.body?.input), keys: Object.keys(message.body ?? {}),
          inputKinds: message.body?.input?.map((item: any) => ({ type: item.type, role: item.role, tools: item.tools, keys: Object.keys(item) })) });
        if (requests !== 1 || message.path !== '/v1/responses' || !transport || !config.model) throw new Error('unexpected dispatch');
        try {
          const projected = prepareRequest(message.body, config.model);
          requestMetadata.push({ forwardedModel: projected.model, forwardedTools: projected.tools,
            toolChoice: projected.tool_choice, inputHash: hash(JSON.stringify(projected.input)) });
          let raw: string;
          try { raw = await transport(projected, controller.signal); }
          catch (error) { transportError = String(error); throw error; }
          const safe = filterResponse(raw);
          if (!reason) child.stdin.write(JSON.stringify({ type: 'response', id: message.id, status: 200, body: safe }) + '\n');
        } catch (error) {
          if (!transportError) firewallRejection = String(error);
          if (!reason) child.stdin.write(JSON.stringify({ type: 'response', id: message.id, status: 502, body: 'host model-response boundary rejected output' }) + '\n');
        }
      } else if (message.type === 'result' || message.type === 'probe') {
        if (result) throw new Error('duplicate container result');
        result = message;
      } else throw new Error('unexpected container message');
    }
    child.stdin.write(JSON.stringify({ type: 'start', ...config, schema: responseSchema }) + '\n');
    const exit = await new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
      child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
    });
    return { result, exit, reason, firewallRejection, transportError, requests, requestMetadata, stderr, runtime: lock,
      isolation: { image: inspection.Image, user: inspection.Config.User, network: h.NetworkMode,
        readonlyRoot: h.ReadonlyRootfs, mounts: inspection.Mounts, capDrop: h.CapDrop,
        securityOpt: h.SecurityOpt, memory: h.Memory, pids: h.PidsLimit, tmpfs: h.Tmpfs } };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel); controller.abort();
    docker(['rm', '-f', id]);
  }
}

// Live authoring requires gate evidence bound to the exact current runner, firewall and relay.
export function liveGateProblems(): string[] {
  let gate: any;
  try { gate = JSON.parse(readFileSync(new URL('../evidence/docker-gate.json', import.meta.url), 'utf8')); }
  catch { return ['no isolation gate receipt (run npm run author:docker:probe)']; }
  const problems: string[] = [];
  if (!gate.passed) problems.push('the last isolation gate did not pass');
  if (gate.imageId !== runtimeLock().imageId) problems.push('the author image changed since the gate ran');
  if (gate.firewallHash !== hash(readFileSync(new URL('./response-firewall.ts', import.meta.url)))) problems.push('the response firewall changed since the gate ran');
  if (gate.relayHostHash !== hash(readFileSync(new URL('./host-model-relay.ts', import.meta.url)))) problems.push('the host relay changed since the gate ran');
  if (gate.runnerHash !== hash(readFileSync(new URL('./docker-author.ts', import.meta.url)))) problems.push('the Docker runner changed since the gate ran');
  return problems;
}

export async function authorInDocker(request: AuthorRequest, journal: AuthorJournal,
  mode: 'fixture' | 'live', transport: ModelTransport, signal?: AbortSignal, reserve?: () => void) {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(request.model) || !request.prompt.length || Buffer.byteLength(request.prompt) > 65536)
    throw new Error('invalid model or input budget');
  if (mode === 'live') {
    const problems = liveGateProblems();
    if (problems.length) throw new Error(`Docker isolation gate needs fresh evidence: ${problems.join('; ')}`);
  }
  if (signal?.aborted) throw new Error('request cancelled');
  if (!journal.reserve(request, reserve)) return journal.inspect(request.operationId);
  const cancel = () => journal.cancel(request.operationId);
  signal?.addEventListener('abort', cancel, { once: true });
  const start = new Date().toISOString();
  let receipt: any;
  try {
    receipt = await runDocker({ mode: 'author', prompt: request.prompt, model: request.model }, transport, signal);
    receipt = { ...receipt, start, end: new Date().toISOString(), mode, inputHash: hash(request.prompt), model: request.model,
      relayHostHash: hash(readFileSync(new URL('./host-model-relay.ts', import.meta.url))),
      firewallHash: hash(readFileSync(new URL('./response-firewall.ts', import.meta.url))) };
    let files;
    if (!receipt.reason && !receipt.firewallRejection && !receipt.transportError && receipt.exit.code === 0) {
      try { files = parseResponse(receipt.result); } catch (error) { receipt.rejection = String(error); }
    }
    if (journal.inspect(request.operationId)?.state === 'running') {
      if (receipt.reason || receipt.transportError) journal.db.prepare("UPDATE author_attempts SET state='uncertain',receipt=? WHERE id=?").run(JSON.stringify(receipt), request.operationId);
      else journal.finish(request.operationId, receipt, files);
    } else journal.db.prepare('UPDATE author_attempts SET receipt=? WHERE id=?').run(JSON.stringify(receipt), request.operationId);
    return journal.inspect(request.operationId);
  } catch (error) {
    if (journal.inspect(request.operationId)?.state === 'running')
      journal.db.prepare("UPDATE author_attempts SET state='uncertain',receipt=? WHERE id=?").run(JSON.stringify({ start, mode, error: String(error) }), request.operationId);
    throw error;
  } finally { signal?.removeEventListener('abort', cancel); }
}
