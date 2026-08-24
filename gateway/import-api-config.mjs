import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_FILE = path.join(ROOT, 'api.txt');
const FREE_API_DB = process.env.FREELLMAPI_DB
  || path.join(process.env.APPDATA || '', 'FreeLLMAPI', 'freeapi.db');
const checkedAt = new Date().toISOString();

function dbSnapshot() {
  const dbPath = FREE_API_DB.replaceAll('\\', '/');
  const python = [
    'import sqlite3,json',
    `p=${JSON.stringify(dbPath)}`,
    "c=sqlite3.connect('file:'+p+'?mode=ro',uri=True)",
    "s=dict(c.execute('select key,value from settings'))",
    "rows=c.execute('select platform,label,encrypted_key,iv,auth_tag,status,enabled,base_url from api_keys order by platform').fetchall()",
    "counts=dict(c.execute('select platform,count(*) from models where enabled=1 group by platform').fetchall())",
    "print(json.dumps({'settings':s,'rows':[{'platform':r[0],'label':r[1],'encrypted_key':r[2],'iv':r[3],'auth_tag':r[4],'status':r[5],'enabled':r[6],'base_url':r[7]} for r in rows],'model_counts':counts}))",
  ].join('\n');
  return JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', python], { encoding: 'utf8' }));
}

function decrypt(row, encryptionKey) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(row.iv, 'hex'),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'hex'));
  return decipher.update(row.encrypted_key, 'hex', 'utf8') + decipher.final('utf8');
}

function legacyKeys(text) {
  const values = {};
  let sectionName = '';
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\[provider\.([^\]]+)\]$/i);
    if (sectionMatch) {
      sectionName = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const match = line.match(/^([^:#：]+)[：:](.*)$/);
    if (match) values[match[1].trim().toLowerCase()] = match[2].trim();
    const iniMatch = line.match(/^api_key=(.*)$/i);
    if (iniMatch && sectionName) values[sectionName] = iniMatch[1].trim();
  }
  return values;
}

function iniValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').trim();
}

function section(name, fields) {
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}=${iniValue(value)}`);
  }
  lines.push('');
  return lines.join('\n');
}

const metadata = {
  kimi: {
    vendor: 'Moonshot Kimi', base_url: 'https://api.moonshot.cn/v1', protocol: 'chat', model: 'moonshot-v1-8k',
    config_url: 'https://platform.moonshot.cn/console/api-keys', docs_url: 'https://platform.moonshot.cn/docs/intro',
    source: 'api.txt (existing)', status: 'verified', enabled: true,
  },
  qwen: {
    vendor: 'Alibaba Cloud Model Studio / DashScope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat', model: 'qwen-plus',
    config_url: 'https://bailian.console.aliyun.com/?tab=model#/api-key', docs_url: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope',
    source: 'api.txt (existing)', status: 'verified', enabled: true,
  },
  freellm: {
    vendor: 'FreeLLMAPI (local aggregator)', protocol: 'chat', model: 'auto',
    config_url: 'http://127.0.0.1:18080/', docs_url: 'http://127.0.0.1:18080/v1/models',
    source: 'FreeLLMAPI unified key + local DB catalog', status: 'verified_local', enabled: true,
  },
  agnes: {
    vendor: 'Agnes AI', base_url: 'https://apihub.agnes-ai.com/v1', protocol: 'chat', model: 'agnes-2.0-flash',
    config_url: 'https://apihub.agnes-ai.com/', docs_url: 'https://apihub.agnes-ai.com/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  github: {
    vendor: 'GitHub Models', base_url: 'https://models.github.ai/inference', protocol: 'chat', model: 'openai/gpt-4.1',
    config_url: 'https://github.com/settings/tokens', docs_url: 'https://docs.github.com/en/github-models', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'retired_410', enabled: false,
  },
  kilo: {
    vendor: 'Kilo Gateway', base_url: 'https://api.kilo.ai/api/gateway/v1', protocol: 'chat', model: 'kilo-auto/free',
    config_url: 'https://app.kilo.ai/', docs_url: 'https://docs.kilo.ai/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified_no_key', enabled: true,
  },
  llm7: {
    vendor: 'LLM7', base_url: 'https://api.llm7.io/v1', protocol: 'chat', model: 'codestral-latest',
    config_url: 'https://llm7.io/', docs_url: 'https://llm7.io/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  nvidia: {
    vendor: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', protocol: 'chat', model: 'openai/gpt-oss-20b',
    config_url: 'https://build.nvidia.com/', docs_url: 'https://docs.api.nvidia.com/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  ollama: {
    vendor: 'Ollama Cloud', base_url: 'https://ollama.com/v1', protocol: 'chat', model: 'gemma4:31b',
    config_url: 'https://ollama.com/settings/keys', docs_url: 'https://docs.ollama.com/api', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  opencode: {
    vendor: 'OpenCode Zen', base_url: 'https://opencode.ai/zen/v1', protocol: 'chat', model: 'big-pickle',
    config_url: 'https://opencode.ai/', docs_url: 'https://opencode.ai/docs/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  openrouter: {
    vendor: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', protocol: 'chat', model: 'nvidia/nemotron-3.5-lightning:free',
    config_url: 'https://openrouter.ai/keys', docs_url: 'https://openrouter.ai/docs/api-reference/overview', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  pollinations: {
    vendor: 'Pollinations', base_url: 'https://text.pollinations.ai/openai/v1', protocol: 'chat', model: 'openai',
    config_url: 'https://pollinations.ai/', docs_url: 'https://text.pollinations.ai/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'payment_required_402', enabled: false,
  },
  reka: {
    vendor: 'Reka', base_url: 'https://api.reka.ai/v1', protocol: 'chat', model: 'reka-flash',
    config_url: 'https://platform.reka.ai/', docs_url: 'https://docs.reka.ai/', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
  zhipu: {
    vendor: 'Zhipu / BigModel', base_url: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat', model: 'glm-4.5-flash',
    config_url: 'https://open.bigmodel.cn/usercenter/apikeys', docs_url: 'https://open.bigmodel.cn/dev/api', source: 'FreeLLMAPI encrypted DB (authorized export)', status: 'verified', enabled: true,
  },
};

const legacy = legacyKeys(fs.readFileSync(API_FILE, 'utf8'));
const db = dbSnapshot();
const decrypted = new Map();
for (const row of db.rows) decrypted.set(row.platform, decrypt(row, db.settings.encryption_key));
const unifiedKey = process.env.FREELLMAPI_API_KEY || db.settings.unified_api_key || '';
if (!unifiedKey) throw new Error('FreeLLMAPI unified key not found');

const aliases = {
  kimi: legacy.kimi || process.env.KIMI_API_KEY,
  qwen: legacy['aliyun bailian'] || legacy.qwen || process.env.QWEN_API_KEY,
};
for (const [name, key] of Object.entries(aliases)) {
  if (!key) throw new Error(`missing ${name} key in api.txt/environment`);
}

let output = [
  '# API provider inventory for AnyDoor (api relay gateway)',
  `# Generated: ${checkedAt}`,
  '# WARNING: this file contains plaintext credentials. Keep it outside public/static directories, restrict permissions, and rotate keys that have been exposed.',
  '# The gateway reads this file only on the server. Never return api_key fields to clients.',
  '',
].join('\n');

