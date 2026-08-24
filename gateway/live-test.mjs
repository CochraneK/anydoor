import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

if (!process.env.KIMI_API_KEY && !process.env.QWEN_API_KEY) {
  throw new Error('Set KIMI_API_KEY or QWEN_API_KEY in the current process before running this test.');
}

const provider = process.env.KIMI_API_KEY ? 'kimi' : 'qwen';
const { server } = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-provider': provider },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with exactly: gateway-live-ok' }], max_tokens: 30 }),
  });
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  assert.equal(data.object, 'chat.completion');
  console.log(JSON.stringify({ provider, model: data.model, usage: data.usage, reply: data.choices?.[0]?.message?.content }));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
