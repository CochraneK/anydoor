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

exports.main = async (event, context) => {
  try {
    const normalized = normalizeEvent(event);
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
