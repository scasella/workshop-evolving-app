import { createHash } from 'node:crypto';

// Canonical serialization for every hashed identity. Keys sort by code unit,
// numbers must be safe integers (the package language is integer/fixed-point),
// and anything else (undefined, functions, floats, NaN) is rejected rather than coerced.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function fail(code: string, message: string): never { throw new HostError(code, message); }
export function need(ok: unknown, code: string, message: string): asserts ok { if (!ok) fail(code, message); }

export function canonical(value: unknown, depth = 0): string {
  need(depth <= 64, 'canonical_depth', 'value nesting exceeds 64');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    need(Number.isSafeInteger(value), 'canonical_number', 'only safe integers are canonical');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  need(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype ||
    (typeof value === 'object' && Object.getPrototypeOf(value) === null), 'canonical_type', 'unsupported value type');
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [, item] of entries) need(item !== undefined, 'canonical_type', 'undefined is not canonical');
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`;
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function digest(value: unknown): string { return sha256(canonical(value)); }

// Parse JSON with the same restrictions; duplicate keys are rejected because
// JSON.parse would silently keep the last one and change reviewed meaning.
export function parseCanonicalJson(text: string, limitBytes = 256 * 1024): Json {
  need(Buffer.byteLength(text) <= limitBytes, 'json_size', `JSON exceeds ${limitBytes} bytes`);
  const value = JSON.parse(text);
  checkDuplicates(text);
  canonical(value);
  return value as Json;
}

// JSON.parse cannot report duplicates after the fact; scan object keys lexically.
function checkDuplicates(text: string) {
  const stack: Set<string>[] = []; const kinds: string[] = [];
  let i = 0; let expectKey = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; let raw = '';
      while (text[j] !== '"') { if (text[j] === '\\') { raw += text[j] + text[j + 1]; j += 2; } else raw += text[j++]; }
      const token = JSON.parse(`"${raw}"`);
      if (kinds.at(-1) === '{' && expectKey) {
        need(!stack.at(-1)!.has(token), 'json_duplicate_key', `duplicate key ${JSON.stringify(token)}`);
        stack.at(-1)!.add(token); expectKey = false;
      }
      i = j + 1; continue;
    }
    if (c === '{') { kinds.push('{'); stack.push(new Set()); expectKey = true; }
    else if (c === '[') { kinds.push('['); stack.push(new Set()); }
    else if (c === '}' || c === ']') { kinds.pop(); stack.pop(); }
    else if (c === ',' && kinds.at(-1) === '{') expectKey = true;
    i++;
  }
}
