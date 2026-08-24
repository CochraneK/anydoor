// Dev tool: probe every provider in api.txt for live availability,
// fetch OpenRouter key quota, and list DashScope (bailian) models.
// Reads credentials from api.txt at runtime; prints no secrets.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2] || resolve(process.cwd(), 'cloudbase/anydoorApi/api.txt');
const text = readFileSync(file, 'utf8');

function parseProviders(src) {
  const out = {};
  let cur = null;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[provider\.([A-Za-z0-9_-]+)\]$/);
    if (sec) { cur = out[sec[1]] = {}; continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    cur[key] = value;
  }
  return out;
}

async function probeChat(name, p) {
  const base = (p.base_url || '').replace(/\/$/, '');
  const headers = { 'content-type': 'application/json' };
  const auth = String(p.auth || 'bearer').toLowerCase();
  if (p.api_key && auth !== 'none') headers.authorization = `Bearer ${p.api_key}`;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: p.model || '', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body = await res.text().catch(() => '');
    let note = '';
    if (!res.ok) {
      try { note = String(JSON.parse(body)?.error?.message || '').slice(0, 180); } catch { note = body.slice(0, 140); }
    }
    return { ok: res.ok, http: res.status, ms: Date.now() - t0, note };
  } catch (error) {
    return { ok: false, http: 0, ms: Date.now() - t0, note: String(error?.cause?.code || error?.message || error).slice(0, 180) };
  }
}

async function openrouterQuota(p) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { authorization: `Bearer ${p.api_key}` } });
    if (!res.ok) return { known: false, note: `http_${res.status}` };
    const data = (await res.json()).data || {};
    const usage = Number(data.total_usage) || 0;
    const limit = typeof data.limit === 'number' ? data.limit : null;
    return { known: true, total_usage: usage, limit, remaining: limit === null ? null : Number(Math.max(0, limit - usage).toFixed(4)), free_tier: Boolean(data.is_free_tier) };
  } catch (error) {
    return { known: false, note: String(error?.message || error).slice(0, 100) };
  }
}

async function dashscopeModels(p) {
  try {
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/models', { headers: { authorization: `Bearer ${p.api_key}` } });
    const body = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, http: res.status, note: body.slice(0, 140) };
    const data = JSON.parse(body);
    const ids = (data.data || []).map((m) => m.id).sort();
    return { ok: true, http: res.status, count: ids.length, ids };
  } catch (error) {
    return { ok: false, note: String(error?.message || error).slice(0, 140) };
  }
}

const providers = parseProviders(text);
const names = Object.keys(providers);
console.log(`probing ${names.length} providers from ${file}`);

const results = await Promise.all(names.map(async (name) => {
  const p = providers[name];
  const enabled = String(p.enabled || 'true') !== 'false';
  const row = { name, vendor: p.vendor || '', model: p.model || '', enabled, previous: p.status || '' };
  if (!enabled) { row.skip = true; row.result = { ok: false, note: 'disabled' }; return row; }
  if (!p.base_url) { row.skip = true; row.result = { ok: false, note: 'no base_url' }; return row; }
  row.result = await probeChat(name, p);
  return row;
}));

for (const row of results) {
  const r = row.result;
  console.log(`${row.name.padEnd(12)} ${String(r.ok ? 'OK' : 'FAIL').padEnd(4)} http=${String(r.http || '-').padEnd(4)} ${(r.ms + 'ms').padEnd(8)} model=${row.model.padEnd(34)} prev=${row.previous}${r.note ? ' | ' + r.note : ''}`);
}

console.log('\n--- openrouter quota ---');
for (const name of names.filter((n) => (providers[n].base_url || '').includes('openrouter.ai'))) {
  const q = await openrouterQuota(providers[name]);
  console.log(`${name}: ${JSON.stringify(q)}`);
}

console.log('\n--- dashscope (bailian) models via qwen key ---');
const qwenModels = await dashscopeModels(providers.qwen || {});
if (qwenModels.ok) console.log(`count=${qwenModels.count}\n${qwenModels.ids.join('\n')}`);
else console.log(JSON.stringify(qwenModels));

console.log('\n--- dashscope (bailian) models via alibaba key ---');
const alibabaModels = await dashscopeModels(providers.alibaba || {});
console.log(alibabaModels.ok ? `count=${alibabaModels.count}` : JSON.stringify(alibabaModels));

console.log('\nPROBE DONE');
