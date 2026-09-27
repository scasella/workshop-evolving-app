import { readFileSync, writeFileSync } from 'node:fs';
import { runDocker } from '../src/docker-author.ts';
import { hash } from '../src/authoring.ts';
const { model, prompt } = JSON.parse(readFileSync('requests/docker-author-smoke.json', 'utf8'));
const redact = (x: any): any => Array.isArray(x) ? x.map(redact) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).map(([k, v]) => ['client_metadata', 'prompt_cache_key'].includes(k) ? [k, '<redacted>']
    : k === 'text' && typeof v === 'string' && v.length > 200 ? [k, { redacted: 'third-party CLI instruction text', length: v.length, sha256: hash(v) }] : [k, redact(v)]))
  : x;
let staged = false;
const result = await runDocker({ mode: 'author', model, prompt }, async body => {
  writeFileSync('evidence/live-request-preview.json', JSON.stringify({
    mode: 'staged-only-not-sent', destination: 'https://chatgpt.com/backend-api/codex/responses',
    allowance: 1, model, promptHash: hash(prompt),
    credentialHandling: 'Existing Codex login used only in HTTPS headers on the host; credentials excluded from this file and from the container.',
    // Instruction text supplied by the CLI is third-party content: keep only its length and hash.
    body: redact({ ...body, instructions: body.instructions ?? '', store: false, stream: true })
  }, null, 2));
  staged = true;
  throw new Error('REVIEW_ONLY: live request staged locally; no network call');
});
if (!staged) throw new Error('request staging failed');
console.log(JSON.stringify({ staged, modelCalls: 0, file: 'evidence/live-request-preview.json', result: result.transportError ?? result.firewallRejection }));
