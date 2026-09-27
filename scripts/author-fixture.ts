import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { author, AuthorJournal } from '../src/authoring.ts';
import { interpret } from '../src/spike.ts';

// Handwritten transport fixture. This is never labeled model-authored.
const files = [{ path: 'actions/add-note.json', content: JSON.stringify({ op: 'create', fields: { title: { input: 'title' } } }) }];
let requests = 0;
let offeredTools: unknown[] = [];
let credentialHeaderPresent = false;
let outputSchemaPresent = false;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests++; offeredTools = body.tools ?? [];
  credentialHeaderPresent ||= Boolean(req.headers.authorization);
  outputSchemaPresent = Boolean(body.text?.format?.schema);
  const message = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify({ files }), annotations: [] }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [message], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing address');
const directory = resolve('.workshop/author-fixture');
mkdirSync(directory, { recursive: true });
const journal = new AuthorJournal(resolve(directory, 'journal.sqlite'));
const operation = `fixture-${Date.now()}`;
try {
  journal.createRoot(operation, 1);
  const request = { operationId: operation, rootId: operation, model: 'gpt-6-astra',
    prompt: 'Return a proposed actions/add-note.json action that projects the title input. Return JSON matching the output schema.' };
  const options = { executable: process.argv[2] ?? '/opt/homebrew/bin/codex', mode: 'fixture' as const,
    fixtureEndpoint: `http://127.0.0.1:${address.port}/v1` };
  const result = await author(request, journal, options);
  if (result?.state !== 'proposed') throw new Error(JSON.stringify(result));
  await author(request, journal, options); // Replay must not invoke the CLI again.
  const object = journal.db.prepare('SELECT data FROM author_objects WHERE hash=?').get(result.candidate_hash!);
  const source = JSON.parse(String(object?.data));
  const interpreted = interpret(JSON.parse(source.files[0].content), { title: 'Fixture-derived local edit' });
  if (requests !== 1 || offeredTools.length || credentialHeaderPresent || !outputSchemaPresent) throw new Error('fixture boundary check failed');
  const receipt = { observedAt: new Date().toISOString(), mode: 'recorded-fixture-not-model-authored',
    requests, offeredTools, credentialHeaderPresent, outputSchemaPresent, candidateHash: result.candidate_hash,
    interpreted, receipt: JSON.parse(String(result.receipt)), modelCalls: 0 };
  writeFileSync(resolve('evidence/author-fixture.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ state: result.state, requests, offeredTools, interpreted, mode: receipt.mode }, null, 2));
} finally {
  journal.close();
  await new Promise<void>(done => server.close(() => done()));
}
