import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorJournal, author, executeBounded, parseResponse, validateEdits } from '../src/authoring.ts';

const files = [{ path: 'actions/add-note.json', content: '{"op":"create","fields":{"title":{"input":"title"}}}' }];
const request = { operationId: 'author-1', rootId: 'root', prompt: 'Add a note action.', model: 'gpt-6-astra' };
test('edit import rejects traversal, control files, duplicate names, hooks, malformed and excessive JSON', () => {
  assert.deepEqual(validateEdits(JSON.stringify({ files })), files);
  for (const path of ['../host.ts','actions/../../host.ts','/tmp/host.ts','actions/link/file.json','actions\\bad.json','.codex/config.toml','AGENTS.md','approved.json'])
    assert.throws(() => validateEdits(JSON.stringify({ files: [{ ...files[0], path }] })), /forbidden/);
  assert.throws(() => validateEdits(JSON.stringify({ files: [files[0], files[0]] })), /duplicate/);
  assert.throws(() => validateEdits(JSON.stringify({ files, approved: true })), /unexpected/);
  assert.throws(() => validateEdits(JSON.stringify({ files: [{ path: 'package.json', content: '{"scripts":{"postinstall":"bad"}}' }] })), /hook/);
  assert.throws(() => validateEdits(JSON.stringify({ files: [{ ...files[0], content: '['.repeat(34) + '0' + ']'.repeat(34) }] })), /nesting/);
  assert.throws(() => validateEdits('x'.repeat(256 * 1024 + 1)), /budget/);
  assert.throws(() => validateEdits('{broken'));
});
test('one shared root allowance persists consumption, deduplication and uncertain outcomes', () => {
  const journal = new AuthorJournal(':memory:');
  try {
    journal.createRoot('root', 1);
    assert.equal(journal.reserve(request), true);
    assert.equal(journal.reserve(request), false);
    assert.throws(() => journal.reserve({ ...request, prompt: 'changed' }), /mismatch/);
    journal.reconcileAfterStoppedController();
    assert.equal(journal.inspect(request.operationId)?.state, 'uncertain');
    assert.throws(() => journal.reserve({ ...request, operationId: 'descendant' }), /allowance/);
    assert.throws(() => journal.createRoot('root', 10), /UNIQUE/);
    assert.throws(() => journal.finish(request.operationId, {}, files), /no longer authorized/);
  } finally { journal.close(); }
});
test('cancellation revokes acceptance; proposed source objects do not convey approval', () => {
  const journal = new AuthorJournal(':memory:');
  try {
    journal.createRoot('root', 2); journal.reserve(request); journal.cancel(request.operationId);
    assert.throws(() => journal.finish(request.operationId, {}, files), /no longer authorized/);
    const next = { ...request, operationId: 'second' };
    journal.reserve(next); journal.finish(next.operationId, { fixture: true }, files);
    assert.equal(journal.inspect(next.operationId)?.state, 'proposed');
    assert.equal(journal.db.prepare('SELECT count(*) n FROM author_objects').get()?.n, 1);
  } finally { journal.close(); }
});
test('reopening retains proposed artifacts and interrupted reservations without redispatch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workshop-author-test-'));
  const path = join(directory, 'journal.sqlite');
  let journal = new AuthorJournal(path);
  try {
    journal.createRoot('root', 2);
    journal.reserve(request); journal.finish(request.operationId, { fixture: true }, files);
    const interrupted = { ...request, operationId: 'interrupted' };
    journal.reserve(interrupted);
    journal.close(); journal = new AuthorJournal(path);
    journal.reconcileAfterStoppedController();
    assert.equal(journal.reserve(request), false);
    assert.equal(journal.inspect(request.operationId)?.state, 'proposed');
    assert.equal(journal.db.prepare('SELECT count(*) n FROM author_objects').get()?.n, 1);
    assert.equal(journal.reserve(interrupted), false);
    assert.equal(journal.inspect(interrupted.operationId)?.state, 'uncertain');
    assert.throws(() => journal.reserve({ ...request, operationId: 'new-attempt' }), /allowance/);
  } finally { journal.close(); rmSync(directory, { recursive: true }); }
});
test('CLI parser separates successful process from valid proposed source', () => {
  const result = { code: 0, signal: null, stderr: '', classification: 'exited' as const,
    stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ files }) } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) };
  assert.deepEqual(parseResponse(result), files);
  assert.throws(() => parseResponse({ ...result, code: 1 }), /exit 1/);
  assert.throws(() => parseResponse({ ...result, stdout: result.stdout.split('\n')[0] }), /missing/);
  assert.throws(() => parseResponse({ ...result, stdout: result.stdout + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }) }), /forbidden/);
});
test('bounded process transport stops timeout and oversized output and reports failed spawn', async () => {
  const env = { PATH: '/usr/bin:/bin' };
  const timeout = await executeBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], env, '', undefined, 100);
  assert.equal(timeout.classification, 'timeout');
  const excessive = await executeBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], env, '', undefined, 1000, 100);
  assert.equal(excessive.classification, 'output_limit');
  const absent = await executeBounded('/nonexistent/workshop-cli', [], env, '');
  assert.equal(absent.classification, 'spawn_error');
});
test('live dispatch cannot be unlocked by supplied options or source output', async () => {
  const journal = new AuthorJournal(':memory:');
  try {
    journal.createRoot('root', 1);
    await assert.rejects(author(request, journal, { executable: '/nonexistent', mode: 'live' }), /ISOLATION_UNESTABLISHED/);
    assert.equal(journal.inspect(request.operationId), undefined);
  } finally { journal.close(); }
});
