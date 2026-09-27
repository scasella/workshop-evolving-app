import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spike, interpret } from '../src/spike.ts';
const action = { op: 'create', fields: { title: { input: 'title' } } };
const command = { operationId: 'op-1', worldId: 'live', expectedRevision: 0, recordId: 'r1', input: { title: 'A' } };
test('bounded interpreter rejects raw code, unknown fields and oversized data', () => {
  assert.equal(interpret(action, { title: 'A' }), '{"title":"A"}');
  assert.throws(() => interpret({ op: 'eval', fields: {} }, {}), /unsupported/);
  assert.throws(() => interpret({ ...action, shell: 'echo bad' }, {}), /unexpected/);
  assert.throws(() => interpret(action, { title: 'x'.repeat(4097) }), /oversized/);
});
test('commit, idempotency, stale rejection, copied isolation, rollback and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workshop-'));
  const path = join(dir, 'state.sqlite');
  let host = new Spike(path);
  try {
    host.createWorld('live');
    assert.equal(host.apply(action, command), 1);
    assert.equal(host.apply(action, command), 1);
    assert.throws(() => host.apply(action, { ...command, input: { title: 'B' } }), /payload mismatch/);
    assert.throws(() => host.apply(action, { ...command, operationId: 'stale' }), /stale/);
    assert.throws(() => host.fork('live', 'bad-copy', 0), /stale/);
    host.fork('live', 'practice', 1);
    host.apply(action, { ...command, operationId: 'practice-edit', worldId: 'practice', expectedRevision: 1, recordId: 'r2' });
    assert.equal(host.inspect('live').records.length, 1);
    assert.equal(host.inspect('practice').records.length, 2);
    assert.throws(() => host.apply(action, { ...command, operationId: 'duplicate-record', expectedRevision: 1 }), /UNIQUE/);
    assert.equal(host.revision('live'), 1);
    assert.equal(host.db.prepare('SELECT id FROM commands WHERE id=?').get('duplicate-record'), undefined);
    host.close(); host = new Spike(path);
    assert.equal(host.apply(action, command), 1);
    assert.equal(host.inspect('practice').records.length, 2);
  } finally { host.close(); rmSync(dir, { recursive: true }); }
});
