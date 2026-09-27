// Credential-free CLI transport probe. No model service is contacted.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const executable = process.argv[2] ?? '/opt/homebrew/bin/codex';
const root = mkdtempSync(join(tmpdir(), 'workshop-tool-probe-'));
const home = join(root, 'codex');
const work = join(root, 'input');
mkdirSync(home); mkdirSync(work);
// CODEX_HOME is set only for this disposable child invocation, never globally.
const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME!, CODEX_HOME: home, TMPDIR: root };
const listing = spawnSync(executable, ['features', 'list'], { env, encoding: 'utf8' });
if (listing.status !== 0) throw new Error(listing.stderr);
const features = listing.stdout.split('\n').filter(line => line && !/\bremoved\b/.test(line))
  .map(line => line.trim().split(/\s+/)[0]);
const disabled = features.flatMap(name => ['--disable', name]);
const requests: unknown[] = [];
const attacks = [
  { name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf WORKSHOP_TOOL_EXECUTED' }) },
  { name: 'shell', arguments: JSON.stringify({ command: ['printf', 'WORKSHOP_TOOL_EXECUTED'] }) },
  { name: 'apply_patch', input: '*** Begin Patch\n*** Add File: tool-canary\n+executed\n*** End Patch' },
  { name: 'mcp__host__read_secret', arguments: '{}' },
  { name: 'spawn_agent', arguments: JSON.stringify({ message: 'Return a fixture marker.' }) }
];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    // Never save headers, credentials, or assembled system/user instructions.
    requests.push({ path: req.url, model: body.model, tools: body.tools ?? [],
      toolChoice: body.tool_choice, requestKeys: Object.keys(body),
      toolResults: (body.input ?? []).filter((item: any) => /_call_output$/.test(item.type)) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const finalMessage = { id: 'msg_probe', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: '{"probe":"recorded"}', annotations: [] }] };
    const attack = attacks[requests.length - 1];
    const message = attack ? { id: `fc_${requests.length}`, type: 'input' in attack ? 'custom_tool_call' : 'function_call',
      call_id: `call_${requests.length}`, ...attack } : finalMessage;
    const events = [
      { type: 'response.created', response: { id: 'resp_probe', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'resp_probe', status: 'completed', output: [message], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch { res.writeHead(400); res.end(); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing address');
const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
  '--json', '--sandbox', 'read-only', '--model', 'gpt-6-astra', ...disabled,
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'check_for_update_on_startup=false', '-c', 'project_doc_max_bytes=0',
  '-c', 'model_provider="workshop_probe"', '-c', 'model_providers.workshop_probe.name="Local probe"',
  '-c', `model_providers.workshop_probe.base_url="http://127.0.0.1:${address.port}/v1"`,
  '-c', 'model_providers.workshop_probe.wire_api="responses"',
  '-c', 'model_providers.workshop_probe.requires_openai_auth=false',
  '-c', 'model_providers.workshop_probe.request_max_retries=0',
  '-c', 'model_providers.workshop_probe.stream_max_retries=0', '-C', work, '-'];
let output = '';
const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => { if (output.length < 64000) output += chunk; });
child.stderr.on('data', chunk => { if (output.length < 64000) output += chunk; });
child.stdin.end('Credential-free fixture probe. Return the fixture response.');
const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
await new Promise<void>(done => server.close(() => done()));
const report = { observedAt: new Date().toISOString(), mode: 'credential-free local transport fixture',
  executable, executableHash: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  disabledFeatures: features, result, requests, diagnosticOutput: output,
  canaryWritten: existsSync(join(work, 'tool-canary')), modelCalls: 0, isolationEstablished: false };
writeFileSync(resolve('evidence/codex-tool-probe.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result, requests: requests.length,
  tools: requests.map((r: any) => r.tools.map((t: any) => ({ type: t.type, name: t.name }))) }, null, 2));
rmSync(root, { recursive: true });
if (!requests.length) process.exitCode = 1;
