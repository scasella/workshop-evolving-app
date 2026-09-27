import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateRequest } from './response-firewall.ts';
import type { ModelTransport } from './docker-author.ts';

// Endpoint and headers verified against the official rust-v0.155.1 provider code.
// This only forwards the request produced by codex exec; it is not an alternate
// author, SDK fallback, or a general-purpose proxy. No refresh/retry is automatic.
const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
export function hostModelRelay(model: string): ModelTransport {
  let credentials: { access_token: string; account_id: string };
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
    if (typeof auth.tokens?.access_token !== 'string' || typeof auth.tokens?.account_id !== 'string') throw new Error();
    credentials = { access_token: auth.tokens.access_token, account_id: auth.tokens.account_id };
  } catch { throw new Error('Host Codex authentication unavailable; use codex login.'); }
  return authenticatedRelay(model, credentials);
}

// send is a host-owned dependency seam for credential-free transport tests.
export function authenticatedRelay(model: string, credentials: { access_token: string; account_id: string },
  send: typeof fetch = fetch): ModelTransport {
  let used = false;
  return async (body, signal) => {
    if (used) throw new Error('single-invocation relay allowance exhausted');
    used = true;
    validateRequest(body, model);
    const response = await send(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${credentials.access_token}`, 'ChatGPT-Account-ID': credentials.account_id,
        'Content-Type': 'application/json', Accept: 'text/event-stream', 'originator': 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.155.1', 'OAI-Product-Sku': 'codex' },
      body: JSON.stringify({ ...body, instructions: body.instructions ?? '', store: false, stream: true })
    });
    // Credentials stay in this host closure and HTTPS headers. Never serialize
    // headers or this closure into an invocation receipt or container input.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`model service HTTP ${response.status}; no automatic retry`);
    }
    const mediaType = response.headers.get('content-type');
    if (!mediaType?.includes('text/event-stream') || !response.body) {
      // Retain a bounded prefix for diagnosis; the service response never contains relay credentials.
      const prefix = await boundedPrefix(response.body, 512);
      throw new Error(`model service did not return an SSE stream (HTTP ${response.status}, content-type ${JSON.stringify(mediaType)?.slice(0, 160)}, body prefix ${JSON.stringify(prefix)}); generation/usage unknown`);
    }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('model response byte budget exhausted'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  };
}

async function boundedPrefix(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}
