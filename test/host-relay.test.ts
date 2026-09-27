import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedRelay } from '../src/host-model-relay.ts';

test('host relay confines fixture credentials to fixed HTTPS headers and permits one request only', async () => {
  const seen: any[] = [];
  const relay = authenticatedRelay('chosen', { access_token: 'FAKE_TEST_TOKEN', account_id: 'FAKE_ACCOUNT' },
    (async (url, options) => {
      seen.push({ url, options });
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch);
  const body = { model: 'chosen', tools: [], input: [{ type: 'message', content: 'safe context' }] };
  assert.equal(await relay(body, new AbortController().signal), 'data: [DONE]\n\n');
  assert.equal(seen[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.headers.Authorization, 'Bearer FAKE_TEST_TOKEN');
  assert.equal(seen[0].options.headers['ChatGPT-Account-ID'], 'FAKE_ACCOUNT');
  assert.ok(!seen[0].options.body.includes('FAKE_'));
  await assert.rejects(relay(body, new AbortController().signal), /allowance/);
  assert.equal(seen.length, 1);
});
test('non-SSE response records its media type and uncertain usage without retrying', async () => {
  let requests = 0;
  const relay = authenticatedRelay('chosen', { access_token: 'FAKE', account_id: 'FAKE' },
    (async () => { requests++; return new Response('{}', { headers: { 'content-type': 'application/json' } }); }) as typeof fetch);
  const body = { model: 'chosen', tools: [], input: [] };
  await assert.rejects(relay(body, new AbortController().signal), /application\/json.*body prefix "\{\}".*unknown/);
  await assert.rejects(relay(body, new AbortController().signal), /allowance/);
  assert.equal(requests, 1);
});
