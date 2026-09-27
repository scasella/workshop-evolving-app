import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { AuthorJournal } from '../src/authoring.ts';
import { authorInDocker } from '../src/docker-author.ts';
import { hostModelRelay } from '../src/host-model-relay.ts';
import { interpret } from '../src/spike.ts';

const { model, prompt } = JSON.parse(readFileSync(new URL('../requests/docker-author-smoke.json', import.meta.url), 'utf8'));
mkdirSync('.workshop/docker-live', { recursive: true });
const journal = new AuthorJournal('.workshop/docker-live/journal.sqlite');
const id = `live-${Date.now()}`;
// This explicit owner-invoked CLI creates one allowance. No repair/retry loop.
journal.createRoot(id, 1);
try {
  const result = await authorInDocker({ operationId: id, rootId: id, prompt, model }, journal, 'live', hostModelRelay(model));
  let interpreted: string | undefined;
  let validationError: string | undefined;
  let proposal;
  if (result?.state === 'proposed') {
    const object = journal.db.prepare('SELECT data FROM author_objects WHERE hash=?').get(result.candidate_hash!);
    proposal = JSON.parse(String(object?.data));
    try {
      if (proposal.files.length !== 1 || proposal.files[0].path !== 'actions/capture-observation.json') throw new Error('unexpected proposal files');
      interpreted = interpret(JSON.parse(proposal.files[0].content), { observation: 'Live Codex authoring returned constrained source.', basis: 'measured' });
    } catch (error) { validationError = String(error); }
  }
  const report = { observedAt: new Date().toISOString(), operationId: id, mode: 'live-model-authored', model,
    allowance: 1, prompt, result, proposal, interpreted, validationError };
  writeFileSync(`evidence/${id}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ operationId: id, state: result?.state, interpreted, validationError,
    evidence: `evidence/${id}.json`, rejection: result?.receipt ? (JSON.parse(String(result.receipt)).transportError ?? JSON.parse(String(result.receipt)).firewallRejection) : undefined }, null, 2));
  if (!interpreted) process.exitCode = 1;
} finally { journal.close(); }
