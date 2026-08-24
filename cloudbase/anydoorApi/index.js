// AnyDoor — CloudBase 云函数入口
// 把 gateway/server.mjs（标准 Node http handler）包装成云函数，账号存 CloudBase 文档数据库。
'use strict';

// ---- 云端默认配置（可在云函数环境变量里覆盖）----
process.env.TRUST_PROXY = process.env.TRUST_PROXY || 'true';
process.env.AUTH_REQUIRE_TOKEN = process.env.AUTH_REQUIRE_TOKEN || 'true';
process.env.UPSTREAM_TIMEOUT_MS = process.env.UPSTREAM_TIMEOUT_MS || '25000';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'https://cochranek.github.io';
process.env.HOST = process.env.HOST || '127.0.0.1';

const serverless = require('serverless-http');
const { createCloudAuthStore } = require('./auth-db.js');

// Node 16 runtime has no global fetch; polyfill with undici when needed.
if (typeof globalThis.fetch !== 'function') {
  const { fetch: undiciFetch, Request, Response, Headers } = require('undici');
  globalThis.fetch = undiciFetch;
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis.Headers = Headers;
}

let readyPromise = null;

function initGateway() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const gateway = await import('./gateway/server.mjs');
      const authStore = createCloudAuthStore(gateway.AuthError, {
        minPasswordLength: Number(process.env.AUTH_MIN_PASSWORD_LENGTH) || 8,
      });
      const created = gateway.createServer({ authStore });
      return { handler: created.handler, authStore };
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

const wrapped = serverless(async (req, res) => {
  const { handler } = await initGateway();
  await handler(req, res);
});

function normalizeEvent(event) {
  const normalized = { ...(event || {}) };
  const headers = {};
  for (const [key, value] of Object.entries(normalized.headers || {})) {
    headers[String(key).toLowerCase()] = value;
  }
  if (!headers.host) headers.host = 'anydoor.local';
  normalized.headers = headers;
  normalized.httpMethod = String(normalized.httpMethod || 'GET').toUpperCase();
  normalized.path = normalized.path || '/';
  return normalized;
}

function flattenHeaders(result) {
  const flat = {};
  for (const [key, value] of Object.entries(result.headers || {})) {
    flat[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return flat;
}

// Temporary diagnostic endpoint: GET /__diag?coll=<collection>&id=<docId>
// Runs the exact same SDK calls the auth store uses and returns raw results.
async function runDiag(query, receivedHeaders, authStore) {
  const tcb = require('@cloudbase/node-sdk');
  const json = (payload) => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const echoHeaders = { ...(receivedHeaders || {}) };
  if (query.token) {
    const token = String(query.token).trim();
    let trace;
    try {
      trace = authStore && typeof authStore.traceTokenLookup === 'function'
        ? await authStore.traceTokenLookup(token)
        : { steps: [], result: 'store_unavailable' };
    } catch (error) {
      trace = { steps: [], result: 'trace_threw', error: String((error && error.message) || error) };
    }
    const payload = { ok: trace.result === 'ok', tokenPrefix: token.slice(0, 6), tokenLength: token.length, trace };
    if (query.replay) {
      // Run the real store method the gateway uses.
      try {
        const user = authStore ? await authStore.findByToken(token) : null;
        payload.directFindByToken = user ? { found: true, email: user.email, id: user.id } : { found: false };
      } catch (error) {
        payload.directFindByToken = { threw: String((error && error.message) || error) };
      }
      // Replay the gateway's own resolveIdentity with the exact received headers.
      try {
        const gateway = await import('./gateway/server.mjs');
        if (typeof gateway.resolveIdentity === 'function') {
          const fakeReq = { headers: { ...echoHeaders }, method: 'GET', url: '/auth/me' };
          const identity = await gateway.resolveIdentity(fakeReq, gateway.loadConfig(), authStore);
          payload.replayedIdentity = identity ? { kind: identity.kind, ...(identity.user ? { email: identity.user.email } : {}) } : null;
        } else {
          payload.replayedIdentity = 'resolveIdentity not exported';
        }
      } catch (error) {
        payload.replayedIdentity = { threw: String((error && error.message) || error) };
      }
    }
    return json({ ...payload, receivedHeaders: echoHeaders });
  }
  try {
    const db = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV }).database();
    const coll = String(query.coll || 'anydoor_tokens');
    const id = String(query.id || '');
    if (!id) return json({ hint: 'pass ?coll=<collection>&id=<docId>', env: String(process.env.SCF_NAMESPACE || ''), symbolEnv: typeof tcb.SYMBOL_CURRENT_ENV, receivedHeaders: echoHeaders });
    const res = await db.collection(coll).doc(id).get();
    return json({ ok: true, coll, id, data: res.data ?? null, requestId: res.requestId ?? null, receivedHeaders: echoHeaders });
  } catch (error) {
    return json({ ok: false, error: String((error && error.message) || error), code: error && error.code, raw: JSON.stringify(error && error.errorInfo || null), receivedHeaders: echoHeaders });
  }
}

exports.main = async (event, context) => {
  try {
    const normalized = normalizeEvent(event);
    if (normalized.path === '/__diag') {
      const qs = { ...(event.queryStringParameters || {}) };
      const rawQuery = String(event.path || '').split('?')[1] || '';
      for (const pair of rawQuery.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        const value = eq === -1 ? '' : pair.slice(eq + 1);
        try { qs[decodeURIComponent(key)] = decodeURIComponent(value); } catch { qs[key] = value; }
      }
      const { authStore } = await initGateway();
      return await runDiag(qs, normalized.headers, authStore);
    }
    const result = await wrapped(normalized, context);
    const headers = flattenHeaders(result);
    delete result.multiValueHeaders;
    return { statusCode: result.statusCode, headers, body: result.body, isBase64Encoded: Boolean(result.isBase64Encoded) };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': process.env.ALLOWED_ORIGINS.split(',')[0],
      },
      body: JSON.stringify({ error: { message: 'function error', type: 'gateway_error', code: 'function_error' } }),
    };
  }
};
