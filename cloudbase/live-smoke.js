// Live smoke test against the deployed CloudBase function.
// Usage: node cloudbase/live-smoke.js [baseOverride]
'use strict';

const BASE = process.argv[2] || 'https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi';

(async () => {
  const root = await fetch(BASE + '/', { method: 'GET' });
  console.log('GET / ->', root.status);
  const rootJson = await root.json().catch(() => null);
  console.log('   body:', rootJson ? JSON.stringify(rootJson).slice(0, 200) : '(non-json)');

  const health = await fetch(BASE + '/health', { method: 'GET' });
  console.log('GET /health ->', health.status);

  const models = await fetch(BASE + '/v1/models', { method: 'GET' });
  console.log('GET /v1/models ->', models.status);
  const modelsJson = await models.json().catch(() => null);
  if (modelsJson && modelsJson.data) {
    const configured = modelsJson.data.filter((m) => m.configured);
    console.log('   providers:', modelsJson.data.length, '| configured:', configured.map((m) => m.provider).join(', '));
  } else {
    console.log('   body:', JSON.stringify(modelsJson).slice(0, 300));
  }

  // Register a fresh account (auth store = CloudBase DB)
  const email = `smoke+${Date.now()}@anydoor.dev`;
  const password = 'smoke-password-123';
  const reg = await fetch(BASE + '/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Smoke' }),
  });
  console.log('POST /auth/register ->', reg.status);
  const regJson = await reg.json().catch(() => null);
  if (reg.status !== 201 || !regJson || !regJson.token) {
    console.log('   register failed:', JSON.stringify(regJson));
    process.exit(1);
  }
  const token = regJson.token;
  console.log('   token issued:', token.slice(0, 10) + '...');

  const me = await fetch(BASE + '/auth/me', { headers: { authorization: `Bearer ${token}` } });
  console.log('GET /auth/me ->', me.status);

  // Chat through a configured provider using the free quota
  const chat = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'kimi', messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 16 }),
  });
  console.log('POST /v1/chat/completions ->', chat.status);
  const chatJson = await chat.json().catch(() => null);
  if (chat.status === 200 && chatJson && chatJson.choices) {
    console.log('   reply:', JSON.stringify(chatJson.choices[0].message.content));
  } else {
    console.log('   body:', JSON.stringify(chatJson).slice(0, 300));
  }

  console.log('LIVE SMOKE DONE');
})().catch((error) => {
  console.error('LIVE SMOKE ERROR', error);
  process.exit(1);
});
