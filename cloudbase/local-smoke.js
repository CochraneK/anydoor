// Local smoke test: runs the real serverless wrapper with fake API-Gateway events.
// Usage: node cloudbase/local-smoke.js
'use strict';

process.env.MOCK_UPSTREAM = 'true';
process.env.GATEWAY_KEY = 'local-smoke-key';

const assert = require('node:assert');
const serverless = require('./anydoorApi/node_modules/serverless-http');

function apiGwEvent(method, path, { body, headers = {}, token } = {}) {
  const eventHeaders = { host: 'anydoor.local', ...headers };
  if (token) eventHeaders.authorization = `Bearer ${token}`;
  return {
    httpMethod: method,
    path,
    headers: eventHeaders,
    queryStringParameters: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { path },
  };
}

(async () => {
  // Part 1: real index.js entry (no DB routes — those need the cloud runtime).
  const entry = require('./anydoorApi/index.js');
  const admin = { 'x-gateway-key': 'local-smoke-key' };
  const root = await entry.main(apiGwEvent('GET', '/', { headers: admin }), {});
  assert.equal(root.statusCode, 200, 'root status');
  const rootBody = JSON.parse(root.body);
  assert.equal(rootBody.service, 'anydoor-gateway');
  assert.ok(root.headers['access-control-allow-origin'], 'CORS on root');
  console.log('index.js GET / -> 200, service =', rootBody.service);

  const models = await entry.main(apiGwEvent('GET', '/v1/models', { headers: admin }), {});
  assert.equal(models.statusCode, 200, 'models status');
  console.log('index.js GET /v1/models -> 200, providers =', JSON.parse(models.body).data.length);

  const preflight = await entry.main(apiGwEvent('OPTIONS', '/v1/chat/completions', { headers: { origin: 'https://cochranek.github.io' } }), {});
  assert.equal(preflight.statusCode, 204, 'preflight status');
  console.log('index.js OPTIONS -> 204');

  const unauthorized = await entry.main(apiGwEvent('GET', '/v1/models'), {});
  assert.equal(unauthorized.statusCode, 401, 'models without credential must be 401');
  console.log('index.js GET /v1/models (no auth) -> 401');

  // Part 2: full auth + chat flow through serverless-http with the file store.
  const gateway = await import('./anydoorApi/gateway/server.mjs');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anydoor-smoke-')), 'users.json');
  const fileStore = new gateway.AuthStore({ storePath });
  const { handler } = gateway.createServer({ authStore: fileStore });
  const wrapped = serverless(async (req, res) => handler(req, res));

  const reg = await wrapped(apiGwEvent('POST', '/auth/register', { body: { email: 'smoke@example.com', password: 'hunter22x', name: 'Smoke' } }), {});
  assert.equal(reg.statusCode, 201, 'register status: ' + reg.body);
  const regBody = JSON.parse(reg.body);
  assert.match(regBody.token, /^gw_[A-Za-z0-9_-]{43}$/);
  console.log('register -> 201, token shape OK');

  const chat = await wrapped(apiGwEvent('POST', '/v1/chat/completions', {
    token: regBody.token,
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'hello anydoor' }] },
  }), {});
  assert.equal(chat.statusCode, 200, 'chat status: ' + chat.body);
  const chatBody = JSON.parse(chat.body);
  assert.ok(chatBody.choices && chatBody.choices[0].message.content, 'mock reply present');
  console.log('chat with token -> 200, reply =', JSON.stringify(chatBody.choices[0].message.content));

  const denied = await wrapped(apiGwEvent('POST', '/v1/chat/completions', { body: { messages: [] } }), {});
  assert.equal(denied.statusCode, 401, 'no-token must be 401');
  console.log('chat without token -> 401');

  console.log('LOCAL SMOKE: PASS');
})().catch((error) => {
  console.error('LOCAL SMOKE: FAIL');
  console.error(error);
  process.exit(1);
});
