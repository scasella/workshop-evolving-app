import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterResponse, validateRequest, prepareRequest } from '../src/response-firewall.ts';
const stream = (output: unknown[]) => `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`;
test('response firewall buffers and rejects all tool item families, including nested and late calls', () => {
  const good = stream([{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }]);
  assert.match(filterResponse(good), /hello/);
  for (const type of ['function_call','custom_tool_call','web_search_call','computer_call','mcp_call','code_interpreter_call']) {
    assert.throws(() => filterResponse(stream([{ type }])), /forbidden/);
    assert.throws(() => filterResponse(good + `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type } })}\n\n`), /forbidden/);
  }
  assert.throws(() => filterResponse('data: {broken}\n\n'));
  assert.throws(() => filterResponse('data: [DONE]\n\n'), /completed/);
  assert.throws(() => filterResponse('x'.repeat(4 * 1024 * 1024 + 1)), /budget/);
});
test('host projection removes root and embedded tool declarations without losing the prompt', () => {
  const message = { type: 'message', role: 'user', content: 'A project request' };
  const raw = { model: 'chosen', tools: [{ type: 'function', name: 'shell' }], tool_choice: 'auto',
    input: [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions' }] }, message] };
  const projected = prepareRequest(raw, 'chosen');
  assert.deepEqual(projected.tools, []); assert.equal(projected.tool_choice, 'none');
  assert.deepEqual(projected.input, [message]); assert.equal(raw.tools.length, 1);
  assert.throws(() => prepareRequest({ ...raw, input: [{ type: 'function_call_output' }] }, 'chosen'));
});
test('request relay denies model substitution, tools and continuation dispatch', () => {
  validateRequest({ model: 'chosen', tools: [], input: [{ type: 'message' }] }, 'chosen');
  validateRequest({ model: 'chosen', input: [{ type: 'message' }] }, 'chosen');
  validateRequest({ model: 'chosen', input: [{ type: 'additional_tools', tools: [] }] }, 'chosen');
  assert.throws(() => validateRequest({ model: 'chosen', input: [{ type: 'additional_tools', tools: [{ type: 'function', name: 'shell' }] }] }, 'chosen'));
  assert.throws(() => validateRequest({ model: 'chosen', tools: null, input: [] }, 'chosen'));
  assert.throws(() => validateRequest({ model: 'other', tools: [], input: [] }, 'chosen'));
  assert.throws(() => validateRequest({ model: 'chosen', tools: [{ type: 'web_search' }], input: [] }, 'chosen'));
  assert.throws(() => validateRequest({ model: 'chosen', tools: [], input: [{ type: 'function_call_output' }] }, 'chosen'));
});
