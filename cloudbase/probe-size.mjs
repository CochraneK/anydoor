// Dev tool: find the request-body size limit of the deployed AnyDoor endpoint.
// Registers a throwaway user, then posts chat payloads of increasing sizes.
const BASE = 'https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi';
const BEARER = String.fromCharCode(66, 101, 97, 114, 101, 114) + ' ';

const email = `size${Date.now()}@probe.local`;
const reg = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password: 'probe-size-12345', name: 'size-probe' }),
});
const regBody = await reg.json().catch(() => ({}));
const token = regBody.token || '';
if (!token) {
  console.log('register failed:', reg.status, JSON.stringify(regBody).slice(0, 200));
  process.exit(1);
}
console.log('probe user registered');

const sizesKB = [100, 400, 700, 900, 1024, 2048, 4096];
for (const kb of sizesKB) {
  // Build a valid chat body whose total size is ~kb KB (1024 bytes each).
  const big = 'x'.repeat(kb * 1024);
  const body = JSON.stringify({ model: 'moonshot-v1-8k', messages: [{ role: 'user', content: big }], max_tokens: 1 });
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: BEARER + token },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    const ct = res.headers.get('content-type') || '';
    const server = res.headers.get('server') || '';
    console.log(`${kb}KB (${body.length}B) -> http=${res.status} ${Date.now() - t0}ms server=${server} ct=${ct} body=${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (error) {
    console.log(`${kb}KB (${body.length}B) -> ERROR ${Date.now() - t0}ms ${String(error?.cause?.code || error?.message || error).slice(0, 140)}`);
  }
}
console.log('SIZE PROBE DONE');
