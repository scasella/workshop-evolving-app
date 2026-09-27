// No SSE bytes are released to Codex before the complete bounded response passes.
const eventTypes = new Set([
  'response.created', 'response.in_progress', 'response.completed',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done'
]);
const dataTypes = new Set(['message', 'reasoning', 'output_text', 'summary_text', 'reasoning_text',
  // Responses may echo the requested JSON-schema format in response metadata.
  'json_schema', 'text', 'object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
export function filterResponse(source: string): string {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error('model response exceeds budget');
  let completed = 0;
  const safe: string[] = [];
  for (const block of source.replaceAll('\r\n', '\n').split('\n\n')) {
    if (!block.trim()) continue;
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') continue;
    if (!data) continue;
    const value = JSON.parse(data);
    if (!eventTypes.has(value.type)) throw new Error(`forbidden response event: ${value.type}`);
    const inspect = (node: any, depth: number) => {
      if (depth > 64) throw new Error('response depth exceeded');
      if (node && typeof node === 'object') {
        if ('type' in node && !dataTypes.has(node.type)) throw new Error(`forbidden response item: ${node.type}`);
        for (const child of Object.values(node)) inspect(child, depth + 1);
      }
    };
    const { type, ...rest } = value;
    inspect(rest, 0);
    if (value.type === 'response.completed') {
      completed++;
      if (value.response?.status !== 'completed') throw new Error('model response not completed');
    }
    safe.push(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  if (completed !== 1) throw new Error('expected one completed model response');
  return safe.join('');
}

export function validateRequest(body: any, model: string) {
  if (!body || body.model !== model ||
      (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) || !Array.isArray(body.input))
    throw new Error('unexpected model request or nonempty tool inventory');
  if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) throw new Error('request budget exceeded');
  for (const item of body.input) {
    if (item.type === 'additional_tools') {
      if (!Array.isArray(item.tools) || item.tools.length !== 0) throw new Error('nonempty additional tool inventory');
    } else if (item.type && !['message', 'reasoning'].includes(item.type)) {
      throw new Error('tool continuation in initial model request');
    }
  }
}

// The inspected Linux CLI can advertise namespace tools despite feature flags.
// This host-owned projection removes their wire declarations and denies selection;
// the independent response filter denies unsolicited calls before CLI dispatch.
export function prepareRequest(body: any, model: string) {
  if (!body || !Array.isArray(body.input) ||
      (body.tools !== undefined && !Array.isArray(body.tools))) throw new Error('invalid CLI request');
  for (const item of body.input) if (item.type === 'additional_tools' && !Array.isArray(item.tools))
    throw new Error('invalid additional_tools declaration');
  const projected = { ...body, tools: [], tool_choice: 'none', parallel_tool_calls: false,
    input: body.input.filter((item: any) => item.type !== 'additional_tools') };
  validateRequest(projected, model);
  return projected;
}
