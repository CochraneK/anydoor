// Import provider credentials from the local OmniRoute database into api.txt.
// Keys are AES-256-GCM encrypted with STORAGE_ENCRYPTION_KEY from OmniRoute
// server.env. Only providers exposing an OpenAI-compatible HTTP API are
// imported; OmniRoute web-scraper adapters (qwen-web, zai-web, aihorde, ...)
// cannot be forwarded by this gateway. Every candidate key is verified with a
// live GET /models call before it is written. Existing api.txt sections are
// never modified; duplicate keys are skipped, and a second distinct key for an
// already configured provider is added as "<provider>-b".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(GATEWAY_DIR, '..');
const API_FILE = path.join(ROOT, 'api.txt');
const DUMP_FILE = path.join(GATEWAY_DIR, '_omniroute_dump.json');
const SERVER_ENV = process.env.OMNIROUTE_ENV
  || path.join(process.env.APPDATA || '', 'omniroute', 'server.env');

const PROVIDERS = {
  agnes: { vendor: 'Agnes AI', base_url: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', config_url: 'https://apihub.agnes-ai.com/', docs_url: 'https://apihub.agnes-ai.com/' },
  alibaba: { vendor: 'Alibaba Cloud Model Studio', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', config_url: 'https://bailian.console.aliyun.com/?tab=model#/api-key', docs_url: 'https://help.aliyun.com/zh/model-studio/' },
  'g4f-nvidia': { vendor: 'G4F NVIDIA Mirror', base_url: 'https://g4f.space/api/nvidia/v1', model: 'openai/gpt-oss-20b', config_url: 'https://g4f.space/', docs_url: 'https://g4f.space/' },
  'github-models': { vendor: 'GitHub Models', base_url: 'https://models.github.ai/inference', model: 'openai/gpt-4.1', config_url: 'https://github.com/settings/tokens', docs_url: 'https://docs.github.com/en/github-models' },
  llm7: { vendor: 'LLM7', base_url: 'https://api.llm7.io/v1', model: 'codestral-latest', config_url: 'https://llm7.io/', docs_url: 'https://llm7.io/' },
  longcat: { vendor: 'LongCat (Meituan)', base_url: 'https://api.longcat.chat/openai/v1', model: 'LongCat-Flash-Chat', config_url: 'https://longcat.chat/', docs_url: 'https://longcat.chat/platform/docs' },
  nvidia: { vendor: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', model: 'openai/gpt-oss-20b', config_url: 'https://build.nvidia.com/', docs_url: 'https://docs.api.nvidia.com/' },
  'opencode-go': { vendor: 'OpenCode Zen', base_url: 'https://opencode.ai/zen/v1', model: 'big-pickle', config_url: 'https://opencode.ai/', docs_url: 'https://opencode.ai/docs/' },
  openrouter: { vendor: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3.5-lightning:free', config_url: 'https://openrouter.ai/keys', docs_url: 'https://openrouter.ai/docs/api-reference/overview' },
  reka: { vendor: 'Reka', base_url: 'https://api.reka.ai/v1', model: 'reka-flash', config_url: 'https://platform.reka.ai/', docs_url: 'https://docs.reka.ai/' },
  kilocode: { vendor: 'Kilo Gateway', base_url: 'https://api.kilo.ai/api/gateway/v1', model: 'kilo-auto/free', config_url: 'https://app.kilo.ai/', docs_url: 'https://docs.kilo.ai/' },
};
// OmniRoute names that map onto existing api.txt section names.
const RENAME = { 'github-models': 'github', 'opencode-go': 'opencode', kilocode: 'kilo' };

function readEnvKey(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^STORAGE_ENCRYPTION_KEY=([0-9a-f]{64})\s*$/m);
  if (!match) throw new Error('STORAGE_ENCRYPTION_KEY not found in server.env');
  return match[1];
}

// Mirrors E:\OmniRoute\resources\app\bin\cli\encryption.mjs: the AES key is
// scrypt(secret, static salt), not the raw hex secret.
function deriveKey(secret) {
  return crypto.scryptSync(secret, 'omniroute-field-encryption-v1', 32);
}

function decrypt(encValue, keyHex) {
  const parts = String(encValue || '').split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(keyHex), Buffer.from(parts[2], 'hex'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(parts[4], 'hex'));
  return decipher.update(parts[3], 'hex', 'utf8') + decipher.final('utf8');
}

function existingKeys(text) {
  const keys = new Set();
  const sections = new Set();
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\[provider\.([^\]]+)\]$/i);
    if (section) { sections.add(section[1].trim().toLowerCase()); continue; }
    const key = line.match(/^api_key=(.+)$/i);
    if (key) keys.add(key[1].trim());
  }
  return { keys, sections };
}

function iniValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').trim();
}

function section(name, fields) {
  const lines = [`[provider.${name}]`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}=${iniValue(value)}`);
  }
  return `${lines.join('\n')}\n\n`;
}

async function verifyKey(baseUrl, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, models: [] };
    const data = await response.json().catch(() => ({}));
    const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
    return { ok: true, status: response.status, models };
  } catch (error) {
    return { ok: false, status: error.name === 'AbortError' ? 'timeout' : String(error.message || error).slice(0, 80), models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

const dump = JSON.parse(fs.readFileSync(DUMP_FILE, 'utf8'));
const keyHex = readEnvKey(SERVER_ENV);
const apiText = fs.readFileSync(API_FILE, 'utf8');
const existing = existingKeys(apiText);
const report = [];
const additions = [];

for (const conn of dump) {
  const mapped = PROVIDERS[conn.provider];
  if (!mapped) { report.push({ provider: conn.provider, action: 'skipped_scraper_or_unknown' }); continue; }
  let key = '';
  if (conn.api_key_enc) {
    try { key = decrypt(conn.api_key_enc, keyHex).trim(); } catch { report.push({ provider: conn.provider, action: 'decrypt_failed' }); continue; }
  } else if (conn.provider === 'kilocode' && conn.access_token_enc) {
    try { key = decrypt(conn.access_token_enc, keyHex).trim(); } catch { key = ''; }
    const expiry = Number(conn.expires_at) || 0;
    const expiryMs = String(conn.expires_at).length > 10 ? expiry : expiry * 1000;
    if (expiryMs && expiryMs < Date.now()) { report.push({ provider: conn.provider, action: 'skipped_oauth_expired' }); continue; }
  }
  if (!key) { report.push({ provider: conn.provider, action: 'skipped_no_key' }); continue; }
  if (existing.keys.has(key)) { report.push({ provider: conn.provider, action: 'duplicate_key_skipped', key_len: key.length }); continue; }
  const check = await verifyKey(mapped.base_url, key);
  if (!check.ok) { report.push({ provider: conn.provider, action: 'verify_failed', status: check.status, key_len: key.length }); continue; }
  const baseName = RENAME[conn.provider] || conn.provider;
  const name = existing.sections.has(baseName) ? `${baseName}-b` : baseName;
  const model = check.models.includes(mapped.model) ? mapped.model : (check.models[0] || mapped.model);
  additions.push(section(name, {
    vendor: mapped.vendor,
    base_url: mapped.base_url,
    protocol: 'chat',
    model,
    config_url: mapped.config_url,
    docs_url: mapped.docs_url,
    source: 'OmniRoute encrypted DB (authorized export)',
    status: 'verified_omniroute',
    enabled: true,
    api_key: key,
    auth: 'bearer',
  }));
  existing.keys.add(key);
  existing.sections.add(name);
  report.push({ provider: conn.provider, action: 'added', as: name, model, upstream_models: check.models.length, key_len: key.length });
}

if (additions.length) {
  const gatewayIndex = apiText.search(/^\[gateway\]$/m);
  const block = additions.join('');
  const next = gatewayIndex >= 0
    ? `${apiText.slice(0, gatewayIndex)}${block}${apiText.slice(gatewayIndex)}`
    : `${apiText.replace(/\s*$/, '\n\n')}${block}`;
  fs.writeFileSync(API_FILE, next, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(API_FILE, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
}
console.log(JSON.stringify({ checked_at: new Date().toISOString(), added: additions.length, report }, null, 1));
