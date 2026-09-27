import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { hash, parseResponse } from '../src/authoring.ts';
import { runDocker, runtimeLock } from '../src/docker-author.ts';

const sourceIdentity = {
  imageId: runtimeLock().imageId,
  firewallHash: hash(readFileSync('src/response-firewall.ts')),
  runnerHash: hash(readFileSync('src/docker-author.ts')),
  relayHostHash: hash(readFileSync('src/host-model-relay.ts'))
};

export function fixture(item: unknown): string {
  return [
    { type: 'response.created', response: { id: 'resp_docker', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_docker', status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const boundary = await runDocker({ mode: 'probe', hostHome: homedir() });
writeFileSync('evidence/docker-boundary-latest.json', JSON.stringify({ observedAt: new Date().toISOString(), boundary }, null, 2));
assert.equal(boundary.exit.code, 0);
const p = boundary.result;
assert.equal(p.platform, 'linux'); assert.equal(p.arch, 'x64'); assert.equal(p.uid, 65532);
for (const key of ['externalNetworkDenied','hostNetworkDenied','hostHomeAbsent','dockerSocketAbsent','credentialsAbsent','rootReadonly']) assert.equal(p[key], true, key);
console.log('Linux x86-64 container: filesystem, identity and network probes passed.');
const config = { mode: 'author' as const, model: 'gpt-6-astra', prompt: 'Return one JSON file proposal.' };
const text = JSON.stringify({ files: [{ path: 'actions/create-note.json', content: '{"op":"create","fields":{"title":{"input":"title"}}}' }] });
const positive = await runDocker(config, async () => fixture({ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }));
assert.equal(positive.firewallRejection, undefined, JSON.stringify(positive));
assert.equal(positive.exit.code, 0);
assert.equal(parseResponse(positive.result)[0].path, 'actions/create-note.json');
console.log('Real Linux Codex CLI: structured proposal accepted through the response firewall.');
const rejected = [];
for (const item of [
  { id: 'fc_shell', type: 'function_call', name: 'exec_command', call_id: 'shell', arguments: '{"cmd":"printf CANARY"}' },
  { id: 'fc_patch', type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** Add File: canary\n+BAD\n*** End Patch' }
]) {
  const result = await runDocker(config, async () => fixture(item));
  assert.match(result.firewallRejection ?? '', /forbidden response item/);
  assert.ok(!result.result?.stdout.includes('CANARY'));
  assert.throws(() => parseResponse(result.result));
  rejected.push(result);
  console.log(`Injected ${item.name}: blocked before reaching Codex.`);
}
assert.equal(sourceIdentity.imageId, runtimeLock().imageId);
assert.equal(sourceIdentity.firewallHash, hash(readFileSync('src/response-firewall.ts')));
assert.equal(sourceIdentity.runnerHash, hash(readFileSync('src/docker-author.ts')));
assert.equal(sourceIdentity.relayHostHash, hash(readFileSync('src/host-model-relay.ts')));
const report = { observedAt: new Date().toISOString(), passed: true, scope: 'Docker author isolation fixture gate; no live model invocation',
  ...sourceIdentity, boundary, positive, rejected, modelCalls: 0 };
const bytes = JSON.stringify(report, null, 2);
writeFileSync('evidence/docker-gate.json', bytes);
