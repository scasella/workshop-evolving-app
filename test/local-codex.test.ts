import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalMessage } from '../src/host/local-codex.ts';

// The real event stream the pinned Codex CLI emitted in the Docker gate (deprecation "error" items included).
const real = JSON.parse(readFileSync(new URL('../evidence/docker-gate.json', import.meta.url), 'utf8')).positive.result.stdout as string;
const call = (stdout: string, code = 0) => ({ stdout, stderr: '', code, classification: 'exited' });

test('finalMessage parses the real CLI event stream and rejects failures and tool activity', () => {
  const m = finalMessage(call(real));
  assert.equal(JSON.parse(m.text).files[0].path, 'actions/create-note.json');
  assert.ok(m.usage && typeof m.usage === 'object');
  const lines = real.trim().split('\n');
  const withTool = [...lines.slice(0, -1), JSON.stringify({ type: 'item.completed', item: { id: 'x', type: 'command_execution', command: 'ls' } }), lines.at(-1)].join('\n');
  assert.throws(() => finalMessage(call(withTool)), /tool activity .* forbidden \(command_execution\)/);
  assert.throws(() => finalMessage(call(real + JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }))), /Codex reported failure: \{"message":"quota"\}/);
  assert.throws(() => finalMessage(call(real, 1)), /Codex exited 1/);
  assert.throws(() => finalMessage(call(lines.filter(l => !l.includes('turn.completed')).join('\n'))), /missing completed turn/);
  assert.throws(() => finalMessage({ ...call(''), classification: 'timeout' }), /Codex CLI timeout/);
});
