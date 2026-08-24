import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const GATEWAY_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIR = path.dirname(GATEWAY_DIR);
const DEFAULT_AUTH_STORE_PATH = path.join(GATEWAY_DIR, 'data', 'users.json');
const DEFAULT_API_CONFIG_PATH = path.join(REPOSITORY_DIR, 'api.txt');
const STATIC_ASSETS = new Map([
  ['/console/', ['index.html', 'text/html; charset=utf-8']],
  ['/console/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/console/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/console/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const PASSWORD_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

function publicUser(user) {
  const result = {
    id: user.id,
    email: user.email,
    created_at: user.createdAt,
  };
  if (user.name) result.name = user.name;
  return result;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomUserToken() {
  return `gw_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function validPassword(value, minLength) {
  return typeof value === 'string' && value.length >= minLength && value.length <= 128;
}

function safeBufferEqual(leftHex, rightHex) {
  try {
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32, PASSWORD_SCRYPT_OPTIONS).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user?.passwordSalt || !user?.passwordHash) return false;
  try {
    const candidate = crypto.scryptSync(password, user.passwordSalt, 32, PASSWORD_SCRYPT_OPTIONS).toString('hex');
    return safeBufferEqual(candidate, user.passwordHash);
  } catch {
    return false;
  }
}

/**
 * Small file-backed account store for the MVP. Only password/token hashes are
 * persisted; the plaintext token is returned to the caller that creates it.
 */
export class AuthStore {
  constructor({ storePath = '', minPasswordLength = 8 } = {}) {
    this.storePath = typeof storePath === 'string' ? storePath : '';
    this.minPasswordLength = Math.max(8, Math.min(128, Math.floor(Number(minPasswordLength) || 8)));
    this.usersById = new Map();
    this.usersByEmail = new Map();
    this.usersByToken = new Map();
    this.load();
  }

  load() {
    if (!this.storePath) return;
    let raw;
    try {
      raw = fs.readFileSync(this.storePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error('auth_store_unreadable');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('auth_store_invalid');
    }
    if (!parsed || !Array.isArray(parsed.users)) throw new Error('auth_store_invalid');
    for (const user of parsed.users) this.addLoadedUser(user);
  }

  addLoadedUser(user) {
    if (!user || typeof user !== 'object'
      || typeof user.id !== 'string'
      || typeof user.email !== 'string'
      || typeof user.createdAt !== 'string'
      || typeof user.passwordSalt !== 'string'
      || typeof user.passwordHash !== 'string'
      || typeof user.tokenHash !== 'string'
      || !EMAIL_PATTERN.test(user.email)
      || !/^[a-f0-9]{64}$/i.test(user.passwordHash)
      || !/^[a-f0-9]{64}$/i.test(user.tokenHash)) {
      throw new Error('auth_store_invalid');
    }
    const email = normalizeEmail(user.email);
    if (this.usersById.has(user.id) || this.usersByEmail.has(email) || this.usersByToken.has(user.tokenHash)) {
      throw new Error('auth_store_invalid');
    }
    const normalized = {
      id: user.id,
      email,
      createdAt: user.createdAt,
      passwordSalt: user.passwordSalt,
      passwordHash: user.passwordHash.toLowerCase(),
      tokenHash: user.tokenHash.toLowerCase(),
      tokenCreatedAt: typeof user.tokenCreatedAt === 'string' ? user.tokenCreatedAt : user.createdAt,
      ...(typeof user.name === 'string' && user.name.trim() ? { name: user.name.trim().slice(0, 80) } : {}),
    };
    this.usersById.set(normalized.id, normalized);
    this.usersByEmail.set(normalized.email, normalized);
    this.usersByToken.set(normalized.tokenHash, normalized);
  }

  persist() {
    if (!this.storePath) return;
    const directory = path.dirname(this.storePath);
    fs.mkdirSync(directory, { recursive: true });
    const payload = JSON.stringify({ version: 1, users: [...this.usersById.values()] }, null, 2);
    // Write beside the target and replace it in one rename where the platform
    // permits it. A partial JSON file would otherwise make every restart fail.
    const temporary = `${this.storePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(temporary, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
      try {
        fs.renameSync(temporary, this.storePath);
      } catch (error) {
        // Windows does not replace an existing file with renameSync. Remove
        // only the exact configured target, then complete the replacement.
        if (!['EEXIST', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
        fs.rmSync(this.storePath, { force: true });
        fs.renameSync(temporary, this.storePath);
      }
      try { fs.chmodSync(this.storePath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort cleanup */ }
    }
  }

  addUser(user) {
    this.usersById.set(user.id, user);
    this.usersByEmail.set(user.email, user);
    this.usersByToken.set(user.tokenHash, user);
  }

  removeUser(user) {
    this.usersById.delete(user.id);
    this.usersByEmail.delete(user.email);
    this.usersByToken.delete(user.tokenHash);
  }

  issueToken(user) {
    let token;
    let hash;
    do {
      token = randomUserToken();
      hash = tokenHash(token);
    } while (this.usersByToken.has(hash));
    const oldHash = user.tokenHash;
    this.usersByToken.delete(oldHash);
    user.tokenHash = hash;
    user.tokenCreatedAt = new Date().toISOString();
    this.usersByToken.set(hash, user);
    return { token, user, oldHash };
  }

  restoreToken(user, oldHash, oldCreatedAt, currentHash) {
    this.usersByToken.delete(currentHash);
    user.tokenHash = oldHash;
    user.tokenCreatedAt = oldCreatedAt;
    this.usersByToken.set(oldHash, user);
  }

  register(emailValue, password, nameValue = '') {
    const email = normalizeEmail(emailValue);
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      throw new AuthError('a valid email is required', 'invalid_email', 400);
    }
    if (!validPassword(password, this.minPasswordLength)) {
      throw new AuthError(`password must be ${this.minPasswordLength}-128 characters`, 'invalid_password', 400);
    }
    if (nameValue !== undefined && nameValue !== null && typeof nameValue !== 'string') {
      throw new AuthError('name must be text', 'invalid_name', 400);
    }
    const name = typeof nameValue === 'string' ? nameValue.trim() : '';
    if (name.length > 80) throw new AuthError('name must be 80 characters or fewer', 'invalid_name', 400);
    if (this.usersByEmail.has(email)) throw new AuthError('account already exists', 'account_exists', 409);
    const passwordData = hashPassword(password);
    const createdAt = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      email,
      ...(name ? { name } : {}),
      createdAt,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      tokenHash: '',
      tokenCreatedAt: createdAt,
    };
    this.addUser(user);
    const issued = this.issueToken(user);
    try {
      this.persist();
    } catch {
      this.removeUser(user);
      throw new AuthError('account storage is unavailable', 'auth_store_error', 503);
    }
    return issued;
  }

  findByEmail(emailValue) {
    return this.usersByEmail.get(normalizeEmail(emailValue)) || null;
  }

  findByToken(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
    return this.usersByToken.get(tokenHash(token)) || null;
  }

  login(emailValue, password) {
    const user = this.findByEmail(emailValue);
    if (!user || typeof password !== 'string' || !verifyPassword(password, user)) {
      throw new AuthError('invalid email or password', 'invalid_credentials', 401);
    }
    return this.rotateToken(user);
  }

  rotateToken(user) {
    if (!user || !this.usersById.has(user.id)) {
      throw new AuthError('account not found', 'account_not_found', 404);
    }
    const oldHash = user.tokenHash;
    const oldCreatedAt = user.tokenCreatedAt;
    const issued = this.issueToken(user);
    try {
      this.persist();
    } catch {
      this.restoreToken(user, oldHash, oldCreatedAt, issued.oldHash === oldHash ? user.tokenHash : issued.oldHash);
      throw new AuthError('account storage is unavailable', 'auth_store_error', 503);
    }
    return issued;
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stripIniValue(value) {
  let result = String(value ?? '').trim();
  // Permit human-friendly trailing comments while preserving URL fragments
  // and credential characters that are not preceded by whitespace.
  result = result.replace(/\s+[;#].*$/, '').trim();
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

/**
 * Read the deliberately small provider file format. It is INI-like rather
 * than a general config language so credentials can be edited without a
 * dependency. Only [provider.<name>] sections are accepted; all other
 * sections are ignored. Values are kept server-side and never serialized into
 * a response.
 */
export function parseProviderIni(source) {
  const providers = {};
  let current = null;
  for (const rawLine of String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const match = /^provider\.([a-z0-9][a-z0-9_-]*)$/i.exec(section[1].trim());
      current = match ? match[1].toLowerCase() : null;
      if (current) providers[current] ||= {};
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase().replace(/[-\s]/g, '_');
    if (!key) continue;
    const value = stripIniValue(line.slice(separator + 1));
    providers[current][key] = value;
  }
  return providers;
}

function readProviderFile(filePath) {
  if (!filePath) return {};
  try {
    return parseProviderIni(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A missing optional file is normal. A malformed/unreadable file should
      // not prevent the gateway from starting with environment-only config.
      // Do not include the path or file contents in the log/error response.
    }
    return {};
  }
}

function envValue(names) {
  for (const name of names) {
    if (Object.hasOwn(process.env, name) && String(process.env[name]).trim() !== '') {
      return String(process.env[name]).trim();
    }
  }
  return '';
}

function boolValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch { /* comma-separated fallback */ }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function providerEnvNames(name, suffix) {
  const upper = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const aliases = [upper];
  if (name === 'freellm') aliases.push('FREELLMAPI');
  return [...new Set(aliases.map((alias) => `${alias}_${suffix}`))];
}

function providerFromFile(name, fileConfig = {}) {
  const defaults = {
    vendor: name,
    baseUrl: name === 'freellm' ? 'http://127.0.0.1:18080/v1'
      : name === 'qwen' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        : 'https://api.moonshot.cn/v1',
    apiKey: '',
    auth: 'bearer',
    model: name === 'kimi' ? 'moonshot-v1-8k' : name === 'qwen' ? 'qwen-plus' : 'gpt-4o-mini',
    models: [],
    enabled: true,
    minOutputTokens: 1,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    configUrl: '',
    docsUrl: '',
    status: '',
  };
  const fromFile = fileConfig || {};
  const value = (key, fallback) => fromFile[key] !== undefined && fromFile[key] !== '' ? fromFile[key] : fallback;
  const result = {
    ...defaults,
    vendor: value('vendor', defaults.vendor),
    baseUrl: value('base_url', defaults.baseUrl),
    apiKey: value('api_key', defaults.apiKey),
    auth: String(value('auth', value('auth_mode', value('authentication', defaults.auth)))).toLowerCase(),
    model: value('model', defaults.model),
    models: listValue(value('models', defaults.models)),
    enabled: boolValue(value('enabled', defaults.enabled), true),
    minOutputTokens: Math.max(1, Math.floor(Number(value('min_output_tokens', defaults.minOutputTokens)) || defaults.minOutputTokens)),
    inputUsdPerMillion: Number(value('input_usd_per_million', defaults.inputUsdPerMillion)) || 0,
    outputUsdPerMillion: Number(value('output_usd_per_million', defaults.outputUsdPerMillion)) || 0,
    configUrl: value('config_url', defaults.configUrl),
    docsUrl: value('docs_url', defaults.docsUrl),
    status: value('status', defaults.status),
  };
  const apiKey = envValue(providerEnvNames(name, 'API_KEY'));
  const baseUrl = envValue(providerEnvNames(name, 'BASE_URL'));
  const model = envValue(providerEnvNames(name, 'MODEL'));
  const enabled = envValue(providerEnvNames(name, 'ENABLED'));
  const models = envValue(providerEnvNames(name, 'MODELS'));
  const inputRate = envValue(providerEnvNames(name, 'INPUT_USD_PER_MILLION'));
  const outputRate = envValue(providerEnvNames(name, 'OUTPUT_USD_PER_MILLION'));
  const minOutput = envValue(providerEnvNames(name, 'MIN_OUTPUT_TOKENS'));
  const auth = envValue([...providerEnvNames(name, 'AUTH'), ...providerEnvNames(name, 'AUTH_MODE')]);
  if (apiKey) result.apiKey = apiKey;
  if (baseUrl) result.baseUrl = baseUrl;
  if (model) result.model = model;
  if (enabled) result.enabled = boolValue(enabled, result.enabled);
  if (models) result.models = listValue(models);
  if (inputRate) result.inputUsdPerMillion = Number(inputRate) || 0;
  if (outputRate) result.outputUsdPerMillion = Number(outputRate) || 0;
  if (minOutput) result.minOutputTokens = Math.max(1, Math.floor(Number(minOutput) || result.minOutputTokens));
  if (auth) result.auth = auth.toLowerCase();
  result.name = name;
  return result;
}

export function loadConfig() {
  let configuredPath = DEFAULT_API_CONFIG_PATH;
  if (process.env.API_CONFIG_FILE) {
    const requestedPath = path.resolve(process.env.API_CONFIG_FILE);
    const repositoryRelativePath = path.resolve(REPOSITORY_DIR, process.env.API_CONFIG_FILE);
    configuredPath = fs.existsSync(requestedPath) || requestedPath === repositoryRelativePath
      ? requestedPath
      : (fs.existsSync(repositoryRelativePath) ? repositoryRelativePath : requestedPath);
  }
  const fileProviders = readProviderFile(configuredPath);
  const names = new Set(['kimi', 'qwen', 'freellm', ...Object.keys(fileProviders)]);
  const providers = Object.fromEntries([...names].map((name) => [name, providerFromFile(name, fileProviders[name])]));
  return {
    host: process.env.HOST || '127.0.0.1',
    port: numberEnv('PORT', 8787),
    defaultProvider: (process.env.DEFAULT_PROVIDER || 'kimi').toLowerCase(),
    gatewayKey: process.env.GATEWAY_KEY || '',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((value) => value.trim()).filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === 'true',
    maxBodyBytes: numberEnv('MAX_BODY_BYTES', 512 * 1024),
    maxOutputTokens: numberEnv('MAX_OUTPUT_TOKENS', 1800),
    rateLimitPerMinute: numberEnv('RATE_LIMIT_PER_MINUTE', 30),
    dailyTokenBudget: numberEnv('DAILY_TOKEN_BUDGET', 250000),
    upstreamTimeoutMs: numberEnv('UPSTREAM_TIMEOUT_MS', 60000),
    mockUpstream: process.env.MOCK_UPSTREAM === 'true',
    auth: {
      enabled: process.env.AUTH_ENABLED !== 'false',
      registrationEnabled: process.env.REGISTRATION_ENABLED !== 'false',
      requireToken: process.env.AUTH_REQUIRE_TOKEN === 'true',
      storePath: process.env.AUTH_STORE_PATH || DEFAULT_AUTH_STORE_PATH,
      minPasswordLength: numberEnv('AUTH_MIN_PASSWORD_LENGTH', 8),
    },
    apiConfigFile: configuredPath,
    providers,
  };
}

function normalizeConfig(config) {
  const auth = config.auth || {};
  const providers = {};
  for (const [rawName, rawProvider] of Object.entries(config.providers || {})) {
    const name = String(rawName).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) continue;
    const supplied = { ...(rawProvider || {}) };
    // Accept the same snake_case names used by api.txt when callers provide a
    // config object directly (useful for deployment wrappers and tests).
    for (const [snake, camel] of [
      ['api_key', 'apiKey'], ['base_url', 'baseUrl'], ['min_output_tokens', 'minOutputTokens'],
      ['input_usd_per_million', 'inputUsdPerMillion'], ['output_usd_per_million', 'outputUsdPerMillion'],
      ['config_url', 'configUrl'], ['docs_url', 'docsUrl'], ['auth_mode', 'auth'],
    ]) {
      if (supplied[camel] === undefined && supplied[snake] !== undefined) supplied[camel] = supplied[snake];
    }
    const provider = { ...providerFromFile(name), ...supplied, name };
    provider.baseUrl = String(provider.baseUrl || '').trim();
    provider.apiKey = String(provider.apiKey || '').trim();
    provider.auth = String(provider.auth || 'bearer').trim().toLowerCase();
    provider.models = listValue(provider.models);
    provider.enabled = boolValue(provider.enabled, true);
    provider.minOutputTokens = Math.max(1, Math.floor(Number(provider.minOutputTokens) || 1));
    provider.inputUsdPerMillion = Number(provider.inputUsdPerMillion) || 0;
    provider.outputUsdPerMillion = Number(provider.outputUsdPerMillion) || 0;
    providers[name] = provider;
  }
  return {
    ...config,
    defaultProvider: String(config.defaultProvider || 'kimi').toLowerCase(),
    providers,
    allowedOrigins: Array.isArray(config.allowedOrigins) && config.allowedOrigins.length ? config.allowedOrigins : ['*'],
    auth: {
      enabled: boolValue(auth.enabled, true),
      registrationEnabled: boolValue(auth.registrationEnabled, true),
      requireToken: boolValue(auth.requireToken, false),
      storePath: Object.hasOwn(auth, 'storePath') ? auth.storePath : DEFAULT_AUTH_STORE_PATH,
      minPasswordLength: auth.minPasswordLength ?? 8,
    },
  };
}

function corsHeaders(req, config) {
  const requested = String(req.headers.origin || '');
  const allowedOrigins = Array.isArray(config.allowedOrigins) && config.allowedOrigins.length ? config.allowedOrigins : ['*'];
  const wildcard = allowedOrigins.includes('*');
  const origin = wildcard ? '*' : (allowedOrigins.includes(requested) ? requested : 'null');
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization, x-gateway-key, x-provider',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    ...(wildcard ? {} : { vary: 'Origin' }),
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function sendStatic(res, asset, extraHeaders = {}) {
  const [fileName, contentType] = asset;
  try {
    const body = fs.readFileSync(path.join(GATEWAY_DIR, fileName));
    res.writeHead(200, {
      ...extraHeaders,
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-length': String(body.length),
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'console asset not found' }, extraHeaders);
  }
}

function requestId() {
  return crypto.randomUUID();
}

function safeError(message, code, request_id) {
  return { error: { message, type: 'gateway_error', code, request_id } };
}

function clientAddress(req, config) {
  const forwarded = config.trustProxy ? req.headers['x-forwarded-for'] : '';
  return String(forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function suppliedCredential(req) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-gateway-key'] || '').trim();
}

function matchesSecret(supplied, expectedValue) {
  if (!supplied || !expectedValue) return false;
  const expected = Buffer.from(expectedValue);
  const actual = Buffer.from(supplied);
  // timingSafeEqual requires equal-length buffers; normalize the comparison
  // so malformed credentials return 401 instead of throwing from the server.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export async function resolveIdentity(req, config, authStore) {
  const supplied = suppliedCredential(req);
  if (matchesSecret(supplied, config.gatewayKey)) return { kind: 'gateway' };
  const user = await authStore?.findByToken(supplied);
  if (user) return { kind: 'user', user };
  if (!config.gatewayKey && !config.auth.requireToken) return { kind: 'anonymous' };
  return null;
}

async function authenticate(req, config, authStore) {
  return Boolean(await resolveIdentity(req, config, authStore));
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

function authPayload(issued) {
  return {
    token: issued.token,
    token_type: 'Bearer',
    user: publicUser(issued.user),
  };
}

function authErrorPayload(error, request_id) {
  if (error instanceof AuthError) return safeError(error.message, error.code, request_id);
  return safeError('authentication service unavailable', 'auth_store_error', request_id);
}

function isObjectBody(body) {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body);
}

function isPublicAuthRoute(req, pathname) {
  return req.method === 'POST' && (pathname === '/auth/register' || pathname === '/auth/login');
}

function chooseProvider(body, req, config) {
  const requested = String(req.headers['x-provider'] || body.provider || '').toLowerCase();
  if (requested && Object.hasOwn(config.providers, requested) && config.providers[requested].enabled !== false) return requested;
  if (requested) return null;
  if (Object.hasOwn(config.providers, config.defaultProvider) && config.providers[config.defaultProvider].enabled !== false) {
    return config.defaultProvider;
  }
  return Object.entries(config.providers).find(([, provider]) => provider.enabled !== false)?.[0] || null;
}

function clampRequest(body, providerConfig) {
  const payload = { ...body };
  delete payload.provider;
  // Route requests only to the model configured for the selected provider.
  // Callers cannot switch to an unmetered or unexpectedly expensive model.
  payload.model = providerConfig.model;
  if (payload.stream === true) {
    throw new Error('streaming_not_supported');
  }
  delete payload.max_output_tokens;
  const asked = Number(payload.max_tokens);
  const responseMinimum = Math.max(1, Number(providerConfig.minOutputTokens) || 1);
  const responseMaximum = Math.max(responseMinimum, Number(providerConfig.maxOutputTokens) || responseMinimum);
  payload.max_tokens = Number.isFinite(asked) && asked > 0
    ? Math.max(responseMinimum, Math.min(Math.floor(asked), responseMaximum))
    : responseMaximum;
  return payload;
}

function usageCost(usage, providerConfig) {
  if (!usage || !Number.isFinite(Number(usage.prompt_tokens)) || !Number.isFinite(Number(usage.completion_tokens))) {
    return 0;
  }
  return (Number(usage.prompt_tokens) * providerConfig.inputUsdPerMillion
    + Number(usage.completion_tokens) * providerConfig.outputUsdPerMillion) / 1_000_000;
}

function createState() {
  return {
    startedAt: new Date().toISOString(),
    day: new Date().toISOString().slice(0, 10),
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedUsd: 0,
    rateWindows: new Map(),
    authStore: null,
  };
}

function resetDailyState(state) {
  const day = new Date().toISOString().slice(0, 10);
  if (state.day !== day) {
    state.day = day;
    state.requestCount = 0;
    state.promptTokens = 0;
    state.completionTokens = 0;
    state.estimatedUsd = 0;
  }
}

function rateLimited(state, address, limit) {
  const now = Date.now();
  const windowStart = now - 60_000;
  if (state.rateWindows.size > 10_000) {
    for (const [key, values] of state.rateWindows) {
      if (!values.some((timestamp) => timestamp > windowStart)) state.rateWindows.delete(key);
    }
  }
  const timestamps = (state.rateWindows.get(address) || []).filter((t) => t > windowStart);
  if (timestamps.length >= limit) {
    state.rateWindows.set(address, timestamps);
    return true;
  }
  timestamps.push(now);
  state.rateWindows.set(address, timestamps);
  return false;
}

function assertSafeNetworkConfig(config) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(String(config.host).toLowerCase());
  if (!loopback && !config.gatewayKey) throw new Error('GATEWAY_KEY is required when HOST is not loopback');
  if (!loopback && config.allowedOrigins.includes('*')) throw new Error('ALLOWED_ORIGINS must be explicit when HOST is not loopback');
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isFreeLlmProvider(providerName) {
  return String(providerName || '').toLowerCase() === 'freellm';
}

function validateProviderUrl(providerName, providerConfig) {
  let providerUrl;
  try {
    providerUrl = new URL(providerConfig.baseUrl);
  } catch {
    throw new Error('provider_base_url_invalid');
  }
  if (providerUrl.protocol === 'https:') return providerUrl;
  if (providerUrl.protocol === 'http:' && isFreeLlmProvider(providerName) && isLoopbackHostname(providerUrl.hostname)) {
    return providerUrl;
  }
  throw new Error('provider_base_url_must_use_https');
}

function assertProviderNetworkConfig(config) {
  for (const [name, provider] of Object.entries(config.providers || {})) {
    if (provider.enabled === false) continue;
    validateProviderUrl(name, provider);
  }
}

function providerConfigured(providerName, providerConfig, config) {
  if (providerConfig.enabled === false) return false;
  if (config.mockUpstream) return true;
  if (providerConfig.auth === 'none') return true;
  if (providerConfig.apiKey) return true;
  return isFreeLlmProvider(providerName)
    && (() => { try { return isLoopbackHostname(new URL(providerConfig.baseUrl).hostname); } catch { return false; } })();
}

function accountingUsage(data) {
  const usage = data?.usage || {};
  return {
    prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
  };
}

function redactUpstreamMessage(message, providerConfig) {
  let text = String(message || '').slice(0, 500);
  if (providerConfig.apiKey) text = text.split(providerConfig.apiKey).join('[redacted]');
  // Upstream error bodies occasionally echo credentials from a failed
  // request. Redact common key-shaped strings before they reach the caller.
  return text.replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{16,}\b/gi, '[redacted]');
}

async function callProvider(payload, providerConfig, config, providerName) {
  if (config.mockUpstream) {
    const prompt = payload.messages?.at(-1)?.content || '';
    return {
      id: `mock-${requestId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `Mock response: ${String(prompt).slice(0, 160)}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.max(1, Math.ceil(JSON.stringify(payload).length / 4)), completion_tokens: 24, total_tokens: 24 + Math.max(1, Math.ceil(JSON.stringify(payload).length / 4)) },
    };
  }
  if (!providerConfig.apiKey && providerConfig.auth !== 'none' && !isFreeLlmProvider(providerName)) {
    throw new Error('provider_key_not_configured');
  }
  const providerUrl = validateProviderUrl(providerName, providerConfig);
  const headers = { 'content-type': 'application/json' };
  if (providerConfig.apiKey && providerConfig.auth !== 'none') headers.authorization = `Bearer ${providerConfig.apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(config.upstreamTimeoutMs) || 60_000));
  try {
    const response = await fetch(`${providerUrl.href.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: { message: text.slice(0, 500) } }; }
    if (!response.ok) {
      const upstreamMessage = redactUpstreamMessage(data?.error?.message || `upstream_http_${response.status}`, providerConfig);
      const error = new Error(upstreamMessage);
      error.status = response.status >= 500 ? 502 : 400;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function createServer({ config = loadConfig(), state = createState(), authStore: providedAuthStore } = {}) {
  const normalizedConfig = normalizeConfig(config);
  assertSafeNetworkConfig(normalizedConfig);
  assertProviderNetworkConfig(normalizedConfig);
  const authStore = providedAuthStore || state.authStore
    || (normalizedConfig.auth.enabled ? new AuthStore({
      storePath: normalizedConfig.auth.storePath,
      minPasswordLength: normalizedConfig.auth.minPasswordLength,
    }) : null);
  state.authStore = authStore;
  async function handleRequest(req, res) {
    const id = requestId();
    const cors = corsHeaders(req, normalizedConfig);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    resetDailyState(state);

    // The console is deliberately a small static surface. It is public so a
    // new visitor can reach registration even when API routes require auth.
    if (req.method === 'GET' && url.pathname === '/console') {
      res.writeHead(302, { ...cors, location: '/console/', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const requestedAsset = STATIC_ASSETS.get(url.pathname)
      || (req.method === 'GET' && url.pathname === '/' && /text\/html/i.test(String(req.headers.accept || ''))
        ? STATIC_ASSETS.get('/console/') : null);
    if (req.method === 'GET' && requestedAsset) {
      sendStatic(res, requestedAsset, cors);
      return;
    }
    const publicAuthRoute = isPublicAuthRoute(req, url.pathname);

    // Count unauthenticated attempts as well so registration/login cannot
    // bypass the per-IP limiter.
    if (rateLimited(state, clientAddress(req, normalizedConfig), normalizedConfig.rateLimitPerMinute)) {
      sendJson(res, 429, safeError('rate limit exceeded', 'rate_limited', id), { ...cors, 'retry-after': '60' });
      return;
    }

    if (url.pathname.startsWith('/auth/') && !normalizedConfig.auth.enabled) {
      sendJson(res, 404, safeError('auth routes are disabled', 'not_found', id), cors);
      return;
    }

    const identity = publicAuthRoute ? null : await resolveIdentity(req, normalizedConfig, authStore);
    if (!publicAuthRoute && !identity) {
      sendJson(res, 401, safeError('gateway authentication required', 'unauthorized', id), cors);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/auth/register') {
      if (!normalizedConfig.auth.registrationEnabled) {
        sendJson(res, 403, safeError('registration is disabled', 'registration_disabled', id), cors);
        return;
      }
      let body;
      try { body = await readJsonBody(req, normalizedConfig.maxBodyBytes); } catch (error) {
        const code = error.message === 'request_body_too_large' ? 'payload_too_large' : 'invalid_json';
        sendJson(res, 400, safeError(code === 'payload_too_large' ? 'request body too large' : 'invalid JSON body', code, id), cors);
        return;
      }
      if (!isObjectBody(body)) {
        sendJson(res, 400, safeError('request body must be a JSON object', 'invalid_request', id), cors);
        return;
      }
      try {
        const issued = await authStore.register(body.email, body.password, body.name);
        sendJson(res, 201, authPayload(issued), cors);
      } catch (error) {
        const status = Number(error.status) || 503;
        sendJson(res, status, authErrorPayload(error, id), cors);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      let body;
      try { body = await readJsonBody(req, normalizedConfig.maxBodyBytes); } catch (error) {
        const code = error.message === 'request_body_too_large' ? 'payload_too_large' : 'invalid_json';
        sendJson(res, 400, safeError(code === 'payload_too_large' ? 'request body too large' : 'invalid JSON body', code, id), cors);
        return;
      }
      if (!isObjectBody(body)) {
        sendJson(res, 400, safeError('request body must be a JSON object', 'invalid_request', id), cors);
        return;
      }
      try {
        const issued = await authStore.login(body.email, body.password);
        sendJson(res, 200, authPayload(issued), cors);
      } catch (error) {
        const status = Number(error.status) || 503;
        sendJson(res, status, authErrorPayload(error, id), cors);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/me') {
      if (!identity || identity.kind !== 'user') {
        sendJson(res, 401, safeError('a user token is required', 'unauthorized', id), cors);
        return;
      }
      sendJson(res, 200, { user: publicUser(identity.user) }, cors);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/auth/tokens') {
      if (!authStore || !identity || (identity.kind !== 'user' && identity.kind !== 'gateway')) {
        sendJson(res, 401, safeError('a user token is required', 'unauthorized', id), cors);
        return;
      }
      let body;
      try { body = await readJsonBody(req, normalizedConfig.maxBodyBytes); } catch (error) {
        const code = error.message === 'request_body_too_large' ? 'payload_too_large' : 'invalid_json';
        sendJson(res, 400, safeError(code === 'payload_too_large' ? 'request body too large' : 'invalid JSON body', code, id), cors);
        return;
      }
      if (!isObjectBody(body)) {
        sendJson(res, 400, safeError('request body must be a JSON object', 'invalid_request', id), cors);
        return;
      }
      let user = identity.kind === 'user' ? identity.user : null;
      if (identity.kind === 'gateway') {
        user = await authStore.findByEmail(body.email);
        if (!user) {
          sendJson(res, 404, safeError('account not found', 'account_not_found', id), cors);
          return;
        }
      }
      try {
        const issued = await authStore.rotateToken(user);
        sendJson(res, 200, authPayload(issued), cors);
      } catch (error) {
        const status = Number(error.status) || 503;
        sendJson(res, status, authErrorPayload(error, id), cors);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'anydoor-gateway', request_id: id, day: state.day }, cors);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        service: 'anydoor-gateway',
        endpoints: ['/console/', '/health', '/auth/register', '/auth/login', '/auth/me', '/auth/tokens', '/v1/models', '/v1/chat/completions'],
        auth: normalizedConfig.gatewayKey || normalizedConfig.auth.requireToken ? 'required' : 'disabled',
        registration: normalizedConfig.auth.enabled && normalizedConfig.auth.registrationEnabled ? 'open' : 'disabled',
        mock: normalizedConfig.mockUpstream,
      }, cors);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const models = Object.entries(normalizedConfig.providers).map(([name, p]) => ({
        id: p.model,
        object: 'model',
        provider: name,
        vendor: p.vendor,
        configured: providerConfigured(name, p, normalizedConfig),
        enabled: p.enabled !== false,
        ...(p.status ? { status: p.status } : {}),
        ...(p.models.length ? { models: p.models } : {}),
      }));
      sendJson(res, 200, { object: 'list', data: models, usage: { requests_today: state.requestCount, tokens_today: state.promptTokens + state.completionTokens, estimated_usd_today: Number(state.estimatedUsd.toFixed(6)) } }, cors);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body;
      try { body = await readJsonBody(req, normalizedConfig.maxBodyBytes); } catch (error) {
        const code = error.message === 'request_body_too_large' ? 'payload_too_large' : 'invalid_json';
        sendJson(res, 400, safeError(code === 'payload_too_large' ? 'request body too large' : 'invalid JSON body', code, id), cors);
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, safeError('request body must be a JSON object', 'invalid_request', id), cors);
        return;
      }
      const provider = chooseProvider(body, req, normalizedConfig);
      if (!provider) { sendJson(res, 400, safeError('unknown provider', 'invalid_provider', id), cors); return; }
      const providerConfig = normalizedConfig.providers[provider];
      let payload;
      try { payload = clampRequest(body, { ...providerConfig, maxOutputTokens: normalizedConfig.maxOutputTokens }); } catch (error) {
        sendJson(res, 400, safeError(error.message === 'streaming_not_supported' ? 'streaming is not supported by this MVP' : 'invalid request', error.message, id), cors);
        return;
      }
      if (state.promptTokens + state.completionTokens >= normalizedConfig.dailyTokenBudget) {
        sendJson(res, 429, safeError('daily token budget exhausted', 'budget_exhausted', id), cors);
        return;
      }
      try {
        const data = await callProvider(payload, providerConfig, normalizedConfig, provider);
        const usage = accountingUsage(data);
        state.requestCount += 1;
        state.promptTokens += Number(usage.prompt_tokens || 0);
        state.completionTokens += Number(usage.completion_tokens || 0);
        state.estimatedUsd += usageCost(usage, providerConfig);
        sendJson(res, 200, data, { ...cors, 'x-gateway-request-id': id, 'x-gateway-provider': provider });
      } catch (error) {
        const status = Number(error.status) || (error.name === 'AbortError' ? 504
          : ['provider_base_url_invalid', 'provider_base_url_must_use_https'].includes(error.message) ? 400 : 503);
        sendJson(res, status, safeError(error.name === 'AbortError' ? 'upstream timeout' : error.message, 'upstream_error', id), cors);
      }
      return;
    }
    sendJson(res, 404, safeError('route not found', 'not_found', id), cors);
  }
  const server = http.createServer(handleRequest);
  return { server, handler: handleRequest, config: normalizedConfig, state, authStore };
}

// `import.meta.url` is a URL while `process.argv[1]` is a native path. The
// direct string comparison works on some Unix shells but fails on Windows.
const launchedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (launchedFile && path.resolve(fileURLToPath(import.meta.url)) === launchedFile) {
  const { server, config } = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`anydoor-gateway listening on http://${config.host}:${config.port}`);
  });
}
