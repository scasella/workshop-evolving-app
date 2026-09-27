import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';

const profile = JSON.parse(readFileSync('/opt/workshop/codex-profile.json'));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let started = false, next = 0;
const pending = new Map();
async function deniedConnection(host) {
  return new Promise(resolve => {
    const socket = connect({ host, port: 443 });
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 1500);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.on('error', () => { clearTimeout(timer); resolve(true); });
  });
}
async function start(config) {
  if (config.mode === 'probe') {
    emit({ type: 'probe', platform: process.platform, arch: process.arch,
      externalNetworkDenied: await deniedConnection('1.1.1.1'),
      hostNetworkDenied: await deniedConnection('host.docker.internal'),
      // The host home path is passed in by the runner, never hard-coded.
      hostHomeAbsent: !existsSync(config.hostHome ?? '/Users') && !existsSync('/Users'),
      dockerSocketAbsent: !existsSync('/var/run/docker.sock'),
      credentialsAbsent: !existsSync('/tmp/codex/auth.json'),
      rootReadonly: (() => { try { writeFileSync('/root-write-canary', 'x'); return false; } catch { return true; } })(),
      uid: process.getuid(), pid: process.pid });
    process.exit(0);
  }
  mkdirSync('/tmp/codex', { recursive: true }); mkdirSync('/tmp/input'); mkdirSync('/tmp/home');
  writeFileSync('/tmp/output-schema.json', JSON.stringify(config.schema));
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses' || next >= 1) { res.writeHead(403); res.end(); return; }
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 2 * 1024 * 1024) { req.destroy(); return; } chunks.push(chunk); }
    const id = ++next;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      pending.set(id, res);
      emit({ type: 'request', id, path: req.url, body });
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--json', '--sandbox', 'read-only', '--model', config.model, '--output-schema', '/tmp/output-schema.json',
    ...profile.disabledFeatures.flatMap(name => ['--disable', name]),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'check_for_update_on_startup=false', '-c', 'model_provider="workshop_relay"',
    '-c', 'model_providers.workshop_relay.name="Host relay"',
    '-c', `model_providers.workshop_relay.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c', 'model_providers.workshop_relay.wire_api="responses"',
    '-c', 'model_providers.workshop_relay.requires_openai_auth=false',
    '-c', 'model_providers.workshop_relay.request_max_retries=0',
    '-c', 'model_providers.workshop_relay.stream_max_retries=0', '-C', '/tmp/input', '-'];
  const child = spawn('/usr/local/bin/codex', args, { env: {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/home', CODEX_HOME: '/tmp/codex', TMPDIR: '/tmp'
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let size = 0, exceeded = false;
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
    size += chunk.length;
    if (size > 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); return; }
    chunks.push(chunk);
  });
  child.stdin.on('error', () => {}); child.stdin.end(config.prompt);
  child.on('error', error => { emit({ type: 'error', message: error.message }); process.exit(1); });
  child.on('close', (code, signal) => {
    emit({ type: 'result', code, signal, classification: exceeded ? 'output_limit' : 'exited',
      stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    server.close(); process.exit(0);
  });
}
createInterface({ input: process.stdin }).on('line', line => {
  if (line.length > 8 * 1024 * 1024) process.exit(1);
  const message = JSON.parse(line);
  if (!started && message.type === 'start') { started = true; start(message).catch(error => { emit({ type: 'error', message: error.message }); process.exit(1); }); }
  else if (message.type === 'response') {
    const response = pending.get(message.id);
    if (!response) process.exit(1);
    pending.delete(message.id);
    response.writeHead(message.status, { 'Content-Type': message.status === 200 ? 'text/event-stream' : 'text/plain' });
    response.end(message.body);
  } else process.exit(1);
});
