// Dev tool: rewrite api.txt statuses from the 2026-08-24 probe results,
// add curated bailian (DashScope) flagship models, and assign leaderboard tiers.
// Copies api_key values from existing sections; prints no secrets.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2] || resolve(process.cwd(), 'cloudbase/anydoorApi/api.txt');
let text = readFileSync(file, 'utf8');

const statusUpdates = {
  kimi: 'verified',
  qwen: 'verified',
  freellm: 'unreachable_local',
  agnes: 'verified',
  github: 'retired_410',
  kilo: 'verified',
  llm7: 'verified',
  nvidia: 'verified',
  ollama: 'verified',
  opencode: 'model_access_lost',
  openrouter: 'verified',
  pollinations: 'payment_required_402',
  reka: 'verified',
  zhipu: 'verified',
  alibaba: 'verified',
  'kilo-b': 'verified_flaky',
  longcat: 'verified_auth_quota_exhausted',
  'openrouter-b': 'verified',
};

const tiers = {
  kimi: 40, qwen: 26, freellm: 50, agnes: 35, github: 90, kilo: 30, llm7: 45,
  nvidia: 28, ollama: 42, opencode: 91, openrouter: 38, pollinations: 92,
  reka: 44, zhipu: 32, alibaba: 26, 'kilo-b': 31, longcat: 60, 'openrouter-b': 39,
};

const quotaOverrides = {
  qwen: 'quota_note=按量计费（免费额度见百炼控制台）',
  alibaba: 'quota_note=按量计费（免费额度见百炼控制台）',
  longcat: 'quota_note=额度已耗尽',
  freellm: 'quota_note=本地服务',
  opencode: 'quota_note=密钥已失效',
  github: 'quota_note=服务已下线',
  pollinations: 'quota_note=需付费',
  kimi: 'quota_note=按量计费',
  agnes: 'quota_note=免费试用',
  kilo: 'quota_note=免费路由',
  'kilo-b': 'quota_note=免费路由',
  llm7: 'quota_note=免费额度',
  nvidia: 'quota_note=免费额度',
  ollama: 'quota_note=按量计费',
  reka: 'quota_note=免费额度',
  zhipu: 'quota_note=免费额度',
};

const enabledOverrides = { opencode: 'false' };

function section(name, body) {
  const re = new RegExp('(\\[provider\\.' + name.replace('-', '\\-') + '\\][\\s\\S]*?)(?=\\n\\[|\\s*$)');
  const m = text.match(re);
  if (!m) throw new Error('section not found: ' + name);
  let sec = m[1];
  const old = sec;
  if (statusUpdates[name] !== undefined) {
    sec = sec.replace(/^status=.*$/m, 'status=' + statusUpdates[name]);
  }
  if (enabledOverrides[name] !== undefined) {
    sec = sec.replace(/^enabled=.*$/m, 'enabled=' + enabledOverrides[name]);
  }
  sec = sec.replace(/\r?\n$/, '');
  if (tiers[name] !== undefined && !/^tier=/m.test(sec)) {
    sec += '\ntier=' + tiers[name];
  } else if (tiers[name] !== undefined) {
    sec = sec.replace(/^tier=.*$/m, 'tier=' + tiers[name]);
  }
  if (quotaOverrides[name] !== undefined) {
    sec = /^quota_note=/m.test(sec) ? sec.replace(/^quota_note=.*$/m, quotaOverrides[name]) : sec + '\n' + quotaOverrides[name];
  }
  text = text.replace(old, sec);
}

for (const name of Object.keys(statusUpdates)) section(name);