for (const name of ['kimi', 'qwen']) {
  output += section(`provider.${name}`, { ...metadata[name], api_key: aliases[name] });
}
output += section('provider.freellm', {
  ...metadata.freellm,
  base_url: process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:18080/v1',
  api_key: unifiedKey,
  catalog_count: Object.values(db.model_counts).reduce((sum, count) => sum + Number(count || 0), 0),
  catalog_vendors: Object.keys(db.model_counts).sort().join(','),
});

for (const name of Object.keys(metadata).filter((key) => !['kimi', 'qwen', 'freellm'].includes(key))) {
  const key = decrypted.get(name);
  if (!key) continue;
  output += section(`provider.${name}`, {
    ...metadata[name],
    ...(key === 'no-key' ? {} : { api_key: key }),
    auth: key === 'no-key' ? 'none' : 'bearer',
  });
}

output += section('gateway', {
  api_config_file: './api.txt',
  default_provider: 'kimi',
  protocol: 'OpenAI-compatible chat completions',
  last_checked: checkedAt,
});
output += section('security', {
  plaintext: 'true',
  rotate_before_public_launch: 'true',
  codex_login_accounts: 'not exported; do not use passwords, cookies, or session tokens as API credentials',
});

fs.writeFileSync(API_FILE, output, { encoding: 'utf8', mode: 0o600 });
try { fs.chmodSync(API_FILE, 0o600); } catch { /* Windows may not expose POSIX modes. */ }

const summary = Object.entries(metadata).map(([name, item]) => ({
  provider: name,
  status: item.status,
  enabled: item.enabled,
  key_length: name === 'freellm' ? unifiedKey.length : (aliases[name]?.length || decrypted.get(name)?.length || 0),
}));
console.log(JSON.stringify({ file: API_FILE, providers: summary, catalog_count: Object.values(db.model_counts).reduce((sum, count) => sum + Number(count || 0), 0) }));
