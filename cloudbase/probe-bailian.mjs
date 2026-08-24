// Dev tool: verify which top bailian (DashScope) models are actually callable
// with the qwen key, and list opencode zen models. Prints no secrets.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2] || resolve(process.cwd(), 'cloudbase/anydoorApi/api.txt');
const text = readFileSync(file, 'utf8');
function get(section, key) {
  const sec = text.match(new RegExp('\\[provider\\.' + section + '\\]([\\s\\S]*?)(?=\\n\\[|$)'));
  if (!sec) return '';
  const m = sec[1].match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
}

const qwenKey = get('qwen', 'api_key');
const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const candidates = process.argv[3] ? process.argv.slice(3) : [
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.6-flash',
  'qwen3.5-plus',
  'qwen3.5-flash',
  'qwen3-max',
  'qwen-max',
  'qwen-plus',
  'qwen-flash',
  'qwen-turbo',
  'kimi-k3',
  'kimi-k2.7-code',
  'deepseek-v4-pro',
  'deepseek-v3.2',
  'ZHIPU/GLM-5.3',
  'glm-5.2',
  'MiniMax/MiniMax-M3',
  'MiniMax/MiniMax-M2.7',
  'xiaomi/mimo-v2.5-pro',
];

async function ping(key, url, model) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 2 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    let note = '';
    if (!res.ok) { try { note = String(JSON.parse(body)?.error?.message || '').slice(0, 160); } catch { note = body.slice(0, 120); } }
    return { ok: res.ok, http: res.status, ms: Date.now() - t0, note };
  } catch (error) {
    return { ok: false, http: 0, ms: Date.now() - t0, note: String(error?.message || error).slice(0, 120) };
  }
}

console.log('--- bailian candidates (qwen key) ---');
for (const model of candidates) {
  const r = await ping(qwenKey, base, model);
  console.log(`${String(r.ok ? 'OK  ' : 'FAIL')} ${model.padEnd(24)} http=${String(r.http || '-').padEnd(4)} ${r.ms}ms${r.note ? ' | ' + r.note : ''}`);
}

console.log('\n--- opencode zen /v1/models ---');
const ocKey = get('opencode', 'api_key');
try {
  const res = await fetch('https://opencode.ai/zen/v1/models', { headers: { authorization: `Bearer ${ocKey}` } });
  const body = await res.text();
  if (res.ok) {
    const ids = (JSON.parse(body).data || []).map((m) => m.id);
    console.log(ids.join('\n'));
  } else {
    console.log(`http=${res.status} ${body.slice(0, 200)}`);
  }
} catch (error) {
  console.log('error: ' + String(error?.message || error));
}
console.log('\nBAILIAN PROBE DONE');
