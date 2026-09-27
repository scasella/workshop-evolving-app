import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spike } from './spike.ts';
const directory = resolve(process.argv[2] ?? '.workshop');
mkdirSync(directory, { recursive: true });
const path = resolve(directory, 'spike.sqlite');
const host = new Spike(path);
try {
  if (!host.db.prepare('SELECT id FROM worlds WHERE id=?').get('project')) {
    host.createWorld('project');
    host.apply({ op: 'create', fields: { title: { input: 'title' } } }, {
      operationId: 'initial-note', worldId: 'project', expectedRevision: 0,
      recordId: 'note-1', input: { title: 'Compare alternatives; independent review still needed.' }
    });
    host.fork('project', 'practice', 1);
  }
  console.log(JSON.stringify({ status: 'feasibility subset; live authoring disabled', database: path,
    project: host.inspect('project'), practice: host.inspect('practice') }, null, 2));
} finally { host.close(); }
