import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.MOCK_UPSTREAM = 'true';
process.env.RATE_LIMIT_PER_MINUTE = '20';
const { createServer, AuthStore, parseProviderIni } = await import('./server.mjs');
const parsedProviders = parseProviderIni([
  '[meta]', 'ignored=yes',
  '[provider.acme]', 'vendor=Acme', 'api_key=placeholder', 'base_url=https://api.acme.example/v1', 'models=gpt-a,gpt-b',
  '[provider.kilo]', 'auth=none', 'base_url=https://api.kilo.example/v1',
].join('\n'));
assert.equal(parsedProviders.acme.vendor, 'Acme');
assert.deepEqual(parsedProviders.acme.models, 'gpt-a,gpt-b');
assert.equal(parsedProviders.kilo.auth, 'none');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-gateway-auth-'));
const authStorePath = path.join(tempDir, 'users.json');
const { server } = createServer({ config: {
  host: '127.0.0.1', port: 0, defaultProvider: 'kimi', gatewayKey: 'test-gateway-key',
  allowedOrigins: ['http://allowed.test'],
  trustProxy: false,
  maxBodyBytes: 512 * 1024, maxOutputTokens: 1800, rateLimitPerMinute: 100,
  dailyTokenBudget: 250000, mockUpstream: true,
  auth: { enabled: true, registrationEnabled: true, requireToken: true, storePath: authStorePath, minPasswordLength: 8 },
  providers: {
    kimi: { baseUrl: 'https://api.moonshot.cn/v1', apiKey: '', model: 'moonshot-v1-8k', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-plus', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    freellm: { baseUrl: 'http://127.0.0.1:18080/v1', apiKey: '', model: 'freellm-test', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    kilo: { baseUrl: 'https://api.kilo.example/v1', apiKey: '', auth: 'none', model: 'kilo-test', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
  },
} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
try {
  const consolePage = await fetch(`${base}/console/`);
  assert.equal(consolePage.status, 200);
  assert.match(await consolePage.text(), /ANYDOOR/);
  const browserRoot = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  assert.equal(browserRoot.status, 200);
  assert.match(await browserRoot.text(), /API[_ ]ACCESS/);
  const consoleScript = await fetch(`${base}/console/app.js`);
  assert.equal(consoleScript.status, 200);
  assert.match(consoleScript.headers.get('content-type'), /javascript/);

  const unauthorized = await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), 'null');
  const blockedOrigin = await fetch(`${base}/health`, { headers: { origin: 'https://evil.test', authorization: 'Bearer test-gateway-key' } });
  assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), 'null');
  const allowedOrigin = await fetch(`${base}/health`, { headers: { origin: 'http://allowed.test', authorization: 'Bearer test-gateway-key' } });
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://allowed.test');

  const invalidRegistration = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
  });
  assert.equal(invalidRegistration.status, 400);
  assert.equal((await invalidRegistration.json()).error.code, 'invalid_email');

  const registration = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Alice@Example.com', name: 'Alice', password: 'correct horse battery staple' }),
  });
  assert.equal(registration.status, 201);
  const registrationData = await registration.json();
  assert.match(registrationData.token, /^gw_[A-Za-z0-9_-]{43}$/);
  assert.equal(registrationData.token_type, 'Bearer');
  assert.equal(registrationData.user.email, 'alice@example.com');
  assert.equal(registrationData.user.name, 'Alice');
  assert.equal(Object.hasOwn(registrationData, 'password'), false);

  const duplicate = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'another secure password' }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'account_exists');

  const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${registrationData.token}` } });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user.email, 'alice@example.com');

  const completionWithUserToken = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${registrationData.token}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello from user token' }], max_tokens: 10 }),
  }).then((r) => r.json());
  assert.equal(completionWithUserToken.object, 'chat.completion');

  const wrongLogin = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'wrong password' }),
  });
  assert.equal(wrongLogin.status, 401);
  assert.equal((await wrongLogin.json()).error.code, 'invalid_credentials');

  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  assert.notEqual(loginData.token, registrationData.token);
  const revokedMe = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${registrationData.token}` } });
  assert.equal(revokedMe.status, 401);

  const rotated = await fetch(`${base}/auth/tokens`, {
    method: 'POST', headers: { authorization: `Bearer ${loginData.token}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(rotated.status, 200);
  const rotatedData = await rotated.json();
  assert.notEqual(rotatedData.token, loginData.token);
  const revokedAfterRotate = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${loginData.token}` } });
  assert.equal(revokedAfterRotate.status, 401);

  const adminIssued = await fetch(`${base}/auth/tokens`, {
    method: 'POST', headers: { authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com' }),
  });
  assert.equal(adminIssued.status, 200);
  const adminIssuedData = await adminIssued.json();
  assert.notEqual(adminIssuedData.token, rotatedData.token);
  const adminUsers = await fetch(`${base}/auth/admin/users`, {
    headers: { authorization: 'Bearer test-gateway-key' },
  });
  assert.equal(adminUsers.status, 200);
  const adminUsersData = await adminUsers.json();
  assert.equal(adminUsersData.users.length, 1);
  assert.equal(adminUsersData.users[0].email, 'alice@example.com');
  assert.equal(Object.hasOwn(adminUsersData.users[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(adminUsersData.users[0], 'tokenHash'), false);

  const userAdminAttempt = await fetch(`${base}/auth/admin/users`, {
    headers: { authorization: `Bearer ${adminIssuedData.token}` },
  });
  assert.equal(userAdminAttempt.status, 403);

  const reset = await fetch(`${base}/auth/admin/reset-password`, {
    method: 'POST', headers: { authorization: 'Bearer test-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'new secure password' }),
  });
  assert.equal(reset.status, 200);
  const resetData = await reset.json();
  assert.notEqual(resetData.token, adminIssuedData.token);
  const oldTokenAfterReset = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${adminIssuedData.token}` } });
  assert.equal(oldTokenAfterReset.status, 401);
  const oldPasswordLogin = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'new secure password' }),
  });
  assert.equal(newPasswordLogin.status, 200);
  const newPasswordLoginData = await newPasswordLogin.json();
  const persisted = fs.readFileSync(authStorePath, 'utf8');
  assert.equal(persisted.includes(adminIssuedData.token), false);
  assert.equal(persisted.includes('correct horse battery staple'), false);
  assert.match(persisted, /"passwordHash"\s*:/);
  assert.match(persisted, /"tokenHash"\s*:/);
  const reloadedStore = new AuthStore({ storePath: authStorePath });
  assert.ok(reloadedStore.findByToken(newPasswordLoginData.token));

  const health = await fetch(`${base}/health`, { headers: { authorization: 'Bearer test-gateway-key' } }).then((r) => r.json());
  assert.equal(health.ok, true);
  const rootStatus = await fetch(`${base}/`, { headers: { accept: 'application/json', authorization: 'Bearer test-gateway-key' } }).then((r) => r.json());
  assert.ok(rootStatus.endpoints.includes('/console/'));
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer test-gateway-key' } }).then((r) => r.json());
  assert.equal(models.object, 'list');
  assert.ok(models.data.some((model) => model.provider === 'freellm'));
  assert.ok(models.data.some((model) => model.provider === 'kilo' && model.configured === true));
  const nullBodyResponse = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-gateway-key' }, body: 'null',
  });
  assert.equal(nullBodyResponse.status, 400);
  assert.equal((await nullBodyResponse.json()).error.code, 'invalid_request');
  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-provider': 'kimi', authorization: 'Bearer test-gateway-key' },
    body: JSON.stringify({ model: 'untrusted-expensive-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 }),
  }).then((r) => r.json());
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.model, 'moonshot-v1-8k');
  assert.equal(completion.choices[0].message.role, 'assistant');
  assert.throws(() => createServer({ config: {
    host: '127.0.0.1', gatewayKey: '', allowedOrigins: ['*'], auth: { enabled: false }, mockUpstream: true,
    providers: { bad: { baseUrl: 'http://example.invalid/v1', apiKey: 'placeholder', model: 'bad' } },
  } }), /provider_base_url_must_use_https/);
  console.log('gateway smoke test: PASS');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
