import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Feasibility subset only. No package admission, owner authority, or model dispatch.
export type Action = { op: 'create'; fields: Record<string, { input: string }> };
type Command = { operationId: string; worldId: string; expectedRevision: number;
  recordId: string; input: Record<string, string> };
function requireThat(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
function id(value: unknown) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value), 'invalid identifier');
}
function exact(value: unknown, keys: string[]) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  requireThat(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'unexpected fields');
}
export function interpret(source: unknown, input: Record<string, string>): string {
  exact(source, ['op', 'fields']);
  const action = source as Action;
  requireThat(action.op === 'create', 'unsupported opcode');
  requireThat(action.fields && typeof action.fields === 'object' && !Array.isArray(action.fields), 'invalid fields');
  const fields = Object.entries(action.fields);
  requireThat(fields.length > 0 && fields.length <= 16, 'field budget exceeded');
  const inputs: string[] = [];
  const output: Record<string, string> = Object.create(null);
  for (const [name, expression] of fields.sort(([a], [b]) => a.localeCompare(b))) {
    id(name); exact(expression, ['input']); id(expression.input);
    inputs.push(expression.input);
    const value = input[expression.input];
    requireThat(typeof value === 'string' && Buffer.byteLength(value) <= 4096, 'invalid or oversized input');
    output[name] = value;
  }
  exact(input, [...new Set(inputs)]);
  return JSON.stringify(output);
}
export class Spike {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS worlds(id TEXT PRIMARY KEY, parent TEXT REFERENCES worlds(id), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records(world TEXT REFERENCES worlds(id), id TEXT, data TEXT NOT NULL, PRIMARY KEY(world,id));
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, digest TEXT NOT NULL, result INTEGER NOT NULL);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createWorld(world: string) {
    id(world);
    this.db.prepare('INSERT INTO worlds VALUES (?,NULL,0)').run(world);
  }
  revision(world: string): number {
    const row = this.db.prepare('SELECT revision FROM worlds WHERE id=?').get(world);
    requireThat(row, 'unknown world');
    return Number(row.revision);
  }
  fork(source: string, target: string, expectedRevision: number) {
    id(source); id(target);
    this.transaction(() => {
      requireThat(this.revision(source) === expectedRevision, 'stale world revision');
      this.db.prepare('INSERT INTO worlds VALUES (?,?,?)').run(target, source, expectedRevision);
      this.db.prepare('INSERT INTO records SELECT ?,id,data FROM records WHERE world=?').run(target, source);
    });
  }
  apply(action: unknown, command: Command): number {
    exact(command, ['operationId','worldId','expectedRevision','recordId','input']);
    id(command.operationId); id(command.worldId); id(command.recordId);
    requireThat(Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0, 'invalid revision');
    const data = interpret(action, command.input);
    // Identity covers the exact action bytes as well as every command field.
    const digest = createHash('sha256').update(JSON.stringify([action, command])).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT digest,result FROM commands WHERE id=?').get(command.operationId);
      if (previous) {
        requireThat(previous.digest === digest, 'operation ID payload mismatch');
        return Number(previous.result);
      }
      const revision = this.revision(command.worldId);
      requireThat(revision === command.expectedRevision, 'stale world revision');
      requireThat(Number.isSafeInteger(revision + 1), 'revision overflow');
      this.db.prepare('INSERT INTO records VALUES (?,?,?)').run(command.worldId, command.recordId, data);
      this.db.prepare('UPDATE worlds SET revision=? WHERE id=?').run(revision + 1, command.worldId);
      this.db.prepare('INSERT INTO commands VALUES (?,?,?)').run(command.operationId, digest, revision + 1);
      return revision + 1;
    });
  }
  inspect(world: string) {
    return { world, revision: this.revision(world), records: this.db.prepare('SELECT id,data FROM records WHERE world=? ORDER BY id').all(world) };
  }
  close() { this.db.close(); }
}