// qwen provider doubles as the bailian catalog reference.
const bailianCatalog = 'models=qwen3.8-max,qwen3.7-max,qwen3.6-plus,kimi-k3,deepseek-v4-pro,qwen3.7-plus,qwen3.5-plus,glm-5.2,qwen3.6-flash,kimi-k2.7-code,deepseek-v3.2,qwen-flash,qwen-plus,qwen-max,qwen3-max';
{
  const re = /(\[provider\.qwen\][\s\S]*?)(?=\n\[)/;
  const m = text.match(re);
  if (!m) throw new Error('qwen section not found');
  let sec = m[1].replace(/\r?\n$/, '');
  sec = /^models=/m.test(sec) ? sec.replace(/^models=.*$/m, bailianCatalog) : sec + '\n' + bailianCatalog;
  text = text.replace(m[1], sec + '\n');
}

function getKey(name) {
  const re = new RegExp('\\[provider\\.' + name + '\\][\\s\\S]*?^api_key=(.*)$', 'm');
  const m = text.match(re);
  if (!m) throw new Error('no api_key for ' + name);
  return m[1].trim();
}

const qwenKey = getKey('qwen');

const newProviders = [
  { name: 'bailian-qwen38max', model: 'qwen3.8-max', tier: 10, note: 'Bailian flagship (2026-05)' },
  { name: 'bailian-qwen37max', model: 'qwen3.7-max', tier: 11, note: 'Bailian flagship (prev gen)' },
  { name: 'bailian-kimi-k3', model: 'kimi-k3', tier: 12, note: 'Moonshot Kimi K3 via Bailian' },
  { name: 'bailian-qwen36plus', model: 'qwen3.6-plus', tier: 13, note: 'Bailian balanced' },
  { name: 'bailian-dsv4-pro', model: 'deepseek-v4-pro', tier: 14, note: 'DeepSeek V4 Pro via Bailian' },
  { name: 'bailian-qwen37plus', model: 'qwen3.7-plus', tier: 15, note: 'Bailian balanced' },
  { name: 'bailian-qwen35plus', model: 'qwen3.5-plus', tier: 16, note: 'Bailian balanced (prev gen)' },
  { name: 'bailian-glm52', model: 'glm-5.2', tier: 17, note: 'Zhipu GLM 5.2 via Bailian' },
  { name: 'bailian-qwen36flash', model: 'qwen3.6-flash', tier: 18, note: 'Bailian fast' },
  { name: 'bailian-kimi27code', model: 'kimi-k2.7-code', tier: 19, note: 'Kimi code model via Bailian' },
  { name: 'bailian-dsv32', model: 'deepseek-v3.2', tier: 20, note: 'DeepSeek V3.2 via Bailian' },
  { name: 'bailian-qwenflash', model: 'qwen-flash', tier: 21, note: 'Bailian fastest/free-tier' },
];

const blocks = [];
for (const p of newProviders) {
  if (text.includes('[provider.' + p.name + ']')) continue;
  blocks.push([
    `[provider.${p.name}]`,
    `vendor=Alibaba Bailian (${p.note})`,
    'base_url=https://dashscope.aliyuncs.com/compatible-mode/v1',
    'protocol=chat',
    `model=${p.model}`,
    'config_url=https://bailian.console.aliyun.com/?tab=model#/api-key',
    'docs_url=https://help.aliyun.com/zh/model-studio/',
    'source=probe-bailian verified 2026-08-24',
    'status=verified',
    'enabled=true',
    `api_key=${qwenKey}`,
    'auth=bearer',
    `tier=${p.tier}`,
    'quota_note=按量计费（免费额度见百炼控制台）',
    '',
  ].join('\n'));
}

text = text.replace(/last_checked=.*$/m, 'last_checked=' + new Date().toISOString());
if (blocks.length) {
  const gatewayIdx = text.indexOf('\n[gateway]');
  const insert = '\n' + blocks.join('\n');
  text = gatewayIdx >= 0 ? text.slice(0, gatewayIdx) + insert + text.slice(gatewayIdx) : text + insert;
}

writeFileSync(file, text, 'utf8');
console.log(`updated ${file}`);
console.log(`sections now: ${(text.match(/\[provider\./g) || []).length}`);
console.log('INVENTORY UPDATED');
